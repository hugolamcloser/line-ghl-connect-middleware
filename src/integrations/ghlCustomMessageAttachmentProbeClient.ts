import { env, requireEnvValue } from "../config/env";
import {
  forceRefreshGhlAuthContext,
  getGhlAuthContext,
  type GhlAuthContext
} from "../services/ghlOAuthService";

export type Stage1InitialStatus = "pending" | "delivered";
export type Stage1FinalStatus = "delivered" | "failed";

export type Stage1CustomMessagePayload = {
  type: "Custom";
  contactId: string;
  conversationProviderId: string;
  status: Stage1InitialStatus;
  message?: string;
  attachments?: string[];
};

export type Stage1InboundBootstrapPayload = {
  locationId: string;
  contactId: string;
  conversationProviderId: string;
  externalConversationId: string;
  externalMessageId: string;
  type: "SMS";
  message: string;
};

export type Stage1RejectedFieldDiagnostic = {
  field: string;
  message?: string;
  code?: string;
};

export type Stage1UpstreamErrorDiagnostic = {
  statusCode: number;
  status?: string;
  error?: string;
  message?: string;
  code?: string;
  rejectedFields: Stage1RejectedFieldDiagnostic[];
  responseParsed: boolean;
  responseTruncated: boolean;
};

export type Stage1GhlRequestResult = {
  ok: boolean;
  statusCode: number;
  messageId?: string;
  conversationId?: string;
  upstreamError?: Stage1UpstreamErrorDiagnostic;
};

export type Stage1RecognizedSmsProvider = {
  name: string;
  type: string;
  default: boolean;
  matchesConfiguredStage1Provider: boolean;
};

export type Stage1ProviderCheckResult = {
  ok: boolean;
  statusCode: number;
  configuredProviderMatched: boolean;
  recognizedProviders: Stage1RecognizedSmsProvider[];
  upstreamError?: Stage1UpstreamErrorDiagnostic;
};

const messagesEndpoint = "/conversations/messages";
const inboundMessagesEndpoint = `${messagesEndpoint}/inbound`;
const maxUpstreamErrorBytes = 32 * 1_024;
const maxDiagnosticTextLength = 240;
const maxDiagnosticCodeLength = 80;
const maxRejectedFieldLength = 120;
const maxRejectedFields = 20;
const maxRecognizedProviders = 50;
const maxDiagnosticTraversalDepth = 5;
const maxDiagnosticTraversalNodes = 100;
const urlPattern = /https?:\/\/[^\s"'<>]+/giu;
const jwtPattern = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const bearerPattern = /\bBearer\s+[^\s,;]+/giu;
const longIdentifierPattern = /\b(?=[A-Za-z0-9_-]{18,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/gu;
const filenamePattern = /[^\s"'<>/\\]{1,120}\.(?:jpe?g|png|gif|webp|mp4|mov|m4v|webm|mp3|m4a|wav|aac|ogg|pdf|docx?|xlsx?|csv|pptx?|txt)(?=$|[\s,;:)\]}])/giu;
const safeFieldPattern = /^[A-Za-z0-9_$.[\]-]{1,120}$/u;

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getNestedString(value: unknown, ...path: string[]): string | undefined {
  let current = value;

  for (const key of path) {
    const record = getRecord(current);

    if (!record) {
      return undefined;
    }

    current = record[key];
  }

  return getNonEmptyString(current);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The probe never needs provider error bodies.
  }
}

function sanitizeDiagnosticText(value: unknown, maximumLength = maxDiagnosticTextLength): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }

  let sanitized = String(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(urlPattern, "[redacted]")
    .replace(jwtPattern, "[redacted]")
    .replace(bearerPattern, "Bearer [redacted]");

  const knownSensitiveValues = [
    env.STAGE1_GHL_LOCATION_ID,
    env.STAGE1_GHL_CONTACT_ID,
    env.STAGE1_GHL_PROVIDER_ID,
    env.GHL_LOCATION_ID,
    env.GHL_CUSTOM_PROVIDER_ID,
    env.WEBHOOK_SHARED_SECRET
  ]
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .sort((left, right) => right.length - left.length);

  for (const sensitiveValue of knownSensitiveValues) {
    sanitized = sanitized.split(sensitiveValue).join("[redacted]");
  }

  sanitized = sanitized
    .replace(filenamePattern, "[redacted]")
    .replace(longIdentifierPattern, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();

  if (!sanitized) {
    return undefined;
  }

  return sanitized.slice(0, maximumLength);
}

function sanitizeDiagnosticValue(value: unknown, maximumLength: number): string | undefined {
  const scalar = sanitizeDiagnosticText(value, maximumLength);

  if (scalar || !Array.isArray(value)) {
    return scalar;
  }

  const parts = value
    .slice(0, maxRejectedFields)
    .map((item) => sanitizeDiagnosticText(item, maximumLength))
    .filter((item): item is string => Boolean(item));

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("; ").slice(0, maximumLength);
}

function sanitizeRejectedField(value: unknown): string | undefined {
  const field = sanitizeDiagnosticText(value, maxRejectedFieldLength);

  if (!field || !safeFieldPattern.test(field)) {
    return undefined;
  }

  return field;
}

function appendRejectedField(
  rejectedFields: Stage1RejectedFieldDiagnostic[],
  seen: Set<string>,
  candidate: Stage1RejectedFieldDiagnostic
): void {
  if (rejectedFields.length >= maxRejectedFields) {
    return;
  }

  const key = `${candidate.field}\u0000${candidate.message ?? ""}\u0000${candidate.code ?? ""}`;

  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  rejectedFields.push(candidate);
}

function collectRejectedFields(value: unknown): Stage1RejectedFieldDiagnostic[] {
  const rejectedFields: Stage1RejectedFieldDiagnostic[] = [];
  const seen = new Set<string>();
  const queue: Array<{ value: unknown; inheritedField?: string; depth: number }> = [
    { value, depth: 0 }
  ];
  let inspectedNodes = 0;

  while (
    queue.length > 0 &&
    inspectedNodes < maxDiagnosticTraversalNodes &&
    rejectedFields.length < maxRejectedFields
  ) {
    const current = queue.shift();

    if (!current) {
      break;
    }

    inspectedNodes += 1;

    if (current.depth > maxDiagnosticTraversalDepth) {
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, maxRejectedFields)) {
        queue.push({ value: item, inheritedField: current.inheritedField, depth: current.depth + 1 });
      }
      continue;
    }

    const record = getRecord(current.value);

    if (!record) {
      const message = sanitizeDiagnosticText(current.value);

      if (current.inheritedField && message) {
        appendRejectedField(rejectedFields, seen, { field: current.inheritedField, message });
      }
      continue;
    }

    const explicitField =
      sanitizeRejectedField(record.field) ??
      sanitizeRejectedField(record.property) ??
      sanitizeRejectedField(record.path) ??
      sanitizeRejectedField(record.param);
    const field = explicitField ?? current.inheritedField;
    const message = sanitizeDiagnosticText(record.message ?? record.error);
    const code = sanitizeDiagnosticText(record.code ?? record.errorCode ?? record.type, maxDiagnosticCodeLength);

    if (field && (message || code)) {
      appendRejectedField(rejectedFields, seen, {
        field,
        ...(message ? { message } : {}),
        ...(code ? { code } : {})
      });
    }

    const constraints = getRecord(record.constraints);

    if (field && constraints) {
      for (const [constraintCode, constraintMessage] of Object.entries(constraints).slice(0, maxRejectedFields)) {
        const safeMessage = sanitizeDiagnosticText(constraintMessage);
        const safeCode = sanitizeDiagnosticText(constraintCode, maxDiagnosticCodeLength);

        if (safeMessage) {
          appendRejectedField(rejectedFields, seen, {
            field,
            message: safeMessage,
            ...(safeCode ? { code: safeCode } : {})
          });
        }
      }
    }

    for (const [key, nestedValue] of Object.entries(record).slice(0, maxRejectedFields)) {
      if (["field", "property", "path", "param", "message", "error", "code", "errorCode", "type", "constraints"].includes(key)) {
        continue;
      }

      const inheritedField =
        ["children", "validationErrors", "errors"].includes(key)
          ? field
          : sanitizeRejectedField(key) ?? field;
      queue.push({ value: nestedValue, inheritedField, depth: current.depth + 1 });
    }
  }

  return rejectedFields;
}

function findDiagnosticScalar(root: unknown, expectedKey: string): string | undefined {
  const rootRecord = getRecord(root);

  if (!rootRecord) {
    return undefined;
  }

  const records = [
    rootRecord,
    getRecord(rootRecord.error),
    getRecord(rootRecord.response)
  ].filter((item): item is Record<string, unknown> => Boolean(item));

  for (const record of records) {
    const sanitized = sanitizeDiagnosticValue(
      record[expectedKey],
      expectedKey === "code" ? maxDiagnosticCodeLength : maxDiagnosticTextLength
    );

    if (sanitized) {
      return sanitized;
    }
  }

  return undefined;
}

function findValidationContainers(root: unknown): unknown[] {
  const containers: unknown[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let inspectedNodes = 0;

  while (
    queue.length > 0 &&
    inspectedNodes < maxDiagnosticTraversalNodes &&
    containers.length < maxRejectedFields
  ) {
    const current = queue.shift();

    if (!current) {
      break;
    }

    inspectedNodes += 1;

    if (current.depth > maxDiagnosticTraversalDepth) {
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, maxRejectedFields)) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    const record = getRecord(current.value);

    if (!record) {
      continue;
    }

    for (const [key, nestedValue] of Object.entries(record).slice(0, maxRejectedFields)) {
      if (key === "validationErrors" || key === "errors") {
        containers.push(nestedValue);
      } else if (typeof nestedValue === "object" && nestedValue !== null) {
        queue.push({ value: nestedValue, depth: current.depth + 1 });
      }
    }
  }

  return containers;
}

async function readBoundedResponseBody(response: Response): Promise<{
  text: string;
  responseTruncated: boolean;
}> {
  if (!response.body) {
    return { text: "", responseTruncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let responseTruncated = false;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      const value = result.value;
      const remainingBytes = maxUpstreamErrorBytes - totalBytes;

      if (remainingBytes <= 0) {
        responseTruncated = true;
        await reader.cancel();
        break;
      }

      if (value.byteLength > remainingBytes) {
        chunks.push(value.slice(0, remainingBytes));
        totalBytes += remainingBytes;
        responseTruncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch {
    return { text: "", responseTruncated };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder().decode(body),
    responseTruncated
  };
}

async function parseUpstreamError(response: Response): Promise<Stage1UpstreamErrorDiagnostic> {
  const { text, responseTruncated } = await readBoundedResponseBody(response);
  let parsed: unknown;
  let responseParsed = false;

  if (text.trim()) {
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
      responseParsed = true;
    } catch {
      // Malformed or truncated upstream bodies are never returned verbatim.
    }
  }

  const rejectedFields: Stage1RejectedFieldDiagnostic[] = [];
  const rejectedFieldKeys = new Set<string>();

  if (responseParsed) {
    for (const container of findValidationContainers(parsed)) {
      for (const rejectedField of collectRejectedFields(container)) {
        appendRejectedField(rejectedFields, rejectedFieldKeys, rejectedField);
      }
    }
  }

  const status = responseParsed ? findDiagnosticScalar(parsed, "status") : undefined;
  const error = responseParsed ? findDiagnosticScalar(parsed, "error") : undefined;
  const message = responseParsed ? findDiagnosticScalar(parsed, "message") : undefined;
  const code = responseParsed ? findDiagnosticScalar(parsed, "code") : undefined;

  return {
    statusCode: response.status,
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    rejectedFields,
    responseParsed,
    responseTruncated
  };
}

async function parseRecognizedSmsProviders(
  response: Response,
  configuredProviderId: string
): Promise<{
  responseParsed: boolean;
  responseTruncated: boolean;
  recognizedProviders: Stage1RecognizedSmsProvider[];
}> {
  const { text, responseTruncated } = await readBoundedResponseBody(response);
  let parsed: unknown;

  if (!text.trim() || responseTruncated) {
    return { responseParsed: false, responseTruncated, recognizedProviders: [] };
  }

  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    return { responseParsed: false, responseTruncated, recognizedProviders: [] };
  }

  const conversationChannel = getRecord(getRecord(parsed)?.conversationChannel);
  const smsProviders = conversationChannel?.SMS;

  if (!Array.isArray(smsProviders)) {
    return { responseParsed: false, responseTruncated, recognizedProviders: [] };
  }

  const recognizedProviders: Stage1RecognizedSmsProvider[] = [];

  for (const entry of smsProviders.slice(0, maxRecognizedProviders)) {
    const provider = getRecord(getRecord(entry)?.conversationProvider);
    const providerId = getNonEmptyString(provider?._id);
    const name = sanitizeDiagnosticText(provider?.name, maxRejectedFieldLength);
    const type = sanitizeDiagnosticText(provider?.type, maxDiagnosticCodeLength);

    if (!providerId || !name || !type) {
      continue;
    }

    recognizedProviders.push({
      name,
      type,
      default: provider?.default === true,
      matchesConfiguredStage1Provider: providerId === configuredProviderId
    });
  }

  return { responseParsed: true, responseTruncated, recognizedProviders };
}

async function parseCreatedMessage(response: Response): Promise<{
  messageId?: string;
  conversationId?: string;
}> {
  try {
    const body: unknown = await response.json();

    return {
      messageId:
        getNestedString(body, "messageId") ??
        getNestedString(body, "data", "messageId") ??
        getNestedString(body, "message", "id"),
      conversationId:
        getNestedString(body, "conversationId") ??
        getNestedString(body, "data", "conversationId") ??
        getNestedString(body, "conversation", "id")
    };
  } catch {
    return {};
  }
}

function performRequest(path: string, init: RequestInit, auth: GhlAuthContext): Promise<Response> {
  return fetch(`${env.GHL_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Version: requireEnvValue("STAGE1_GHL_API_VERSION", env.STAGE1_GHL_API_VERSION),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {})
    }
  });
}

async function requestWithOAuthRefresh(
  locationId: string,
  path: string,
  init: RequestInit
): Promise<Response> {
  let auth = await getGhlAuthContext(locationId, { allowPrivateFallback: false });
  let response = await performRequest(path, init, auth);

  if (response.status === 401) {
    await parseUpstreamError(response);
    auth = await forceRefreshGhlAuthContext(locationId);
    response = await performRequest(path, init, auth);
  }

  return response;
}

export async function createStage1CustomMessage(
  locationId: string,
  payload: Stage1CustomMessagePayload
): Promise<Stage1GhlRequestResult> {
  const response = await requestWithOAuthRefresh(locationId, messagesEndpoint, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      upstreamError: await parseUpstreamError(response)
    };
  }

  const ids = await parseCreatedMessage(response);

  return {
    ok: true,
    statusCode: response.status,
    ...ids
  };
}

export async function createStage1InboundBootstrapMessage(
  locationId: string,
  payload: Stage1InboundBootstrapPayload
): Promise<Stage1GhlRequestResult> {
  const response = await requestWithOAuthRefresh(locationId, inboundMessagesEndpoint, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      upstreamError: await parseUpstreamError(response)
    };
  }

  const ids = await parseCreatedMessage(response);

  return {
    ok: true,
    statusCode: response.status,
    ...ids
  };
}

export async function checkStage1SmsConversationProvider(
  locationId: string,
  configuredProviderId: string
): Promise<Stage1ProviderCheckResult> {
  const path = `/locations/${encodeURIComponent(locationId)}/conversationChannels/SMS`;
  const response = await requestWithOAuthRefresh(locationId, path, {
    method: "GET",
    headers: { Version: "v3" }
  });

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      configuredProviderMatched: false,
      recognizedProviders: [],
      upstreamError: await parseUpstreamError(response)
    };
  }

  const parsed = await parseRecognizedSmsProviders(response, configuredProviderId);

  if (!parsed.responseParsed) {
    return {
      ok: false,
      statusCode: response.status,
      configuredProviderMatched: false,
      recognizedProviders: [],
      upstreamError: {
        statusCode: response.status,
        error: "Unrecognized provider response",
        code: "PROVIDER_RESPONSE_UNRECOGNIZED",
        rejectedFields: [],
        responseParsed: false,
        responseTruncated: parsed.responseTruncated
      }
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    configuredProviderMatched: parsed.recognizedProviders.some(
      (provider) => provider.matchesConfiguredStage1Provider
    ),
    recognizedProviders: parsed.recognizedProviders
  };
}

export async function updateStage1CustomMessageStatus(
  locationId: string,
  messageId: string,
  status: Stage1FinalStatus
): Promise<Stage1GhlRequestResult> {
  const response = await requestWithOAuthRefresh(
    locationId,
    `${messagesEndpoint}/${encodeURIComponent(messageId)}/status`,
    {
      method: "PUT",
      body: JSON.stringify({ status })
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      upstreamError: await parseUpstreamError(response)
    };
  }

  await discardResponseBody(response);
  return { ok: true, statusCode: response.status };
}
