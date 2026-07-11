import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import { forceRefreshGhlAuthContext, getGhlAuthContext, type GhlAuthContext } from "../services/ghlOAuthService";
import type { GhlInboundMessageInput, GhlInboundMessageResponse } from "../types/ghl";
import { redactSecrets, redactSensitiveText } from "../utils/redaction";
import { GhlApiError } from "./ghlClient";
import { getConfiguredLocationApiAuthMode, getEffectiveInboundSendAuthMode } from "./ghlLocationClient";

type GhlInboundSendAuthMode = "oauth" | "private_integration";
type GhlResolvedAuthMode = GhlAuthContext["mode"];
type FailureClass = "A" | "B" | "C" | "D" | "E" | "F" | "payload_validation_reached" | "none" | "unknown";

type InboundMessagePayload = {
  locationId: string;
  contactId: string;
  conversationProviderId?: string;
  externalConversationId: string;
  externalMessageId: string;
  type: string;
  message: string;
  attachments?: string[];
};

type InboundSendDiagnostics = {
  tenantId?: string;
  contact_auth_mode_used: GhlInboundSendAuthMode;
  configured_inbound_send_auth_mode: GhlInboundSendAuthMode;
  inbound_send_auth_mode_used: GhlResolvedAuthMode;
  configured_auth_mode: GhlInboundSendAuthMode;
  required_auth_mode: "oauth";
  actual_auth_mode_used: GhlResolvedAuthMode;
  configured_auth_mode_ignored: boolean;
  used_private_integration_token_for_contact: boolean;
  used_private_integration_token_for_inbound_send: boolean;
  used_oauth_token_for_inbound_send: boolean;
  used_private_integration_token: boolean;
  used_oauth_token: boolean;
  token_source_selected_for_inbound_send: "stored_oauth_access_token" | "private_integration_token";
  contact_step: "send_message";
  endpoint: string;
  method: string;
  ghlProviderId: string;
  providerId: string;
  send_conversation_provider_id: boolean;
  provider_id_will_be_sent: boolean;
  locationId: string;
  contactId: string;
  inbound_message_type: string;
  statusCode?: number;
  canonicalCode?: string;
  short_ghl_error_message?: string;
  ghl_response_body?: unknown;
  request_body: unknown;
};

type InboundRequestResult = {
  ok: boolean;
  statusCode: number;
  statusText: string;
  responseText: string;
  responseBody: unknown;
  canonicalCode?: string;
  message?: string;
  authMode: GhlResolvedAuthMode;
  configuredAuthMode: GhlInboundSendAuthMode;
  diagnostics: InboundSendDiagnostics;
};

export type GhlInboundMessageSendResult = {
  response: GhlInboundMessageResponse;
  diagnostics: InboundSendDiagnostics;
};

class GhlInboundSendAuthModeError extends Error {
  public readonly requestPayload: unknown;
  public readonly path: string;
  public readonly method: string;
  public readonly authMode: string;

  constructor(input: { message: string; requestPayload: unknown; path: string; method: string; authMode: string }) {
    super(input.message);
    this.name = "GhlInboundSendAuthModeError";
    this.requestPayload = input.requestPayload;
    this.path = input.path;
    this.method = input.method;
    this.authMode = input.authMode;
  }
}

const providerNoAccessCanonicalCode = "CONVERSATIONS_MSG_PROVIDER_NO_ACCESS";
const requiredInboundSendAuthMode = "oauth" satisfies GhlInboundSendAuthMode;
let privateInboundSendAuthWarningLogged = false;

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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

function getShortSanitizedGhlErrorMessage(message: string | undefined, responseText: string): string | undefined {
  const source = message ?? responseText;

  if (!source.trim()) {
    return undefined;
  }

  const normalized = redactSensitiveText(source).replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function extractGhlInboundMessageIds(responseBody: unknown): { messageId?: string; conversationId?: string } {
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

function idsEqual(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left?.trim() && right?.trim() && left.trim() === right.trim());
}

function getProviderIdEqualsOAuthClientId(): boolean {
  return idsEqual(env.GHL_CUSTOM_PROVIDER_ID, env.GHL_OAUTH_CLIENT_ID);
}

function getConfiguredConversationProviderId(): string {
  return requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID);
}

function shouldSendConversationProviderId(): boolean {
  return env.GHL_SEND_CONVERSATION_PROVIDER_ID;
}

function getConfiguredInboundMessageType(): string {
  const configuredType = env.GHL_INBOUND_MESSAGE_TYPE.trim() || "SMS";
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

function getConfiguredInboundSendAuthMode(): GhlInboundSendAuthMode {
  return env.GHL_INBOUND_SEND_AUTH_MODE;
}

function getInboundSendTokenSource(authMode: GhlInboundSendAuthMode | GhlResolvedAuthMode): "stored_oauth_access_token" | "private_integration_token" {
  return authMode === "private_integration" ? "private_integration_token" : "stored_oauth_access_token";
}

async function getInboundSendAuthContext(locationId: string): Promise<GhlAuthContext> {
  return getGhlAuthContext(locationId, { allowPrivateFallback: false });
}

function warnIfPrivateInboundSendAuthConfigured(input: {
  configuredAuthMode: GhlInboundSendAuthMode;
  locationId: string;
  tenantId?: string;
  providerId: string;
  path: string;
  method: string;
}): void {
  if (input.configuredAuthMode !== "private_integration" || privateInboundSendAuthWarningLogged) {
    return;
  }

  privateInboundSendAuthWarningLogged = true;
  logger.warn(
    {
      method: input.method,
      path: input.path,
      tenantId: input.tenantId,
      locationId: input.locationId,
      ghlProviderId: input.providerId,
      configuredAuthMode: input.configuredAuthMode,
      requiredAuthMode: requiredInboundSendAuthMode,
      authModeUsed: requiredInboundSendAuthMode,
      tokenSourceSelectedForInboundSend: "stored_oauth_access_token"
    },
    "Ignoring private integration auth for HighLevel inbound conversation message endpoint; using stored location OAuth token"
  );
}

function buildInboundMessagePayload(input: GhlInboundMessageInput): InboundMessagePayload {
  const locationId = input.locationId?.trim() || requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = input.conversationProviderId?.trim() || getConfiguredConversationProviderId();
  const attachments = (input.attachments ?? []).filter((attachment) => attachment.trim().length > 0);

  return {
    locationId,
    contactId: input.contactId,
    ...(shouldSendConversationProviderId() ? { conversationProviderId } : {}),
    externalConversationId: input.externalConversationId,
    externalMessageId: input.externalMessageId,
    type: getConfiguredInboundMessageType(),
    message: input.message,
    ...(attachments.length > 0 ? { attachments } : {})
  };
}

function buildProviderProbePayload(conversationProviderId: string, locationId: string): InboundMessagePayload {
  return {
    locationId,
    contactId: "debug-provider-access-test-contact",
    ...(shouldSendConversationProviderId() ? { conversationProviderId } : {}),
    externalConversationId: `debug-provider-test:${locationId}:${conversationProviderId}`,
    externalMessageId: `debug-provider-test:${Date.now()}`,
    type: getConfiguredInboundMessageType(),
    message: "Provider access probe. This should fail before creating a real message."
  };
}

export function getGhlInboundSendPayloadDebug(): {
  send_conversation_provider_id: boolean;
  provider_id_will_be_sent: boolean;
  request_body: unknown;
} {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = getConfiguredConversationProviderId();
  const payload = buildProviderProbePayload(conversationProviderId, locationId);

  return {
    send_conversation_provider_id: shouldSendConversationProviderId(),
    provider_id_will_be_sent: "conversationProviderId" in payload,
    request_body: redactSecrets(payload)
  };
}

function diagnoseInboundEndpointResponse(input: {
  ok: boolean;
  statusCode: number;
  canonicalCode?: string;
  message?: string;
  responseBody?: unknown;
}): { diagnosis: string; likelyFailureClass: FailureClass } {
  const message = input.message?.toLowerCase() ?? "";
  const bodyText =
    typeof input.responseBody === "string" ? input.responseBody.toLowerCase() : JSON.stringify(input.responseBody ?? {}).toLowerCase();

  if (input.ok) {
    return {
      likelyFailureClass: "none",
      diagnosis: "HighLevel accepted the inbound message request with the configured endpoint, auth mode, provider id, and payload."
    };
  }

  if (input.statusCode === 400) {
    return {
      likelyFailureClass: "payload_validation_reached",
      diagnosis:
        "HighLevel reached request validation. This usually means the endpoint and auth mode were accepted; inspect the response body for the payload/contact validation problem."
    };
  }

  if (input.statusCode === 401 && message.includes("authclass")) {
    return {
      likelyFailureClass: "B",
      diagnosis:
        "Likely B: wrong auth class, or the Marketplace Conversation Provider module is not permitted to call this inbound-message API."
    };
  }

  if (input.canonicalCode === providerNoAccessCanonicalCode) {
    return {
      likelyFailureClass: "C",
      diagnosis:
        "Likely C or D: the configured conversationProviderId is not accessible for this token/location, or the installed location provider binding is missing/stale."
    };
  }

  if (input.statusCode === 401 || input.statusCode === 403) {
    return {
      likelyFailureClass: "E",
      diagnosis:
        "Likely E: missing permission, missing scope, stale app install, token-location mismatch, or provider setup not connected to this token."
    };
  }

  if (input.statusCode === 404) {
    return {
      likelyFailureClass: "A",
      diagnosis: "Likely A or F: the endpoint path is wrong or unsupported for the current account/API version."
    };
  }

  if (bodyText.includes("conversationprovider") && bodyText.includes("access")) {
    return {
      likelyFailureClass: "D",
      diagnosis:
        "Likely D: HighLevel recognized the provider field but rejected access to the installed provider binding for this location."
    };
  }

  return {
    likelyFailureClass: "unknown",
    diagnosis:
      "HighLevel returned a response that does not cleanly map to endpoint, auth class, provider id, provider binding, module configuration, or unsupported-path failures."
  };
}

async function performGhlRequest(path: string, init: RequestInit | undefined, auth: GhlAuthContext): Promise<Response> {
  return fetch(`${env.GHL_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Version: requireEnvValue("GHL_API_VERSION", env.GHL_API_VERSION),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {})
    }
  });
}

function buildInboundSendDiagnostics(input: {
  configuredAuthMode: GhlInboundSendAuthMode;
  authMode: GhlResolvedAuthMode;
  path: string;
  method: string;
  payload: InboundMessagePayload;
  tenantId?: string;
  statusCode?: number;
  canonicalCode?: string;
  shortGhlErrorMessage?: string;
  responseBody?: unknown;
}): InboundSendDiagnostics {
  return {
    tenantId: input.tenantId,
    contact_auth_mode_used: getConfiguredLocationApiAuthMode(),
    configured_inbound_send_auth_mode: input.configuredAuthMode,
    inbound_send_auth_mode_used: input.authMode,
    configured_auth_mode: input.configuredAuthMode,
    required_auth_mode: requiredInboundSendAuthMode,
    actual_auth_mode_used: input.authMode,
    configured_auth_mode_ignored: input.configuredAuthMode !== requiredInboundSendAuthMode,
    used_private_integration_token_for_contact: getConfiguredLocationApiAuthMode() === "private_integration",
    used_private_integration_token_for_inbound_send: input.authMode === "private_integration",
    used_oauth_token_for_inbound_send: input.authMode === "oauth",
    used_private_integration_token: input.authMode === "private_integration",
    used_oauth_token: input.authMode === "oauth",
    token_source_selected_for_inbound_send: getInboundSendTokenSource(input.authMode),
    contact_step: "send_message",
    endpoint: input.path,
    method: input.method,
    ghlProviderId: input.payload.conversationProviderId ?? getConfiguredConversationProviderId(),
    providerId: input.payload.conversationProviderId ?? getConfiguredConversationProviderId(),
    send_conversation_provider_id: shouldSendConversationProviderId(),
    provider_id_will_be_sent: "conversationProviderId" in input.payload,
    locationId: input.payload.locationId,
    contactId: input.payload.contactId,
    inbound_message_type: input.payload.type,
    statusCode: input.statusCode,
    canonicalCode: input.canonicalCode,
    short_ghl_error_message: input.shortGhlErrorMessage,
    ghl_response_body: input.responseBody,
    request_body: redactSecrets(input.payload)
  };
}

function assertConfiguredInboundSendAuth(input: {
  configuredAuthMode: GhlInboundSendAuthMode;
  auth: GhlAuthContext;
  path: string;
  method: string;
  payload: InboundMessagePayload;
  tenantId?: string;
}): void {
  if (input.auth.mode !== requiredInboundSendAuthMode) {
    throw new GhlInboundSendAuthModeError({
      message: `Invalid real inbound send path auth: expected ${requiredInboundSendAuthMode} but selected ${input.auth.mode}`,
      path: input.path,
      method: input.method,
      authMode: input.auth.mode,
      requestPayload: buildInboundSendDiagnostics({
        configuredAuthMode: input.configuredAuthMode,
        authMode: input.auth.mode,
        path: input.path,
        method: input.method,
        payload: input.payload,
        tenantId: input.tenantId
      })
    });
  }
}

async function executeConfiguredInboundMessageRequest(input: {
  path: string;
  method: string;
  payload: InboundMessagePayload;
  tenantId?: string;
}): Promise<InboundRequestResult> {
  const configuredAuthMode = getConfiguredInboundSendAuthMode();
  const effectiveAuthMode = getEffectiveInboundSendAuthMode();
  warnIfPrivateInboundSendAuthConfigured({
    configuredAuthMode,
    locationId: input.payload.locationId,
    tenantId: input.tenantId,
    providerId: input.payload.conversationProviderId ?? getConfiguredConversationProviderId(),
    path: input.path,
    method: input.method
  });
  let auth = await getInboundSendAuthContext(input.payload.locationId);

  assertConfiguredInboundSendAuth({
    configuredAuthMode,
    auth,
    path: input.path,
    method: input.method,
    payload: input.payload,
    tenantId: input.tenantId
  });

  let response = await performGhlRequest(input.path, {
    method: input.method,
    body: JSON.stringify(input.payload)
  }, auth);

  if (response.status === 401 && auth.mode === "oauth") {
    logger.warn(
      {
        method: input.method,
        path: input.path,
        tenantId: input.tenantId,
        authMode: auth.mode,
        authModeUsed: auth.mode,
        configuredAuthMode,
        effectiveAuthMode,
        locationApiAuthMode: getConfiguredLocationApiAuthMode(),
        ghlProviderId: input.payload.conversationProviderId ?? getConfiguredConversationProviderId(),
        conversationProviderId: input.payload.conversationProviderId ?? getConfiguredConversationProviderId(),
        sendConversationProviderId: shouldSendConversationProviderId(),
        providerIdWillBeSent: "conversationProviderId" in input.payload,
        locationId: input.payload.locationId,
        contactId: input.payload.contactId,
        inboundMessageType: input.payload.type,
        statusCode: response.status
      },
      "HighLevel inbound message request returned 401 with OAuth; refreshing token and retrying once"
    );

    auth = await forceRefreshGhlAuthContext(input.payload.locationId);
    assertConfiguredInboundSendAuth({
      configuredAuthMode,
      auth,
      path: input.path,
      method: input.method,
      payload: input.payload,
      tenantId: input.tenantId
    });

    response = await performGhlRequest(input.path, {
      method: input.method,
      body: JSON.stringify(input.payload)
    }, auth);
  }

  const responseText = redactSensitiveText(await response.text());
  const responseBody = redactSecrets(parseResponseBody(responseText));
  const { canonicalCode, message } = getGhlErrorDetails(responseBody);
  const shortGhlErrorMessage = response.ok ? undefined : getShortSanitizedGhlErrorMessage(message, responseText);
  const diagnostics = buildInboundSendDiagnostics({
    configuredAuthMode,
    authMode: auth.mode,
    path: input.path,
    method: input.method,
    payload: input.payload,
    tenantId: input.tenantId,
    statusCode: response.status,
    canonicalCode,
    shortGhlErrorMessage,
    responseBody
  });

  return {
    ok: response.ok,
    statusCode: response.status,
    statusText: response.statusText,
    responseText,
    responseBody,
    canonicalCode,
    message,
    authMode: auth.mode,
    configuredAuthMode,
    diagnostics
  };
}

export async function sendInboundMessageToGhl(input: GhlInboundMessageInput): Promise<GhlInboundMessageSendResult> {
  const path = "/conversations/messages/inbound";
  const method = "POST";
  const payload = buildInboundMessagePayload(input);
  const tenantId = input.tenantId?.trim() || undefined;
  const configuredAuthMode = getConfiguredInboundSendAuthMode();
  const effectiveAuthMode = getEffectiveInboundSendAuthMode();

  logger.debug(
    {
      method,
      path,
      tenantId,
      configuredAuthMode,
      effectiveAuthMode,
      locationApiAuthMode: getConfiguredLocationApiAuthMode(),
      requiredAuthMode: requiredInboundSendAuthMode,
      authModeUsed: requiredInboundSendAuthMode,
      ghlProviderId: payload.conversationProviderId ?? getConfiguredConversationProviderId(),
      conversationProviderId: payload.conversationProviderId,
      configuredConversationProviderId: getConfiguredConversationProviderId(),
      sendConversationProviderId: shouldSendConversationProviderId(),
      providerIdWillBeSent: "conversationProviderId" in payload,
      providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
      locationId: payload.locationId,
      contactId: payload.contactId,
      inboundMessageType: payload.type,
      requestBody: redactSecrets(payload)
    },
    "Prepared HighLevel inbound conversation provider message request"
  );

  try {
    const result = await executeConfiguredInboundMessageRequest({ path, method, payload, tenantId });

    logger.debug(
      {
        method,
        path,
        tenantId,
        authMode: result.authMode,
        authModeUsed: result.authMode,
        configuredAuthMode: result.configuredAuthMode,
        effectiveAuthMode,
        locationApiAuthMode: getConfiguredLocationApiAuthMode(),
        requiredAuthMode: requiredInboundSendAuthMode,
        ghlProviderId: payload.conversationProviderId ?? getConfiguredConversationProviderId(),
        conversationProviderId: payload.conversationProviderId,
        configuredConversationProviderId: getConfiguredConversationProviderId(),
        sendConversationProviderId: shouldSendConversationProviderId(),
        providerIdWillBeSent: "conversationProviderId" in payload,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId: payload.locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        statusCode: result.statusCode,
        shortGhlErrorMessage: result.diagnostics.short_ghl_error_message,
        requestDiagnostics: result.diagnostics
      },
      "HighLevel inbound conversation provider message request completed"
    );

    if (!result.ok) {
      throw new GhlApiError({
        message: `HighLevel API ${result.statusCode} ${result.statusText}: ${result.responseText}`,
        statusCode: result.statusCode,
        responseBody: result.responseText,
        requestPayload: result.diagnostics,
        path,
        method,
        authMode: result.authMode,
        canonicalCode: result.canonicalCode
      });
    }

    const data = result.responseText ? (JSON.parse(result.responseText) as GhlInboundMessageResponse) : {};
    const ids = extractGhlInboundMessageIds(data);
    const normalizedResponse: GhlInboundMessageResponse = {
      ...data,
      ...(ids.messageId && !data.messageId ? { messageId: ids.messageId } : {}),
      ...(ids.conversationId && !data.conversationId ? { conversationId: ids.conversationId } : {})
    };

    logger.info(
      {
        method,
        path,
        tenantId,
        authMode: result.authMode,
        authModeUsed: result.authMode,
        configuredAuthMode: result.configuredAuthMode,
        requiredAuthMode: requiredInboundSendAuthMode,
        ghlProviderId: payload.conversationProviderId ?? getConfiguredConversationProviderId(),
        conversationProviderId: payload.conversationProviderId,
        configuredConversationProviderId: getConfiguredConversationProviderId(),
        sendConversationProviderId: shouldSendConversationProviderId(),
        providerIdWillBeSent: "conversationProviderId" in payload,
        locationId: payload.locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        statusCode: result.statusCode,
        canonicalCode: result.canonicalCode,
        ghlMessageId: normalizedResponse.messageId ?? normalizedResponse.id,
        ghlConversationId: normalizedResponse.conversationId,
        messageEventStatus: "success"
      },
      "HighLevel inbound conversation provider message accepted"
    );

    return {
      response: normalizedResponse,
      diagnostics: result.diagnostics
    };
  } catch (error) {
    if (error instanceof GhlApiError) {
      logger.error(
        {
          method,
          path,
          tenantId,
          authMode: error.authMode,
          authModeUsed: error.authMode,
          configuredAuthMode,
          effectiveAuthMode,
          locationApiAuthMode: getConfiguredLocationApiAuthMode(),
          requiredAuthMode: requiredInboundSendAuthMode,
          ghlProviderId: payload.conversationProviderId ?? getConfiguredConversationProviderId(),
          conversationProviderId: payload.conversationProviderId,
          configuredConversationProviderId: getConfiguredConversationProviderId(),
          sendConversationProviderId: shouldSendConversationProviderId(),
          providerIdWillBeSent: "conversationProviderId" in payload,
          providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
          locationId: payload.locationId,
          contactId: payload.contactId,
          inboundMessageType: payload.type,
          requestDiagnostics: error.requestPayload,
          statusCode: error.statusCode,
          canonicalCode: error.canonicalCode,
          shortGhlErrorMessage:
            error.requestPayload && typeof error.requestPayload === "object" && !Array.isArray(error.requestPayload)
              ? (error.requestPayload as Record<string, unknown>).short_ghl_error_message
              : undefined,
          responseBody: error.responseBody,
          messageEventStatus: "failed"
        },
        "HighLevel inbound conversation provider message failed"
      );
    } else if (error instanceof GhlInboundSendAuthModeError) {
      logger.error(
        {
          method,
          path,
          tenantId,
          authMode: error.authMode,
          authModeUsed: error.authMode,
          configuredAuthMode,
          effectiveAuthMode,
          locationApiAuthMode: getConfiguredLocationApiAuthMode(),
          requiredAuthMode: requiredInboundSendAuthMode,
          ghlProviderId: payload.conversationProviderId ?? getConfiguredConversationProviderId(),
          conversationProviderId: payload.conversationProviderId,
          configuredConversationProviderId: getConfiguredConversationProviderId(),
          sendConversationProviderId: shouldSendConversationProviderId(),
          providerIdWillBeSent: "conversationProviderId" in payload,
          providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
          locationId: payload.locationId,
          contactId: payload.contactId,
          inboundMessageType: payload.type,
          requestDiagnostics: error.requestPayload,
          error: error.message,
          messageEventStatus: "failed"
        },
        "HighLevel inbound conversation provider message auth-mode guard failed"
      );
    } else {
      logger.error(
        {
          method,
          path,
          tenantId,
          configuredAuthMode,
          effectiveAuthMode,
          locationApiAuthMode: getConfiguredLocationApiAuthMode(),
          requiredAuthMode: requiredInboundSendAuthMode,
          authModeUsed: requiredInboundSendAuthMode,
          ghlProviderId: payload.conversationProviderId ?? getConfiguredConversationProviderId(),
          conversationProviderId: payload.conversationProviderId,
          configuredConversationProviderId: getConfiguredConversationProviderId(),
          sendConversationProviderId: shouldSendConversationProviderId(),
          providerIdWillBeSent: "conversationProviderId" in payload,
          providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
          locationId: payload.locationId,
          contactId: payload.contactId,
          inboundMessageType: payload.type,
          requestBody: redactSecrets(payload),
          error: error instanceof Error ? error.message : String(error),
          messageEventStatus: "failed"
        },
        "HighLevel inbound conversation provider message failed before receiving an API response"
      );
    }

    throw error;
  }
}

export async function testConfiguredGhlInboundSendAuth(): Promise<{
  endpoint_path: string;
  method: string;
  auth_mode: string;
  configured_auth_mode: GhlInboundSendAuthMode;
  required_auth_mode: "oauth";
  configured_auth_mode_ignored: boolean;
  provider_id_used: string;
  send_conversation_provider_id: boolean;
  provider_id_will_be_sent: boolean;
  provider_id_equals_oauth_client_id: boolean;
  location_id: string;
  inbound_message_type: string;
  request_payload: unknown;
  request_body: unknown;
  statusCode?: number;
  canonicalCode?: string;
  message?: string;
  ghl_response_body?: unknown;
  diagnosis: string;
  likely_failure_class: FailureClass;
  error?: string;
  actual_auth_mode_used?: string;
  used_oauth_token_for_inbound_send: boolean;
  used_private_integration_token_for_inbound_send: boolean;
  token_source_selected_for_inbound_send: "stored_oauth_access_token" | "private_integration_token";
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = getConfiguredConversationProviderId();
  const endpoint = "/conversations/messages/inbound";
  const method = "POST";
  const configuredAuthMode = getConfiguredInboundSendAuthMode();
  const effectiveAuthMode = getEffectiveInboundSendAuthMode();
  const payload = buildProviderProbePayload(conversationProviderId, locationId);
  let authMode: string = effectiveAuthMode;

  logger.info(
    {
      method,
      endpoint,
      configuredAuthMode,
      effectiveAuthMode,
      requiredAuthMode: requiredInboundSendAuthMode,
      locationApiAuthMode: getConfiguredLocationApiAuthMode(),
      authModeUsed: requiredInboundSendAuthMode,
      conversationProviderId,
      ghlProviderId: conversationProviderId,
      sendConversationProviderId: shouldSendConversationProviderId(),
      providerIdWillBeSent: "conversationProviderId" in payload,
      providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
      locationId,
      contactId: payload.contactId,
      inboundMessageType: payload.type,
      requestBody: redactSecrets(payload),
      privateIntegrationTokenPresent: Boolean(env.GHL_PRIVATE_INTEGRATION_TOKEN.trim())
    },
    "Testing configured HighLevel inbound send auth mode"
  );

  try {
    const result = await executeConfiguredInboundMessageRequest({ path: endpoint, method, payload });
    authMode = result.authMode;
    const diagnosis = diagnoseInboundEndpointResponse({
      ok: result.ok,
      statusCode: result.statusCode,
      canonicalCode: result.canonicalCode,
      message: result.message,
      responseBody: result.responseBody
    });

    logger.info(
      {
        method,
        endpoint,
        authMode,
        authModeUsed: authMode,
        configuredAuthMode: result.configuredAuthMode,
        effectiveAuthMode,
        requiredAuthMode: requiredInboundSendAuthMode,
        locationApiAuthMode: getConfiguredLocationApiAuthMode(),
        conversationProviderId,
        ghlProviderId: conversationProviderId,
        sendConversationProviderId: shouldSendConversationProviderId(),
        providerIdWillBeSent: "conversationProviderId" in payload,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        requestDiagnostics: result.diagnostics,
        statusCode: result.statusCode,
        canonicalCode: result.canonicalCode,
        message: result.message,
        responseBody: result.responseBody,
        diagnosis
      },
      "Configured HighLevel inbound send auth test completed"
    );

    return {
      endpoint_path: endpoint,
      method,
      auth_mode: authMode,
      actual_auth_mode_used: result.diagnostics.actual_auth_mode_used,
      configured_auth_mode: configuredAuthMode,
      required_auth_mode: requiredInboundSendAuthMode,
      configured_auth_mode_ignored: configuredAuthMode !== requiredInboundSendAuthMode,
      used_oauth_token_for_inbound_send: result.diagnostics.used_oauth_token_for_inbound_send,
      used_private_integration_token_for_inbound_send: result.diagnostics.used_private_integration_token_for_inbound_send,
      token_source_selected_for_inbound_send: result.diagnostics.token_source_selected_for_inbound_send,
      provider_id_used: conversationProviderId,
      send_conversation_provider_id: shouldSendConversationProviderId(),
      provider_id_will_be_sent: result.diagnostics.provider_id_will_be_sent,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      location_id: locationId,
      inbound_message_type: payload.type,
      request_payload: result.diagnostics,
      request_body: result.diagnostics.request_body,
      statusCode: result.statusCode,
      canonicalCode: result.canonicalCode,
      message: result.message,
      ghl_response_body: result.responseBody,
      diagnosis: diagnosis.diagnosis,
      likely_failure_class: diagnosis.likelyFailureClass
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const requestPayload = error instanceof GhlInboundSendAuthModeError ? error.requestPayload : redactSecrets(payload);

    logger.error(
      {
        method,
        endpoint,
        authMode,
        authModeUsed: authMode,
        configuredAuthMode,
        effectiveAuthMode,
        requiredAuthMode: requiredInboundSendAuthMode,
        locationApiAuthMode: getConfiguredLocationApiAuthMode(),
        conversationProviderId,
        ghlProviderId: conversationProviderId,
        sendConversationProviderId: shouldSendConversationProviderId(),
        providerIdWillBeSent: "conversationProviderId" in payload,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        requestDiagnostics: requestPayload,
        error: errorMessage
      },
      "Configured HighLevel inbound send auth test failed before receiving a response"
    );

    return {
      endpoint_path: endpoint,
      method,
      auth_mode: authMode,
      actual_auth_mode_used: authMode,
      configured_auth_mode: configuredAuthMode,
      required_auth_mode: requiredInboundSendAuthMode,
      configured_auth_mode_ignored: configuredAuthMode !== requiredInboundSendAuthMode,
      used_oauth_token_for_inbound_send: authMode === "oauth",
      used_private_integration_token_for_inbound_send: authMode === "private_integration",
      token_source_selected_for_inbound_send: getInboundSendTokenSource(authMode as GhlInboundSendAuthMode),
      provider_id_used: conversationProviderId,
      send_conversation_provider_id: shouldSendConversationProviderId(),
      provider_id_will_be_sent:
        requestPayload && typeof requestPayload === "object" && !Array.isArray(requestPayload)
          ? Boolean((requestPayload as Record<string, unknown>).provider_id_will_be_sent)
          : "conversationProviderId" in payload,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      location_id: locationId,
      inbound_message_type: payload.type,
      request_payload: requestPayload,
      request_body:
        requestPayload && typeof requestPayload === "object" && !Array.isArray(requestPayload)
          ? ((requestPayload as Record<string, unknown>).request_body ?? redactSecrets(payload))
          : redactSecrets(payload),
      diagnosis:
        "The configured inbound send auth probe failed before receiving a HighLevel HTTP response. Check server logs for token lookup, private-token configuration, network, or provider settings.",
      likely_failure_class: "unknown",
      error: errorMessage
    };
  }
}
