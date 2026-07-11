import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import { forceRefreshGhlAuthContext, getGhlAuthContext, type GhlAuthContext } from "../services/ghlOAuthService";
import type { GhlContactResponse, GhlCreateContactInput } from "../types/ghl";
import { redactSecrets, redactSensitiveText } from "../utils/redaction";
import { GhlApiError } from "./ghlClient";

export type GhlLocationApiAuthMode = "oauth" | "private_integration";
export type GhlLineInboundContactStep = "create" | "search" | "update" | "tag" | "custom_field" | "send_message";

type GhlResolvedAuthMode = GhlAuthContext["mode"];

type ContactRequestDiagnostics = {
  contact_auth_mode_used: GhlResolvedAuthMode;
  configured_inbound_send_auth_mode: GhlLocationApiAuthMode;
  inbound_send_auth_mode_used: GhlLocationApiAuthMode;
  used_private_integration_token_for_contact: boolean;
  used_private_integration_token_for_inbound_send: boolean;
  contact_step: GhlLineInboundContactStep;
  endpoint: string;
  method: string;
  locationId: string;
  contactId?: string;
  statusCode?: number;
  canonicalCode?: string;
  ghl_response_body?: unknown;
  request_body?: unknown;
};

type LocationRequestResult<T> = {
  data: T;
  statusCode: number;
  responseBody: unknown;
  authMode: GhlResolvedAuthMode;
  diagnostics: ContactRequestDiagnostics;
};

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

export function isStaleGhlContactError(error: unknown): boolean {
  const details = error as {
    statusCode?: number;
    responseBody?: unknown;
    canonicalCode?: string;
    message?: string;
  };
  const responseBody =
    typeof details.responseBody === "string" ? parseResponseBody(details.responseBody) : details.responseBody;
  const canonicalCode =
    details.canonicalCode ??
    getNestedString(responseBody, "canonicalCode") ??
    getNestedString(responseBody, "error", "canonicalCode") ??
    getNestedString(responseBody, "meta", "canonicalCode");
  const message = [details.message, typeof details.responseBody === "string" ? details.responseBody : JSON.stringify(responseBody ?? {})]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (canonicalCode === "CONVERSATIONS_CONTACT_DELETED") {
    return true;
  }

  if (details.statusCode !== 400 && details.statusCode !== 404) {
    return false;
  }

  return (
    message.includes("contact not found") ||
    message.includes("not found/deleted") ||
    (message.includes("contact") && message.includes("deleted"))
  );
}

function normalizeDisplayName(input: GhlCreateContactInput): string {
  const displayName = input.displayName?.trim();

  if (displayName) {
    return displayName;
  }

  return `LINE User ${input.lineUserId.slice(-8)}`;
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

function getTagsFromContactPayload(payload: Record<string, unknown>): string[] {
  const contact = getRecord(payload.contact);
  const tags = Array.isArray(payload.tags) ? payload.tags : Array.isArray(contact?.tags) ? contact.tags : [];

  return tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function buildLineTags(lineUserId: string): string[] {
  return ["line", `line:${lineUserId}`];
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

function buildLineContactMetadataPayload(input: GhlCreateContactInput, existingTags: string[] = []) {
  const customFields = buildLineCustomFields(input);

  return {
    source: "LINE Official Account",
    tags: uniqueTags([...existingTags, ...buildLineTags(input.lineUserId)]),
    customFields: customFields.length > 0 ? customFields : undefined
  };
}

export function getConfiguredLocationApiAuthMode(): GhlLocationApiAuthMode {
  return env.GHL_LOCATION_API_AUTH_MODE;
}

export function getConfiguredInboundSendAuthMode(): GhlLocationApiAuthMode {
  return env.GHL_INBOUND_SEND_AUTH_MODE;
}

export function getEffectiveInboundSendAuthMode(): GhlLocationApiAuthMode {
  return "oauth";
}

export function getLocationApiPrivateTokenPresent(): boolean {
  return Boolean(env.GHL_PRIVATE_INTEGRATION_TOKEN.trim());
}

export function getLineInboundFlowAuthDiagnostics(contactStep: GhlLineInboundContactStep): {
  contact_auth_mode_used: GhlLocationApiAuthMode;
  configured_inbound_send_auth_mode: GhlLocationApiAuthMode;
  inbound_send_auth_mode_used: GhlLocationApiAuthMode;
  used_private_integration_token_for_contact: boolean;
  used_private_integration_token_for_inbound_send: boolean;
  contact_step: GhlLineInboundContactStep;
} {
  const contactAuthMode = getConfiguredLocationApiAuthMode();
  const inboundSendAuthMode = getEffectiveInboundSendAuthMode();

  return {
    contact_auth_mode_used: contactAuthMode,
    configured_inbound_send_auth_mode: getConfiguredInboundSendAuthMode(),
    inbound_send_auth_mode_used: inboundSendAuthMode,
    used_private_integration_token_for_contact: contactAuthMode === "private_integration",
    used_private_integration_token_for_inbound_send: inboundSendAuthMode === "private_integration",
    contact_step: contactStep
  };
}

function getPrivateIntegrationAuthContext(locationId: string): GhlAuthContext {
  return {
    mode: "private_integration",
    accessToken: requireEnvValue("GHL_PRIVATE_INTEGRATION_TOKEN", env.GHL_PRIVATE_INTEGRATION_TOKEN),
    locationId
  };
}

async function getLocationApiAuthContext(locationId: string): Promise<GhlAuthContext> {
  if (getConfiguredLocationApiAuthMode() === "private_integration") {
    return getPrivateIntegrationAuthContext(locationId);
  }

  return getGhlAuthContext(locationId, { allowPrivateFallback: false });
}

async function performGhlLocationRequest(path: string, init: RequestInit | undefined, auth: GhlAuthContext): Promise<Response> {
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

function buildContactDiagnostics(input: {
  authMode: GhlResolvedAuthMode;
  contactStep: GhlLineInboundContactStep;
  path: string;
  method: string;
  locationId: string;
  contactId?: string;
  requestPayload?: unknown;
  statusCode?: number;
  canonicalCode?: string;
  responseBody?: unknown;
}): ContactRequestDiagnostics {
  const inboundSendAuthMode = getEffectiveInboundSendAuthMode();

  return {
    contact_auth_mode_used: input.authMode,
    configured_inbound_send_auth_mode: getConfiguredInboundSendAuthMode(),
    inbound_send_auth_mode_used: inboundSendAuthMode,
    used_private_integration_token_for_contact: input.authMode === "private_integration",
    used_private_integration_token_for_inbound_send: inboundSendAuthMode === "private_integration",
    contact_step: input.contactStep,
    endpoint: input.path,
    method: input.method,
    locationId: input.locationId,
    contactId: input.contactId,
    statusCode: input.statusCode,
    canonicalCode: input.canonicalCode,
    ghl_response_body: input.responseBody,
    request_body: input.requestPayload ? redactSecrets(input.requestPayload) : undefined
  };
}

async function executeLocationRequest<T>(input: {
  path: string;
  init?: RequestInit;
  requestPayload?: unknown;
  contactStep: GhlLineInboundContactStep;
  contactId?: string;
  locationId?: string;
}): Promise<LocationRequestResult<T>> {
  const method = input.init?.method ?? "GET";
  const locationId = input.locationId?.trim() || requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  let auth = await getLocationApiAuthContext(locationId);

  logger.debug(
    {
      path: input.path,
      method,
      authMode: auth.mode,
      contactStep: input.contactStep,
      contactId: input.contactId,
      locationId,
      payload: input.requestPayload ? redactSecrets(input.requestPayload) : undefined
    },
    "Sending HighLevel location API request"
  );

  let response = await performGhlLocationRequest(input.path, input.init, auth);

  if (response.status === 401 && auth.mode === "oauth") {
    logger.warn(
      {
        path: input.path,
        method,
        contactStep: input.contactStep,
        contactId: input.contactId,
        locationId
      },
      "HighLevel location API OAuth request returned 401; refreshing token and retrying once"
    );
    auth = await forceRefreshGhlAuthContext(locationId);
    response = await performGhlLocationRequest(input.path, input.init, auth);
  }

  const responseText = await response.text();
  const redactedResponseText = redactSensitiveText(responseText);
  const redactedResponseBody = redactSecrets(parseResponseBody(redactedResponseText));
  const { canonicalCode } = getGhlErrorDetails(redactedResponseBody);
  const diagnostics = buildContactDiagnostics({
    authMode: auth.mode,
    contactStep: input.contactStep,
    path: input.path,
    method,
    locationId,
    contactId: input.contactId,
    requestPayload: input.requestPayload,
    statusCode: response.status,
    canonicalCode,
    responseBody: redactedResponseBody
  });

  if (!response.ok) {
    throw new GhlApiError({
      message: `HighLevel API ${response.status} ${response.statusText}: ${redactedResponseText}`,
      statusCode: response.status,
      responseBody: redactedResponseText,
      requestPayload: diagnostics,
      path: input.path,
      method,
      authMode: auth.mode,
      canonicalCode
    });
  }

  return {
    data: responseText ? (JSON.parse(responseText) as T) : (undefined as T),
    statusCode: response.status,
    responseBody: redactedResponseBody,
    authMode: auth.mode,
    diagnostics
  };
}

function getMetadataUpdateStep(input: GhlCreateContactInput): GhlLineInboundContactStep {
  return buildLineCustomFields(input).length > 0 ? "custom_field" : "tag";
}

export async function createGhlContact(input: GhlCreateContactInput): Promise<GhlContactResponse> {
  const displayName = normalizeDisplayName(input);
  const nameParts = splitDisplayName(displayName);
  const locationId = input.locationId?.trim() || requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const payload = {
    locationId,
    name: displayName,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    ...buildLineContactMetadataPayload({
      ...input,
      displayName
    })
  };

  const response = await executeLocationRequest<Record<string, unknown>>({
    path: "/contacts/",
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    },
    requestPayload: payload,
    contactStep: "create",
    locationId
  });
  const contactId = extractContactId(response.data);

  logger.info(
    {
      contactId,
      contactAuthMode: response.authMode,
      locationApiAuthMode: getConfiguredLocationApiAuthMode(),
      inboundSendAuthMode: getEffectiveInboundSendAuthMode()
    },
    "Created HighLevel contact through selected location API auth mode"
  );

  return {
    id: contactId,
    raw: response.data
  };
}

export async function getGhlContact(contactId: string, locationId?: string): Promise<Record<string, unknown>> {
  return (
    await executeLocationRequest<Record<string, unknown>>({
      path: `/contacts/${encodeURIComponent(contactId)}`,
      contactStep: "search",
      contactId,
      locationId
    })
  ).data;
}

export async function ensureGhlContactLineMetadata(contactId: string, input: GhlCreateContactInput): Promise<void> {
  const locationId = input.locationId?.trim() || requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  let existingTags: string[] = [];

  try {
    existingTags = getTagsFromContactPayload(await getGhlContact(contactId, locationId));
  } catch (error) {
    if (isStaleGhlContactError(error)) {
      throw error;
    }

    logger.warn(
      {
        contactId,
        lineUserId: input.lineUserId,
        contactAuthMode: getConfiguredLocationApiAuthMode(),
        error: error instanceof Error ? error.message : String(error)
      },
      "Could not fetch GHL contact before ensuring LINE tags; sending required LINE tags only"
    );
  }

  const payload = buildLineContactMetadataPayload(input, existingTags);

  await executeLocationRequest<Record<string, unknown>>({
    path: `/contacts/${encodeURIComponent(contactId)}`,
    init: {
      method: "PUT",
      body: JSON.stringify(payload)
    },
    requestPayload: payload,
    contactStep: getMetadataUpdateStep(input),
    contactId,
    locationId
  });
}

function diagnoseContactAuthResponse(input: {
  ok: boolean;
  statusCode?: number;
  canonicalCode?: string;
  message?: string;
}): string {
  const message = input.message?.toLowerCase() ?? "";

  if (input.ok) {
    return "Selected location API auth mode can create and update a debug HighLevel contact.";
  }

  if (input.statusCode === 401 && message.includes("authclass")) {
    return "Selected auth mode reached HighLevel but is blocked by authClass for contact writes. Use private_integration for location-level LINE inbound writes.";
  }

  if (input.statusCode === 400) {
    return "HighLevel reached contact request validation. Auth is likely accepted; inspect the response body for payload requirements.";
  }

  if (input.statusCode === 401 || input.statusCode === 403) {
    return "HighLevel rejected the selected location API auth mode. Check token type, scopes, location match, and Private Integration token access.";
  }

  return "Inspect the status code and redacted HighLevel response body to confirm the contact API requirement.";
}

export async function testGhlContactAuth(): Promise<{
  ok: boolean;
  selected_auth_mode: GhlLocationApiAuthMode;
  private_token_present: boolean;
  endpoint_used: string;
  statusCode?: number;
  canonicalCode?: string;
  ghl_response_body?: unknown;
  diagnosis: string;
  steps: Array<{
    contact_step: GhlLineInboundContactStep;
    endpoint: string;
    method: string;
    authMode?: string;
    statusCode?: number;
    canonicalCode?: string;
    responseBody?: unknown;
  }>;
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const createPayload = {
    locationId,
    firstName: "Debug",
    lastName: "LineContactAuth",
    source: "LINE Official Account Debug"
  };
  const steps: Array<{
    contact_step: GhlLineInboundContactStep;
    endpoint: string;
    method: string;
    authMode?: string;
    statusCode?: number;
    canonicalCode?: string;
    responseBody?: unknown;
  }> = [];

  try {
    const createResult = await executeLocationRequest<Record<string, unknown>>({
      path: "/contacts/",
      init: {
        method: "POST",
        body: JSON.stringify(createPayload)
      },
      requestPayload: createPayload,
      contactStep: "create"
    });
    const contactId = extractContactId(createResult.data);

    steps.push({
      contact_step: "create",
      endpoint: "/contacts/",
      method: "POST",
      authMode: createResult.authMode,
      statusCode: createResult.statusCode,
      responseBody: createResult.responseBody
    });

    const updatePayload = {
      source: "LINE Official Account Debug",
      tags: ["line", `line:debug-${Date.now()}`]
    };
    const updateEndpoint = `/contacts/${encodeURIComponent(contactId)}`;
    const updateResult = await executeLocationRequest<Record<string, unknown>>({
      path: updateEndpoint,
      init: {
        method: "PUT",
        body: JSON.stringify(updatePayload)
      },
      requestPayload: updatePayload,
      contactStep: "update",
      contactId
    });

    steps.push({
      contact_step: "update",
      endpoint: updateEndpoint,
      method: "PUT",
      authMode: updateResult.authMode,
      statusCode: updateResult.statusCode,
      responseBody: updateResult.responseBody
    });

    return {
      ok: true,
      selected_auth_mode: getConfiguredLocationApiAuthMode(),
      private_token_present: getLocationApiPrivateTokenPresent(),
      endpoint_used: updateEndpoint,
      statusCode: updateResult.statusCode,
      ghl_response_body: updateResult.responseBody,
      diagnosis: diagnoseContactAuthResponse({ ok: true, statusCode: updateResult.statusCode }),
      steps
    };
  } catch (error) {
    if (error instanceof GhlApiError) {
      const responseBody = redactSecrets(parseResponseBody(error.responseBody));
      const { message } = getGhlErrorDetails(responseBody);
      const failedStep = (getNestedString(error.requestPayload, "contact_step") as GhlLineInboundContactStep | undefined) ?? "create";

      steps.push({
        contact_step: failedStep,
        endpoint: error.path,
        method: error.method,
        authMode: error.authMode,
        statusCode: error.statusCode,
        canonicalCode: error.canonicalCode,
        responseBody
      });

      return {
        ok: false,
        selected_auth_mode: getConfiguredLocationApiAuthMode(),
        private_token_present: getLocationApiPrivateTokenPresent(),
        endpoint_used: error.path,
        statusCode: error.statusCode,
        canonicalCode: error.canonicalCode,
        ghl_response_body: responseBody,
        diagnosis: diagnoseContactAuthResponse({
          ok: false,
          statusCode: error.statusCode,
          canonicalCode: error.canonicalCode,
          message
        }),
        steps
      };
    }

    return {
      ok: false,
      selected_auth_mode: getConfiguredLocationApiAuthMode(),
      private_token_present: getLocationApiPrivateTokenPresent(),
      endpoint_used: "/contacts/",
      diagnosis: error instanceof Error ? error.message : String(error),
      steps
    };
  }
}
