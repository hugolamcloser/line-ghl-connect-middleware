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

  constructor(input: {
    message: string;
    statusCode: number;
    responseBody: string;
    requestPayload?: unknown;
    path: string;
    method: string;
    authMode: string;
  }) {
    super(input.message);
    this.name = "GhlApiError";
    this.statusCode = input.statusCode;
    this.responseBody = input.responseBody;
    this.requestPayload = input.requestPayload;
    this.path = input.path;
    this.method = input.method;
    this.authMode = input.authMode;
  }
}

const providerNoAccessCanonicalCode = "CONVERSATIONS_MSG_PROVIDER_NO_ACCESS";
let providerConfigWarningLogged = false;

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
  const conversationProviderId = getConfiguredConversationProviderId();
  return {
    locationId: requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID),
    contactId: input.contactId,
    conversationId: input.conversationId,
    conversationProviderId,
    providerId: conversationProviderId,
    externalConversationId: input.externalConversationId,
    externalMessageId: input.externalMessageId,
    direction: "inbound",
    type: "CUSTOM",
    message: input.message,
    attachments: input.attachments ?? []
  };
}

function buildProviderProbePayload(conversationProviderId: string, locationId: string) {
  return {
    locationId,
    contactId: "debug-provider-access-test-contact",
    conversationProviderId,
    providerId: conversationProviderId,
    externalConversationId: `debug-provider-test:${locationId}:${conversationProviderId}`,
    externalMessageId: `debug-provider-test:${Date.now()}`,
    direction: "inbound",
    type: "CUSTOM",
    message: "Provider access probe. This should fail before creating a real message.",
    attachments: []
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
    throw new GhlApiError({
      message: `HighLevel API ${response.status} ${response.statusText}: ${redactedResponseText}`,
      statusCode: response.status,
      responseBody: redactedResponseText,
      requestPayload,
      path,
      method,
      authMode: auth.mode
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

  logger.info(
    {
      method,
      path,
      conversationProviderId: payload.conversationProviderId,
      providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
      locationId: payload.locationId,
      requestBody: redactSecrets(payload)
    },
    "Sending HighLevel inbound conversation provider message"
  );

  try {
    const response = await ghlRequestWithResult<GhlInboundMessageResponse>(path, {
      method,
      body: JSON.stringify(payload)
    }, payload);

    logger.info(
      {
        method,
        path,
        conversationProviderId: payload.conversationProviderId,
        locationId: payload.locationId,
        statusCode: response.statusCode,
        responseBody: response.responseBody,
        authMode: response.authMode
      },
      "HighLevel inbound conversation provider message accepted"
    );

    return response.data;
  } catch (error) {
    if (error instanceof GhlApiError) {
      logger.error(
        {
          method,
          path,
          conversationProviderId: payload.conversationProviderId,
          providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
          locationId: payload.locationId,
          requestBody: redactSecrets(payload),
          statusCode: error.statusCode,
          responseBody: error.responseBody,
          authMode: error.authMode
        },
        "HighLevel inbound conversation provider message failed"
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
    oauth_token_present: oauthTokenPresent,
    selected_auth_mode: selectedAuthMode
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
    const lowerMessage = message?.toLowerCase();
    const providerAccessDenied =
      canonicalCode === providerNoAccessCanonicalCode ||
      Boolean(lowerMessage?.includes("conversationprovider") && lowerMessage.includes("access"));

    logger.info(
      {
        method,
        endpoint,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        statusCode: response.status,
        responseBody,
        canonicalCode,
        message
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
      responseBody
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
