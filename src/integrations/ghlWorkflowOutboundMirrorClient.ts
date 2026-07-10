import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import { forceRefreshGhlAuthContext, getGhlAuthContext, type GhlAuthContext } from "../services/ghlOAuthService";
import { redactSecrets, redactSensitiveText } from "../utils/redaction";

type GhlWorkflowOutboundMirrorPayload = {
  type: string;
  contactId: string;
  message: string;
  status: "delivered";
  conversationProviderId?: string;
};

export type GhlWorkflowOutboundMirrorInput = {
  locationId: string;
  contactId: string;
  message: string;
  workflowId?: string;
  lineMessageId?: string | null;
  existingGhlConversationId?: string | null;
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
      getNestedString(responseBody, "data", "id"),
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
  const conversationProviderId = requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID);

  return {
    type: getConfiguredMirrorMessageType(),
    contactId: input.contactId,
    message: input.message,
    status: "delivered",
    ...(env.GHL_SEND_CONVERSATION_PROVIDER_ID ? { conversationProviderId } : {})
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
      locationId: input.locationId,
      contactId: input.contactId,
      workflowId: input.workflowId,
      lineMessageId: input.lineMessageId,
      existingGhlConversationId: input.existingGhlConversationId,
      requestBody
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
          locationId: input.locationId,
          contactId: input.contactId,
          workflowId: input.workflowId,
          statusCode: response.status
        },
        "HighLevel workflow outbound mirror returned 401 with OAuth; refreshing token and retrying once"
      );

      auth = await forceRefreshGhlAuthContext(input.locationId);
      response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);
    }

    const parsed = await readGhlResponse(response);

    logger.info(
      {
        endpoint,
        method,
        authMode: auth.mode,
        locationId: input.locationId,
        contactId: input.contactId,
        workflowId: input.workflowId,
        lineMessageId: input.lineMessageId,
        existingGhlConversationId: input.existingGhlConversationId,
        ghlConversationId: parsed.ghlConversationId,
        ghlMessageId: parsed.ghlMessageId,
        mirrorStatus: response.ok ? "success" : "failed",
        statusCode: response.status,
        canonicalCode: parsed.canonicalCode,
        responseBody: parsed.responseBody
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
        locationId: input.locationId,
        contactId: input.contactId,
        workflowId: input.workflowId,
        lineMessageId: input.lineMessageId,
        existingGhlConversationId: input.existingGhlConversationId,
        mirrorStatus: "failed",
        errorMessage,
        requestBody
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
