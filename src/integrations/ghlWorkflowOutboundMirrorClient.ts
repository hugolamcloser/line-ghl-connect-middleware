import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import { forceRefreshGhlAuthContext, getGhlAuthContext, type GhlAuthContext } from "../services/ghlOAuthService";
import { buildMessageLogMetadata, buildShortLogRef, hasLogValue } from "../utils/logPrivacy";
import { redactSecrets, redactSensitiveText } from "../utils/redaction";

type GhlWorkflowOutboundMirrorPayload = {
  type: string;
  contactId: string;
  message: string;
  status: "delivered";
  conversationProviderId?: string;
};

type GhlWorkflowProviderPayload = {
  type: "Custom";
  contactId: string;
  status: "pending";
  conversationProviderId: string;
  message?: string;
  attachments?: string[];
};

export type GhlWorkflowOutboundMirrorInput = {
  requestId?: string;
  locationId: string;
  contactId: string;
  message: string;
  conversationProviderId?: string;
  workflowId?: string;
  lineMessageId?: string | null;
  existingGhlConversationId?: string | null;
};

export type GhlWorkflowProviderInput = {
  requestId?: string;
  locationId: string;
  contactId: string;
  conversationProviderId: string;
  message?: string;
  attachments?: string[];
  workflowId?: string;
  existingGhlConversationId?: string | null;
};

export type GhlWorkflowMessageStatus = "delivered" | "failed";

export type GhlWorkflowMessageStatusResult = {
  ok: boolean;
  statusCode?: number;
  authMode: GhlAuthContext["mode"] | "unknown";
  errorCategory?: "upstream_rejected" | "request_failed";
};

export type GhlWorkflowOutboundMirrorResult = {
  ok: boolean;
  endpoint: string;
  method: string;
  authMode: GhlAuthContext["mode"] | "unknown";
  statusCode?: number;
  canonicalCode?: string;
  message?: string;
  responseBody?: unknown;
  errorMessage?: string;
  requestBody: unknown;
  ghlMessageId?: string;
  ghlConversationId?: string;
};

const endpoint = "/conversations/messages";
const method = "POST";
const maxProviderAttachments = 5;

function buildProviderMessageLogContext(
  input: GhlWorkflowProviderInput
): Record<string, unknown> {
  const attachmentCount = input.attachments?.length ?? 0;

  return {
    requestId: input.requestId,
    selectedMessageType: attachmentCount > 0 ? "attachments" : "text",
    messagePresent: hasLogValue(input.message),
    messageLength: input.message?.length ?? 0,
    attachmentCount,
    locationIdPresent: hasLogValue(input.locationId),
    locationRef: buildShortLogRef(input.locationId),
    contactIdPresent: hasLogValue(input.contactId),
    contactRef: buildShortLogRef(input.contactId),
    workflowIdPresent: hasLogValue(input.workflowId),
    existingConversationIdPresent: hasLogValue(input.existingGhlConversationId),
    conversationProviderIdPresent: hasLogValue(input.conversationProviderId)
  };
}

function buildMirrorLogContext(input: GhlWorkflowOutboundMirrorInput): Record<string, unknown> {
  return {
    requestId: input.requestId,
    selectedMessageType: "text",
    ...buildMessageLogMetadata(input.message),
    locationIdPresent: hasLogValue(input.locationId),
    locationRef: buildShortLogRef(input.locationId),
    contactIdPresent: hasLogValue(input.contactId),
    contactRef: buildShortLogRef(input.contactId),
    workflowIdPresent: hasLogValue(input.workflowId),
    lineMessageIdPresent: hasLogValue(input.lineMessageId),
    existingConversationIdPresent: hasLogValue(input.existingGhlConversationId),
    conversationProviderIdPresent: hasLogValue(input.conversationProviderId)
  };
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNestedString(payload: unknown, ...path: string[]): string | undefined {
  let current = payload;

  for (const key of path) {
    const record = getRecord(current);

    if (!record || !(key in record)) {
      return undefined;
    }

    current = record[key];
  }

  return getString(current);
}

function getFirstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    const stringValue = getString(item);

    if (stringValue) {
      return stringValue;
    }
  }

  return undefined;
}

function getNestedFirstString(payload: unknown, ...path: string[]): string | undefined {
  let current = payload;

  for (const key of path) {
    const record = getRecord(current);

    if (!record || !(key in record)) {
      return undefined;
    }

    current = record[key];
  }

  return getFirstString(current);
}

function parseResponseBody(responseText: string): unknown {
  if (!responseText) {
    return undefined;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

function getGhlErrorDetails(responseBody: unknown): { canonicalCode?: string; message?: string } {
  return {
    canonicalCode:
      getNestedString(responseBody, "canonicalCode") ??
      getNestedString(responseBody, "error", "canonicalCode") ??
      getNestedString(responseBody, "meta", "canonicalCode"),
    message:
      getNestedString(responseBody, "message") ??
      getNestedString(responseBody, "error", "message") ??
      getNestedString(responseBody, "msg")
  };
}

function extractGhlMessageIds(responseBody: unknown): { messageId?: string; conversationId?: string } {
  return {
    messageId:
      getNestedString(responseBody, "messageId") ??
      getNestedString(responseBody, "id") ??
      getNestedString(responseBody, "_id") ??
      getNestedString(responseBody, "message", "id") ??
      getNestedString(responseBody, "message", "_id") ??
      getNestedString(responseBody, "data", "messageId") ??
      getNestedString(responseBody, "data", "id") ??
      getNestedFirstString(responseBody, "messageIds") ??
      getNestedFirstString(responseBody, "data", "messageIds"),
    conversationId:
      getNestedString(responseBody, "conversationId") ??
      getNestedString(responseBody, "conversation_id") ??
      getNestedString(responseBody, "conversation", "id") ??
      getNestedString(responseBody, "conversation", "_id") ??
      getNestedString(responseBody, "data", "conversationId") ??
      getNestedString(responseBody, "data", "conversation_id")
  };
}

function getConfiguredMirrorMessageType(): string {
  const configuredType = env.GHL_INBOUND_MESSAGE_TYPE.trim() || "Custom";
  const normalizedType = configuredType.toLowerCase();

  if (normalizedType === "sms") {
    return "SMS";
  }

  if (normalizedType === "email") {
    return "Email";
  }

  if (normalizedType === "custom") {
    return "Custom";
  }

  if (normalizedType === "call") {
    return "Call";
  }

  return configuredType;
}

function buildWorkflowOutboundMirrorPayload(input: GhlWorkflowOutboundMirrorInput): GhlWorkflowOutboundMirrorPayload {
  const conversationProviderId = input.conversationProviderId?.trim() ||
    requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID);

  return {
    type: getConfiguredMirrorMessageType(),
    contactId: input.contactId,
    message: input.message,
    status: "delivered",
    ...(input.conversationProviderId || env.GHL_SEND_CONVERSATION_PROVIDER_ID ? { conversationProviderId } : {})
  };
}

async function performGhlRequest(path: string, init: RequestInit, auth: GhlAuthContext): Promise<Response> {
  return fetch(`${env.GHL_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Version: requireEnvValue("GHL_API_VERSION", env.GHL_API_VERSION),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {})
    }
  });
}

async function readGhlResponse(response: Response): Promise<{
  responseText: string;
  responseBody: unknown;
  canonicalCode?: string;
  message?: string;
  ghlMessageId?: string;
  ghlConversationId?: string;
}> {
  const responseText = redactSensitiveText(await response.text());
  const responseBody = redactSecrets(parseResponseBody(responseText));
  const { canonicalCode, message } = getGhlErrorDetails(responseBody);
  const ids = extractGhlMessageIds(responseBody);

  return {
    responseText,
    responseBody,
    canonicalCode,
    message,
    ghlMessageId: ids.messageId,
    ghlConversationId: ids.conversationId
  };
}

export async function mirrorWorkflowOutboundMessageToGhl(
  input: GhlWorkflowOutboundMirrorInput
): Promise<GhlWorkflowOutboundMirrorResult> {
  const payload = buildWorkflowOutboundMirrorPayload(input);
  const requestBody = redactSecrets(payload);

  logger.info(
    {
      endpoint,
      method,
      ...buildMirrorLogContext(input),
      providerDispatchStatus: "preparing"
    },
    "Preparing HighLevel workflow outbound mirror request"
  );

  try {
    let auth = await getGhlAuthContext(input.locationId, { allowPrivateFallback: false });
    let response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);

    if (response.status === 401 && auth.mode === "oauth") {
      logger.warn(
        {
          endpoint,
          method,
          authMode: auth.mode,
          ...buildMirrorLogContext(input),
          providerDispatchStatus: "retrying_auth",
          statusCode: response.status
        },
        "HighLevel workflow outbound mirror returned 401 with OAuth; refreshing token and retrying once"
      );

      auth = await forceRefreshGhlAuthContext(input.locationId);
      response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);
    }

    const parsed = await readGhlResponse(response);

    if (response.ok && !parsed.ghlMessageId) {
      logger.warn(
        {
          endpoint,
          method,
          authMode: auth.mode,
          ...buildMirrorLogContext(input),
          ghlConversationIdPresent: hasLogValue(parsed.ghlConversationId),
          ghlMessageIdPresent: false,
          mirrorStatus: "success",
          providerDispatchStatus: "success",
          statusCode: response.status,
          responseBodyPresent: parsed.responseBody !== undefined
        },
        "HighLevel workflow outbound mirror succeeded without a GHL message ID; duplicate-send guard cannot match provider echoes"
      );
    }

    logger.info(
      {
        endpoint,
        method,
        authMode: auth.mode,
        ...buildMirrorLogContext(input),
        ghlConversationIdPresent: hasLogValue(parsed.ghlConversationId),
        ghlMessageIdPresent: hasLogValue(parsed.ghlMessageId),
        mirrorStatus: response.ok ? "success" : "failed",
        providerDispatchStatus: response.ok ? "success" : "failed",
        statusCode: response.status,
        canonicalCode: parsed.canonicalCode,
        responseBodyPresent: parsed.responseBody !== undefined
      },
      "HighLevel workflow outbound mirror request completed"
    );

    return {
      ok: response.ok,
      endpoint,
      method,
      authMode: auth.mode,
      statusCode: response.status,
      canonicalCode: parsed.canonicalCode,
      message: parsed.message,
      responseBody: parsed.responseBody,
      errorMessage: response.ok
        ? undefined
        : `HighLevel API ${response.status} ${response.statusText}: ${parsed.responseText}`,
      requestBody,
      ghlMessageId: parsed.ghlMessageId,
      ghlConversationId: parsed.ghlConversationId
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(
      {
        endpoint,
        method,
        ...buildMirrorLogContext(input),
        mirrorStatus: "failed",
        providerDispatchStatus: "failed_before_response",
        errorPresent: true,
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "HighLevel workflow outbound mirror failed before receiving an API response"
    );

    return {
      ok: false,
      endpoint,
      method,
      authMode: "unknown",
      errorMessage,
      requestBody
    };
  }
}

export async function createWorkflowProviderMessage(
  input: GhlWorkflowProviderInput
): Promise<GhlWorkflowOutboundMirrorResult> {
  const messagePresent = typeof input.message === "string" && input.message.trim().length > 0;
  const attachments = input.attachments ?? [];

  if (input.message !== undefined && !messagePresent) {
    throw new TypeError("HighLevel provider message must be non-empty when supplied");
  }

  if (attachments.length > maxProviderAttachments) {
    throw new TypeError(`HighLevel provider message supports at most ${maxProviderAttachments} attachments`);
  }

  if (attachments.some((attachment) => typeof attachment !== "string" || attachment.length === 0)) {
    throw new TypeError("HighLevel provider attachments must be non-empty strings");
  }

  if (!messagePresent && attachments.length === 0) {
    throw new TypeError("HighLevel provider message requires text or at least one attachment");
  }

  const payload: GhlWorkflowProviderPayload = {
    type: "Custom",
    contactId: input.contactId,
    status: "pending",
    conversationProviderId: input.conversationProviderId,
    ...(messagePresent ? { message: input.message } : {}),
    ...(attachments.length > 0 ? { attachments } : {})
  };
  const safeRequestBody = {
    type: payload.type,
    contactIdPresent: true,
    status: payload.status,
    conversationProviderIdPresent: true,
    messagePresent,
    attachmentCount: attachments.length
  };

  logger.info(
    {
      endpoint,
      method,
      ...buildProviderMessageLogContext(input),
      providerDispatchStatus: "preparing"
    },
    "Preparing HighLevel provider message dispatch"
  );

  try {
    let auth = await getGhlAuthContext(input.locationId, { allowPrivateFallback: false });
    let response = await performGhlRequest(
      endpoint,
      { method, headers: { Version: "v3" }, body: JSON.stringify(payload) },
      auth
    );

    if (response.status === 401 && auth.mode === "oauth") {
      await response.body?.cancel().catch(() => undefined);
      auth = await forceRefreshGhlAuthContext(input.locationId);
      response = await performGhlRequest(
        endpoint,
        { method, headers: { Version: "v3" }, body: JSON.stringify(payload) },
        auth
      );
    }

    const parsed = await readGhlResponse(response);

    logger.info(
      {
        endpoint,
        method,
        authMode: auth.mode,
        ...buildProviderMessageLogContext(input),
        ghlConversationIdPresent: hasLogValue(parsed.ghlConversationId),
        ghlMessageIdPresent: hasLogValue(parsed.ghlMessageId),
        providerDispatchStatus: response.ok ? "success" : "failed",
        statusCode: response.status,
        canonicalCode: parsed.canonicalCode
      },
      "HighLevel provider message dispatch completed"
    );

    return {
      ok: response.ok,
      endpoint,
      method,
      authMode: auth.mode,
      statusCode: response.status,
      canonicalCode: parsed.canonicalCode,
      message: parsed.message,
      responseBody: {
        ghlMessageIdPresent: hasLogValue(parsed.ghlMessageId),
        ghlConversationIdPresent: hasLogValue(parsed.ghlConversationId)
      },
      errorMessage: response.ok
        ? undefined
        : `HighLevel provider message dispatch was rejected with status ${response.status}`,
      requestBody: safeRequestBody,
      ghlMessageId: parsed.ghlMessageId,
      ghlConversationId: parsed.ghlConversationId
    };
  } catch (error) {
    logger.error(
      {
        endpoint,
        method,
        ...buildProviderMessageLogContext(input),
        providerDispatchStatus: "failed_before_response",
        errorPresent: true,
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "HighLevel provider message dispatch failed before receiving a response"
    );

    return {
      ok: false,
      endpoint,
      method,
      authMode: "unknown",
      errorMessage: "HighLevel provider message dispatch failed before receiving a response",
      requestBody: safeRequestBody
    };
  }
}

export async function updateWorkflowProviderMessageStatus(input: {
  requestId?: string;
  locationId: string;
  messageId: string;
  status: GhlWorkflowMessageStatus;
}): Promise<GhlWorkflowMessageStatusResult> {
  const statusEndpoint = `${endpoint}/${encodeURIComponent(input.messageId)}/status`;

  try {
    let auth = await getGhlAuthContext(input.locationId, { allowPrivateFallback: false });
    let response = await performGhlRequest(
      statusEndpoint,
      {
        method: "PUT",
        headers: { Version: "v3" },
        body: JSON.stringify({ status: input.status })
      },
      auth
    );

    if (response.status === 401 && auth.mode === "oauth") {
      await response.body?.cancel().catch(() => undefined);
      auth = await forceRefreshGhlAuthContext(input.locationId);
      response = await performGhlRequest(
        statusEndpoint,
        {
          method: "PUT",
          headers: { Version: "v3" },
          body: JSON.stringify({ status: input.status })
        },
        auth
      );
    }

    await response.body?.cancel().catch(() => undefined);

    logger.info(
      {
        requestId: input.requestId,
        locationIdPresent: hasLogValue(input.locationId),
        locationRef: buildShortLogRef(input.locationId),
        ghlMessageIdPresent: true,
        requestedStatus: input.status,
        statusCode: response.status,
        statusUpdateStatus: response.ok ? "success" : "failed"
      },
      "HighLevel provider message status update completed"
    );

    return {
      ok: response.ok,
      statusCode: response.status,
      authMode: auth.mode,
      ...(response.ok ? {} : { errorCategory: "upstream_rejected" as const })
    };
  } catch (error) {
    logger.error(
      {
        requestId: input.requestId,
        locationIdPresent: hasLogValue(input.locationId),
        locationRef: buildShortLogRef(input.locationId),
        ghlMessageIdPresent: true,
        requestedStatus: input.status,
        statusUpdateStatus: "failed_before_response",
        errorPresent: true,
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "HighLevel provider message status update failed before receiving a response"
    );

    return { ok: false, authMode: "unknown", errorCategory: "request_failed" };
  }
}
