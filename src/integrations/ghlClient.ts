import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import type {
  GhlContactResponse,
  GhlCreateContactInput,
  GhlInboundMessageInput,
  GhlInboundMessageResponse
} from "../types/ghl";
import { redactSecrets, redactSensitiveText } from "../utils/redaction";
import { forceRefreshGhlAuthContext, getGhlAuthContext, type GhlAuthContext } from "../services/ghlOAuthService";

export class GhlApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: string;
  public readonly requestPayload?: unknown;
  public readonly path: string;
  public readonly method: string;
  public readonly authMode: string;
  public readonly canonicalCode?: string;

  constructor(input: {
    message: string;
    statusCode: number;
    responseBody: string;
    requestPayload?: unknown;
    path: string;
    method: string;
    authMode: string;
    canonicalCode?: string;
  }) {
    super(input.message);
    this.name = "GhlApiError";
    this.statusCode = input.statusCode;
    this.responseBody = input.responseBody;
    this.requestPayload = input.requestPayload;
    this.path = input.path;
    this.method = input.method;
    this.authMode = input.authMode;
    this.canonicalCode = input.canonicalCode;
  }
}

const providerNoAccessCanonicalCode = "CONVERSATIONS_MSG_PROVIDER_NO_ACCESS";
const requiredInboundSendAuthMode = "oauth" satisfies GhlInboundSendAuthMode;
let providerConfigWarningLogged = false;
type GhlInboundSendAuthMode = "oauth" | "private_integration";

type InboundEndpointDiagnosis = {
  diagnosis: string;
  likelyFailureClass: "A" | "B" | "C" | "D" | "E" | "F" | "payload_validation_reached" | "none" | "unknown";
};

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeDisplayName(input: GhlCreateContactInput): string {
  const displayName = input.displayName?.trim();

  if (displayName) {
    return displayName;
  }

  return `LINE User ${input.lineUserId.slice(-8)}`;
}

function idsEqual(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left?.trim() && right?.trim() && left.trim() === right.trim());
}

function getProviderIdEqualsOAuthClientId(): boolean {
  return idsEqual(env.GHL_CUSTOM_PROVIDER_ID, env.GHL_OAUTH_CLIENT_ID);
}

function getConfiguredConversationProviderId(): string {
  const conversationProviderId = requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID);

  if (getProviderIdEqualsOAuthClientId() && !providerConfigWarningLogged) {
    providerConfigWarningLogged = true;
    logger.warn(
      {
        conversationProviderId,
        locationId: env.GHL_LOCATION_ID,
        providerIdEqualsOAuthClientId: true
      },
      "GHL_CUSTOM_PROVIDER_ID equals GHL_OAUTH_CLIENT_ID; this is likely the Marketplace OAuth client/app id, not the custom Conversation Provider id"
    );
  }

  return conversationProviderId;
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

async function getInboundSendAuthContext(locationId: string): Promise<GhlAuthContext> {
  return getGhlAuthContext(locationId, { allowPrivateFallback: false });
}

function splitDisplayName(displayName: string): { firstName: string; lastName?: string } {
  const parts = displayName.split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] ?? displayName,
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined
  };
}

function extractContactId(payload: Record<string, unknown>): string {
  const contact = getRecord(payload.contact);
  const contactId =
    getString(payload.id) ??
    getString(payload.contactId) ??
    getString(payload.contact_id) ??
    getString(contact?.id) ??
    getString(contact?.contactId);

  if (!contactId) {
    throw new Error("HighLevel create contact response did not include a contact id");
  }

  return contactId;
}

function buildLineCustomFields(input: GhlCreateContactInput): Array<{ id: string; value: string }> {
  const customFields: Array<{ id: string; value: string }> = [];

  if (env.GHL_LINE_USER_ID_FIELD_ID) {
    customFields.push({
      id: env.GHL_LINE_USER_ID_FIELD_ID,
      value: input.lineUserId
    });
  }

  if (env.GHL_LINE_DISPLAY_NAME_FIELD_ID && input.displayName?.trim()) {
    customFields.push({
      id: env.GHL_LINE_DISPLAY_NAME_FIELD_ID,
      value: input.displayName.trim()
    });
  }

  return customFields;
}

function buildLineTags(lineUserId: string): string[] {
  return ["line", `line:${lineUserId}`];
}

function getTagsFromContactPayload(payload: Record<string, unknown>): string[] {
  const contact = getRecord(payload.contact);
  const tags = Array.isArray(payload.tags) ? payload.tags : Array.isArray(contact?.tags) ? contact.tags : [];

  return tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function buildLineContactMetadataPayload(input: GhlCreateContactInput, existingTags: string[] = []) {
  const customFields = buildLineCustomFields(input);
  return {
    source: "LINE Official Account",
    tags: uniqueTags([...existingTags, ...buildLineTags(input.lineUserId)]),
    customFields: customFields.length > 0 ? customFields : undefined
  };
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

function buildInboundMessagePayload(input: GhlInboundMessageInput) {
  const locationId = input.locationId?.trim() || requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = input.conversationProviderId?.trim() || getConfiguredConversationProviderId();

  return {
    locationId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    conversationProviderId,
    externalConversationId: input.externalConversationId,
    externalMessageId: input.externalMessageId,
    type: getConfiguredInboundMessageType(),
    message: input.message,
    attachments: input.attachments ?? []
  };
}

function buildProviderProbePayload(conversationProviderId: string, locationId: string) {
  return {
    locationId,
    contactId: "debug-provider-access-test-contact",
    conversationProviderId,
    externalConversationId: `debug-provider-test:${locationId}:${conversationProviderId}`,
    externalMessageId: `debug-provider-test:${Date.now()}`,
    type: getConfiguredInboundMessageType(),
    message: "Provider access probe. This should fail before creating a real message.",
    attachments: []
  };
}

function diagnoseInboundEndpointResponse(input: {
  ok: boolean;
  statusCode: number;
  canonicalCode?: string;
  message?: string;
  responseBody?: unknown;
}): InboundEndpointDiagnosis {
  const message = input.message?.toLowerCase() ?? "";
  const bodyText =
    typeof input.responseBody === "string" ? input.responseBody.toLowerCase() : JSON.stringify(input.responseBody ?? {}).toLowerCase();

  if (input.ok) {
    return {
      likelyFailureClass: "none",
      diagnosis: "HighLevel accepted the inbound message request with the configured endpoint, OAuth token, provider id, and payload."
    };
  }

  if (input.statusCode === 400) {
    return {
      likelyFailureClass: "payload_validation_reached",
      diagnosis:
        "HighLevel reached request validation. This usually means the endpoint, auth class, and provider binding were accepted; inspect the response body for the payload/contact validation problem."
    };
  }

  if (input.statusCode === 401 && message.includes("authclass")) {
    return {
      likelyFailureClass: "B",
      diagnosis:
        "Likely B: wrong auth class, or the Marketplace Conversation Provider module is not permitted to call this inbound-message API for the installed app/location."
    };
  }

  if (input.canonicalCode === providerNoAccessCanonicalCode) {
    return {
      likelyFailureClass: "C",
      diagnosis:
        "Likely C or D: the configured conversationProviderId is not accessible for this installed location, or the installed location provider binding is missing/stale."
    };
  }

  if (input.statusCode === 401 || input.statusCode === 403) {
    return {
      likelyFailureClass: "E",
      diagnosis:
        "Likely E: missing Marketplace module permission, missing scope, stale app install, or provider setup not connected to this Marketplace app version."
    };
  }

  if (input.statusCode === 404) {
    return {
      likelyFailureClass: "A",
      diagnosis:
        "Likely A or F: the endpoint path is wrong for this account/API version, or this API path is not supported for the current app/provider configuration."
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
      "HighLevel returned a response that does not cleanly map to endpoint, auth class, provider id, provider binding, module configuration, or unsupported-path failures. Inspect statusCode and response body."
  };
}

async function performGhlRequest(
  path: string,
  init: RequestInit | undefined,
  auth: GhlAuthContext
): Promise<Response> {
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

async function ghlRequestWithResult<T>(
  path: string,
  init?: RequestInit,
  requestPayload?: unknown
): Promise<{ data: T; statusCode: number; responseBody: unknown; authMode: string }> {
  const method = init?.method ?? "GET";
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  let auth = await getGhlAuthContext(locationId);

  logger.debug(
    {
      path,
      method,
      authMode: auth.mode,
      payload: requestPayload ? redactSecrets(requestPayload) : undefined
    },
    "Sending HighLevel API request"
  );

  let response = await performGhlRequest(path, init, auth);

  if (response.status === 401 && auth.mode === "oauth") {
    logger.warn({ path, method }, "HighLevel OAuth request returned 401; refreshing token and retrying once");
    auth = await forceRefreshGhlAuthContext(locationId);
    response = await performGhlRequest(path, init, auth);
  }

  const responseText = await response.text();
  const redactedResponseText = redactSensitiveText(responseText);
  const redactedResponseBody = redactSecrets(parseResponseBody(redactedResponseText));

  if (!response.ok) {
    const { canonicalCode } = getGhlErrorDetails(redactedResponseBody);

    throw new GhlApiError({
      message: `HighLevel API ${response.status} ${response.statusText}: ${redactedResponseText}`,
      statusCode: response.status,
      responseBody: redactedResponseText,
      requestPayload,
      path,
      method,
      authMode: auth.mode,
      canonicalCode
    });
  }

  if (!responseText) {
    return {
      data: undefined as T,
      statusCode: response.status,
      responseBody: undefined,
      authMode: auth.mode
    };
  }

  return {
    data: JSON.parse(responseText) as T,
    statusCode: response.status,
    responseBody: redactedResponseBody,
    authMode: auth.mode
  };
}

async function ghlRequest<T>(path: string, init?: RequestInit, requestPayload?: unknown): Promise<T> {
  return (await ghlRequestWithResult<T>(path, init, requestPayload)).data;
}

export async function createGhlContact(input: GhlCreateContactInput): Promise<GhlContactResponse> {
  const displayName = normalizeDisplayName(input);
  const nameParts = splitDisplayName(displayName);
  const payload = {
    locationId: requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID),
    name: displayName,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    source: "LINE Official Account"
  };

  const response = await ghlRequest<Record<string, unknown>>("/contacts/", {
    method: "POST",
    body: JSON.stringify(payload)
  }, payload);

  return {
    id: extractContactId(response),
    raw: response
  };
}

export async function getGhlContact(contactId: string): Promise<Record<string, unknown>> {
  return ghlRequest<Record<string, unknown>>(`/contacts/${encodeURIComponent(contactId)}`);
}

export async function ensureGhlContactLineMetadata(contactId: string, input: GhlCreateContactInput): Promise<void> {
  let existingTags: string[] = [];

  try {
    existingTags = getTagsFromContactPayload(await getGhlContact(contactId));
  } catch (error) {
    logger.warn(
      {
        contactId,
        lineUserId: input.lineUserId,
        error: error instanceof Error ? error.message : String(error)
      },
      "Could not fetch GHL contact before ensuring LINE tags; sending required LINE tags only"
    );
  }

  const payload = buildLineContactMetadataPayload(input, existingTags);

  await ghlRequest<Record<string, unknown>>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, payload);
}

export async function updateGhlContactLineFields(contactId: string, input: GhlCreateContactInput): Promise<void> {
  await ensureGhlContactLineMetadata(contactId, input);
}

export async function sendInboundMessageToGhl(input: GhlInboundMessageInput): Promise<GhlInboundMessageResponse> {
  const path = "/conversations/messages/inbound";
  const method = "POST";
  const payload = buildInboundMessagePayload(input);
  const configuredAuthMode = getConfiguredInboundSendAuthMode();

  logger.info(
    {
      method,
      path,
      configuredAuthMode,
      conversationProviderId: payload.conversationProviderId,
      providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
      locationId: payload.locationId,
      contactId: payload.contactId,
      inboundMessageType: payload.type,
      requestBody: redactSecrets(payload)
    },
    "Preparing HighLevel inbound conversation provider message"
  );

  try {
    let auth = await getInboundSendAuthContext(payload.locationId);

    if (auth.mode !== requiredInboundSendAuthMode) {
      throw new Error(`Invalid real inbound send path auth: expected ${requiredInboundSendAuthMode} but selected ${auth.mode}`);
    }

    logger.info(
      {
        method,
        path,
        authMode: auth.mode,
        configuredAuthMode,
        conversationProviderId: payload.conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId: payload.locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload)
      },
      "Sending HighLevel inbound conversation provider message"
    );

    let response = await performGhlRequest(path, {
      method,
      body: JSON.stringify(payload)
    }, auth);

    if (response.status === 401 && auth.mode === "oauth") {
      logger.warn(
        {
          method,
          path,
          authMode: auth.mode,
          conversationProviderId: payload.conversationProviderId,
          locationId: payload.locationId,
          contactId: payload.contactId,
          inboundMessageType: payload.type,
          statusCode: response.status
        },
        "HighLevel inbound message send returned 401 with OAuth; refreshing token and retrying once"
      );

      auth = await forceRefreshGhlAuthContext(payload.locationId);
      response = await performGhlRequest(path, {
        method,
        body: JSON.stringify(payload)
      }, auth);
    }

    const responseText = redactSensitiveText(await response.text());
    const responseBody = redactSecrets(parseResponseBody(responseText));
    const { canonicalCode, message } = getGhlErrorDetails(responseBody);

    if (!response.ok) {
      throw new GhlApiError({
        message: `HighLevel API ${response.status} ${response.statusText}: ${responseText}`,
        statusCode: response.status,
        responseBody: responseText,
        requestPayload: payload,
        path,
        method,
        authMode: auth.mode,
        canonicalCode
      });
    }

    const data = responseText ? (JSON.parse(responseText) as GhlInboundMessageResponse) : {};

    logger.info(
      {
        method,
        path,
        authMode: auth.mode,
        conversationProviderId: payload.conversationProviderId,
        locationId: payload.locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        statusCode: response.status,
        canonicalCode,
        message,
        responseBody,
        messageEventStatus: "success"
      },
      "HighLevel inbound conversation provider message accepted"
    );

    return data;
  } catch (error) {
    if (error instanceof GhlApiError) {
      logger.error(
        {
          method,
          path,
          authMode: error.authMode,
          configuredAuthMode,
          conversationProviderId: payload.conversationProviderId,
          providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
          locationId: payload.locationId,
          contactId: payload.contactId,
          inboundMessageType: payload.type,
          requestBody: redactSecrets(payload),
          statusCode: error.statusCode,
          canonicalCode: error.canonicalCode,
          responseBody: error.responseBody,
          messageEventStatus: "failed"
        },
        "HighLevel inbound conversation provider message failed"
      );
    } else {
      logger.error(
        {
          method,
          path,
          configuredAuthMode,
          conversationProviderId: payload.conversationProviderId,
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

export async function testGhlOAuthToken(): Promise<{
  ok: boolean;
  endpoint: string;
  authMode: string;
  statusCode?: number;
  responseBody?: unknown;
  error?: string;
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const endpoint = `/locations/${encodeURIComponent(locationId)}`;

  try {
    let auth = await getGhlAuthContext(locationId, { allowPrivateFallback: false });
    let response = await performGhlRequest(endpoint, { method: "GET" }, auth);

    if (response.status === 401 && auth.mode === "oauth") {
      auth = await forceRefreshGhlAuthContext(locationId);
      response = await performGhlRequest(endpoint, { method: "GET" }, auth);
    }

    const responseText = await response.text();
    let responseBody: unknown = responseText;

    try {
      responseBody = responseText ? JSON.parse(responseText) : undefined;
    } catch {
      responseBody = responseText;
    }

    return {
      ok: response.ok,
      endpoint,
      authMode: auth.mode,
      statusCode: response.status,
      responseBody: redactSecrets(responseBody)
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      authMode: "oauth",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function getGhlProviderConfigDebug(): Promise<{
  GHL_CUSTOM_PROVIDER_ID: string;
  provider_id_equals_oauth_client_id: boolean;
  GHL_LOCATION_ID: string;
  GHL_INBOUND_MESSAGE_TYPE: string;
  GHL_INBOUND_SEND_AUTH_MODE: GhlInboundSendAuthMode;
  oauth_token_present: boolean;
  selected_auth_mode: "oauth" | "private_integration" | "none";
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const providerId = requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID);
  let selectedAuthMode: "oauth" | "private_integration" | "none" = "none";
  let oauthTokenPresent = false;

  try {
    await getGhlAuthContext(locationId, { allowPrivateFallback: false });
    oauthTokenPresent = true;
  } catch {
    oauthTokenPresent = false;
  }

  try {
    selectedAuthMode = (await getGhlAuthContext(locationId)).mode;
  } catch {
    selectedAuthMode = "none";
  }

  return {
    GHL_CUSTOM_PROVIDER_ID: providerId,
    provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
    GHL_LOCATION_ID: locationId,
    GHL_INBOUND_MESSAGE_TYPE: getConfiguredInboundMessageType(),
    GHL_INBOUND_SEND_AUTH_MODE: getConfiguredInboundSendAuthMode(),
    oauth_token_present: oauthTokenPresent,
    selected_auth_mode: selectedAuthMode
  };
}

export function getGhlInboundSendAuthConfigDebug(): {
  GHL_INBOUND_SEND_AUTH_MODE: GhlInboundSendAuthMode;
  private_token_present: boolean;
  provider_id_used: string;
  provider_id_equals_oauth_client_id: boolean;
  inbound_message_type: string;
  location_id: string;
} {
  return {
    GHL_INBOUND_SEND_AUTH_MODE: getConfiguredInboundSendAuthMode(),
    private_token_present: Boolean(env.GHL_PRIVATE_INTEGRATION_TOKEN.trim()),
    provider_id_used: getConfiguredConversationProviderId(),
    provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
    inbound_message_type: getConfiguredInboundMessageType(),
    location_id: requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID)
  };
}

export async function testGhlConversationProviderAccess(): Promise<{
  provider_access_ok: boolean;
  endpoint: string;
  method: string;
  authMode: string;
  GHL_CUSTOM_PROVIDER_ID: string;
  provider_id_equals_oauth_client_id: boolean;
  GHL_LOCATION_ID: string;
  statusCode?: number;
  canonicalCode?: string;
  message?: string;
  responseBody?: unknown;
  inbound_message_type?: string;
  diagnosis?: string;
  likely_failure_class?: InboundEndpointDiagnosis["likelyFailureClass"];
  error?: string;
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = getConfiguredConversationProviderId();
  const endpoint = "/conversations/messages/inbound";
  const method = "POST";
  const payload = buildProviderProbePayload(conversationProviderId, locationId);

  try {
    let auth = await getGhlAuthContext(locationId, { allowPrivateFallback: false });
    let response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);

    if (response.status === 401 && auth.mode === "oauth") {
      auth = await forceRefreshGhlAuthContext(locationId);
      response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);
    }

    const responseText = redactSensitiveText(await response.text());
    const responseBody = redactSecrets(parseResponseBody(responseText));
    const { canonicalCode, message } = getGhlErrorDetails(responseBody);
    const diagnosis = diagnoseInboundEndpointResponse({
      ok: response.ok,
      statusCode: response.status,
      canonicalCode,
      message,
      responseBody
    });
    const lowerMessage = message?.toLowerCase();
    const providerAccessDenied =
      canonicalCode === providerNoAccessCanonicalCode ||
      Boolean(lowerMessage?.includes("conversationprovider") && lowerMessage.includes("access")) ||
      diagnosis.likelyFailureClass === "B" ||
      diagnosis.likelyFailureClass === "C" ||
      diagnosis.likelyFailureClass === "D" ||
      diagnosis.likelyFailureClass === "E";

    logger.info(
      {
        method,
        endpoint,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        statusCode: response.status,
        responseBody,
        canonicalCode,
        message,
        diagnosis
      },
      "HighLevel conversation provider access test completed"
    );

    return {
      provider_access_ok:
        response.ok || (!providerAccessDenied && response.status !== 401 && response.status !== 403 && response.status !== 404),
      endpoint,
      method,
      authMode: auth.mode,
      GHL_CUSTOM_PROVIDER_ID: conversationProviderId,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      GHL_LOCATION_ID: locationId,
      statusCode: response.status,
      canonicalCode,
      message,
      responseBody,
      inbound_message_type: payload.type,
      diagnosis: diagnosis.diagnosis,
      likely_failure_class: diagnosis.likelyFailureClass
    };
  } catch (error) {
    return {
      provider_access_ok: false,
      endpoint,
      method,
      authMode: "oauth",
      GHL_CUSTOM_PROVIDER_ID: conversationProviderId,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      GHL_LOCATION_ID: locationId,
      inbound_message_type: getConfiguredInboundMessageType(),
      diagnosis:
        "The provider access probe could not complete locally before receiving a HighLevel HTTP response. Inspect the error field and server logs.",
      likely_failure_class: "unknown",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function testGhlInboundMessageEndpoint(): Promise<{
  endpoint_path: string;
  method: string;
  auth_mode: string;
  provider_id_used: string;
  provider_id_equals_oauth_client_id: boolean;
  location_id: string;
  inbound_message_type: string;
  request_payload: unknown;
  statusCode?: number;
  canonicalCode?: string;
  message?: string;
  ghl_response_body?: unknown;
  diagnosis: string;
  likely_failure_class: InboundEndpointDiagnosis["likelyFailureClass"];
  error?: string;
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = getConfiguredConversationProviderId();
  const endpoint = "/conversations/messages/inbound";
  const method = "POST";
  const payload = buildProviderProbePayload(conversationProviderId, locationId);

  logger.info(
    {
      method,
      endpoint,
      conversationProviderId,
      providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
      locationId,
      inboundMessageType: payload.type,
      requestBody: redactSecrets(payload)
    },
    "Testing HighLevel inbound message endpoint"
  );

  try {
    let auth = await getGhlAuthContext(locationId, { allowPrivateFallback: false });
    let response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);

    if (response.status === 401 && auth.mode === "oauth") {
      logger.warn(
        {
          method,
          endpoint,
          conversationProviderId,
          locationId,
          statusCode: response.status
        },
        "HighLevel inbound endpoint test returned 401; refreshing OAuth token and retrying once"
      );
      auth = await forceRefreshGhlAuthContext(locationId);
      response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);
    }

    const responseText = redactSensitiveText(await response.text());
    const responseBody = redactSecrets(parseResponseBody(responseText));
    const { canonicalCode, message } = getGhlErrorDetails(responseBody);
    const diagnosis = diagnoseInboundEndpointResponse({
      ok: response.ok,
      statusCode: response.status,
      canonicalCode,
      message,
      responseBody
    });

    logger.info(
      {
        method,
        endpoint,
        authMode: auth.mode,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        statusCode: response.status,
        canonicalCode,
        message,
        responseBody,
        diagnosis
      },
      "HighLevel inbound message endpoint test completed"
    );

    return {
      endpoint_path: endpoint,
      method,
      auth_mode: auth.mode,
      provider_id_used: conversationProviderId,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      location_id: locationId,
      inbound_message_type: payload.type,
      request_payload: redactSecrets(payload),
      statusCode: response.status,
      canonicalCode,
      message,
      ghl_response_body: responseBody,
      diagnosis: diagnosis.diagnosis,
      likely_failure_class: diagnosis.likelyFailureClass
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(
      {
        method,
        endpoint,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        error: errorMessage
      },
      "HighLevel inbound message endpoint test failed before receiving a response"
    );

    return {
      endpoint_path: endpoint,
      method,
      auth_mode: "oauth",
      provider_id_used: conversationProviderId,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      location_id: locationId,
      inbound_message_type: payload.type,
      request_payload: redactSecrets(payload),
      diagnosis:
        "The inbound endpoint probe failed before receiving a HighLevel HTTP response. Check server logs for network, token lookup, or configuration errors.",
      likely_failure_class: "unknown",
      error: errorMessage
    };
  }
}

export async function testConfiguredGhlInboundSendAuth(): Promise<{
  endpoint_path: string;
  method: string;
  auth_mode: string;
  configured_auth_mode: GhlInboundSendAuthMode;
  provider_id_used: string;
  provider_id_equals_oauth_client_id: boolean;
  location_id: string;
  inbound_message_type: string;
  request_payload: unknown;
  statusCode?: number;
  canonicalCode?: string;
  message?: string;
  ghl_response_body?: unknown;
  diagnosis: string;
  likely_failure_class: InboundEndpointDiagnosis["likelyFailureClass"];
  error?: string;
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = getConfiguredConversationProviderId();
  const endpoint = "/conversations/messages/inbound";
  const method = "POST";
  const configuredAuthMode = getConfiguredInboundSendAuthMode();
  const payload = buildProviderProbePayload(conversationProviderId, locationId);
  let authMode: string = configuredAuthMode;

  logger.info(
    {
      method,
      endpoint,
      configuredAuthMode,
      conversationProviderId,
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
    let auth = await getInboundSendAuthContext(locationId);
    authMode = auth.mode;
    let response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);

    if (response.status === 401 && auth.mode === "oauth") {
      logger.warn(
        {
          method,
          endpoint,
          authMode: auth.mode,
          conversationProviderId,
          locationId,
          contactId: payload.contactId,
          inboundMessageType: payload.type,
          statusCode: response.status
        },
        "Configured inbound send auth test returned 401 with OAuth; refreshing token and retrying once"
      );

      auth = await forceRefreshGhlAuthContext(locationId);
      authMode = auth.mode;
      response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, auth);
    }

    const responseText = redactSensitiveText(await response.text());
    const responseBody = redactSecrets(parseResponseBody(responseText));
    const { canonicalCode, message } = getGhlErrorDetails(responseBody);
    const diagnosis = diagnoseInboundEndpointResponse({
      ok: response.ok,
      statusCode: response.status,
      canonicalCode,
      message,
      responseBody
    });

    logger.info(
      {
        method,
        endpoint,
        authMode,
        configuredAuthMode,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        statusCode: response.status,
        canonicalCode,
        message,
        responseBody,
        diagnosis
      },
      "Configured HighLevel inbound send auth test completed"
    );

    return {
      endpoint_path: endpoint,
      method,
      auth_mode: authMode,
      configured_auth_mode: configuredAuthMode,
      provider_id_used: conversationProviderId,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      location_id: locationId,
      inbound_message_type: payload.type,
      request_payload: redactSecrets(payload),
      statusCode: response.status,
      canonicalCode,
      message,
      ghl_response_body: responseBody,
      diagnosis: diagnosis.diagnosis,
      likely_failure_class: diagnosis.likelyFailureClass
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(
      {
        method,
        endpoint,
        authMode,
        configuredAuthMode,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        contactId: payload.contactId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        error: errorMessage
      },
      "Configured HighLevel inbound send auth test failed before receiving a response"
    );

    return {
      endpoint_path: endpoint,
      method,
      auth_mode: authMode,
      configured_auth_mode: configuredAuthMode,
      provider_id_used: conversationProviderId,
      provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
      location_id: locationId,
      inbound_message_type: payload.type,
      request_payload: redactSecrets(payload),
      diagnosis:
        "The configured inbound send auth probe failed before receiving a HighLevel HTTP response. Check server logs for token lookup, private-token configuration, network, or provider settings.",
      likely_failure_class: "unknown",
      error: errorMessage
    };
  }
}
