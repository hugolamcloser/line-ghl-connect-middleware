import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import type {
  GhlContactResponse,
  GhlCreateContactInput,
  GhlInboundMessageInput,
  GhlInboundMessageResponse
} from "../types/ghl";
import { redactSecrets } from "../utils/redaction";

export class GhlApiError extends Error {
  public readonly statusCode: number;
  public readonly responseBody: string;
  public readonly requestPayload?: unknown;

  constructor(message: string, statusCode: number, responseBody: string, requestPayload?: unknown) {
    super(message);
    this.name = "GhlApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.requestPayload = requestPayload;
  }
}

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

async function ghlRequest<T>(path: string, init?: RequestInit, requestPayload?: unknown): Promise<T> {
  logger.debug(
    {
      path,
      method: init?.method ?? "GET",
      payload: requestPayload ? redactSecrets(requestPayload) : undefined
    },
    "Sending HighLevel API request"
  );

  const response = await fetch(`${env.GHL_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireEnvValue(
        "GHL_PRIVATE_INTEGRATION_TOKEN",
        env.GHL_PRIVATE_INTEGRATION_TOKEN
      )}`,
      Version: requireEnvValue("GHL_API_VERSION", env.GHL_API_VERSION),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {})
    }
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new GhlApiError(
      `HighLevel API ${response.status} ${response.statusText}: ${responseText}`,
      response.status,
      responseText,
      requestPayload
    );
  }

  if (!responseText) {
    return undefined as T;
  }

  return JSON.parse(responseText) as T;
}

export async function createGhlContact(input: GhlCreateContactInput): Promise<GhlContactResponse> {
  const displayName = normalizeDisplayName(input);
  const nameParts = splitDisplayName(displayName);
  const customFields = buildLineCustomFields(input);
  const payload = {
    locationId: requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID),
    name: displayName,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    source: "LINE Official Account",
    tags: ["line", "LINE Official Account"],
    customFields: customFields.length > 0 ? customFields : undefined
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

export async function updateGhlContactLineFields(contactId: string, input: GhlCreateContactInput): Promise<void> {
  const customFields = buildLineCustomFields(input);

  if (customFields.length === 0) {
    return;
  }

  const payload = {
    customFields
  };

  await ghlRequest<Record<string, unknown>>(`/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }, payload);
}

export async function sendInboundMessageToGhl(input: GhlInboundMessageInput): Promise<GhlInboundMessageResponse> {
  const payload = {
    locationId: requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID),
    contactId: input.contactId,
    conversationId: input.conversationId,
    conversationProviderId: requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID),
    providerId: requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID),
    externalConversationId: input.externalConversationId,
    externalMessageId: input.externalMessageId,
    direction: "inbound",
    type: "CUSTOM",
    message: input.message,
    attachments: input.attachments ?? []
  };

  return ghlRequest<GhlInboundMessageResponse>("/conversations/messages/inbound", {
    method: "POST",
    body: JSON.stringify(payload)
  }, payload);
}
