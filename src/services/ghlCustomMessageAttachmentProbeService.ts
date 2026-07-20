import crypto from "node:crypto";
import { isIP } from "node:net";
import { env } from "../config/env";
import { logger } from "../config/logger";
import {
  checkStage1SmsConversationProvider,
  createStage1InboundBootstrapMessage,
  createStage1CustomMessage,
  updateStage1CustomMessageStatus,
  type Stage1CustomMessagePayload,
  type Stage1FinalStatus,
  type Stage1GhlRequestResult,
  type Stage1InboundBootstrapPayload,
  type Stage1InitialStatus,
  type Stage1UpstreamErrorDiagnostic
} from "../integrations/ghlCustomMessageAttachmentProbeClient";
import { HttpError } from "../middleware/errors";
import { buildShortLogRef } from "../utils/logPrivacy";

export type Stage1ProbeCase = "A" | "B" | "C" | "D" | "E" | "F";

export type Stage1ProbeInput = {
  probeRunId: string;
  case: Stage1ProbeCase;
  initialStatus: Stage1InitialStatus;
  assetUrl?: string;
};

type BroadValueType = "string" | "number" | "boolean" | "array" | "object" | "null" | "undefined";

export type Stage1CallbackObservation = {
  callbackReceived: true;
  signatureValid: true;
  observedAt: string;
  callbackKind: "provider";
  correlationStatus: "matched_by_message_id" | "single_active_run_fallback" | "unmatched";
  topLevelKeyNames: string[];
  nestedKeyNames: string[];
  fieldTypes: Record<string, BroadValueType>;
  locationIdPresent: boolean;
  contactIdPresent: boolean;
  messageIdPresent: boolean;
  conversationIdPresent: boolean;
  messageIdRef?: string;
  messagePresent: boolean;
  messageLength: number;
  attachmentsPresent: boolean;
  attachmentArrayLength: number;
  attachmentElementTypes: BroadValueType[];
  attachmentUrlHostnames: string[];
  timingRelativeToCreateResponse: "before" | "after" | "unknown";
  timingDeltaMs: number | null;
};

type StoredObservation = Stage1CallbackObservation & {
  messageIdDigest?: string;
  observedAtMs: number;
};

type Stage1CreateAttempt = {
  messageIdDigest?: string;
  createResponseAt: string;
  createResponseAtMs: number;
};

type Stage1RunRecord = {
  probeRunId: string;
  probeRunRef: string;
  case: Stage1ProbeCase;
  startedAt: string;
  startedAtMs: number;
  attempts: Stage1CreateAttempt[];
  observations: StoredObservation[];
};

type Stage1Config = {
  locationId: string;
  contactId: string;
  providerId: string;
};

const maxUrlLength = 2_000;
const maxTopLevelKeys = 20;
const maxNestedKeys = 20;
const maxArrayElements = 10;
const maxTraversalDepth = 3;
const maxTraversalNodes = 100;
const activeRunWindowMs = 5 * 60 * 1_000;
const maxStoredRuns = 20;
const maxCreateAttemptsPerRun = 2;
const maxObservationsPerRun = 20;
const maxPendingMessageDigests = 20;
const maxPendingObservationsPerDigest = 5;
const maxUnmatchedObservations = 20;
const stage1BootstrapMessage = "Stage 1 provider-contact bootstrap";
const stage1BootstrapExternalConversationId = "stage1-provider-contact-bootstrap";
const stage1BootstrapExternalMessageId = "stage1-provider-contact-bootstrap";
const unsafeUrlCharacterPattern = /[\u0000-\u0020\u007f]/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeMessageIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
const sensitiveKeyPattern = /(authorization|cookie|credential|password|secret|signature|token)/i;
const safeKeyPattern = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;
const runs = new Map<string, Stage1RunRecord>();
const messageDigestToRunId = new Map<string, string>();
const pendingObservations = new Map<string, StoredObservation[]>();
const unmatchedObservations: StoredObservation[] = [];

function appendBounded<T>(items: T[], item: T, maximum: number): void {
  items.push(item);

  if (items.length > maximum) {
    items.splice(0, items.length - maximum);
  }
}

function removeRun(runId: string): void {
  const run = runs.get(runId);

  for (const attempt of run?.attempts ?? []) {
    if (attempt.messageIdDigest && messageDigestToRunId.get(attempt.messageIdDigest) === runId) {
      messageDigestToRunId.delete(attempt.messageIdDigest);
    }
  }

  runs.delete(runId);
}

function storeRun(run: Stage1RunRecord): void {
  if (runs.has(run.probeRunId)) {
    removeRun(run.probeRunId);
  }

  while (runs.size >= maxStoredRuns) {
    const oldestRunId = runs.keys().next().value;

    if (typeof oldestRunId !== "string") {
      break;
    }

    removeRun(oldestRunId);
  }

  runs.set(run.probeRunId, run);
}

function addUnmatchedObservation(observation: StoredObservation): void {
  appendBounded(unmatchedObservations, observation, maxUnmatchedObservations);
}

function removeUnmatchedObservation(observation: StoredObservation): void {
  const index = unmatchedObservations.indexOf(observation);

  if (index >= 0) {
    unmatchedObservations.splice(index, 1);
  }
}

function storePendingObservation(messageIdDigest: string, observation: StoredObservation): void {
  if (!pendingObservations.has(messageIdDigest)) {
    while (pendingObservations.size >= maxPendingMessageDigests) {
      const oldestDigest = pendingObservations.keys().next().value;

      if (typeof oldestDigest !== "string") {
        break;
      }

      pendingObservations.delete(oldestDigest);
    }
  }

  const stored = pendingObservations.get(messageIdDigest) ?? [];
  appendBounded(stored, observation, maxPendingObservationsPerDigest);
  pendingObservations.set(messageIdDigest, stored);
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function broadType(value: unknown): BroadValueType {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  if (typeof value === "object") {
    return "object";
  }

  if (typeof value === "string") {
    return "string";
  }

  if (typeof value === "number") {
    return "number";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  return "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeKeyName(key: string, fallbackIndex: number): string {
  return !sensitiveKeyPattern.test(key) && safeKeyPattern.test(key) ? key : `field_${fallbackIndex}`;
}

function collectKeyMetadata(payload: Record<string, unknown>): {
  topLevelKeyNames: string[];
  nestedKeyNames: string[];
  fieldTypes: Record<string, BroadValueType>;
} {
  const topLevelKeyNames: string[] = [];
  const nestedKeyNames: string[] = [];
  const fieldTypes: Record<string, BroadValueType> = {};
  const topLevelEntries = Object.entries(payload).slice(0, maxTopLevelKeys);

  for (const [index, [key, value]] of topLevelEntries.entries()) {
    const safeKey = sanitizeKeyName(key, index + 1);
    topLevelKeyNames.push(safeKey);
    fieldTypes[safeKey] = broadType(value);
  }

  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const nestedKeys = new Set<string>();
  let inspectedNodes = 0;
  let fallbackIndex = 1;

  while (queue.length > 0 && inspectedNodes < maxTraversalNodes && nestedKeys.size < maxNestedKeys) {
    const current = queue.shift();

    if (!current) {
      break;
    }

    inspectedNodes += 1;

    if (current.depth >= maxTraversalDepth) {
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, maxArrayElements)) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    if (!isRecord(current.value)) {
      continue;
    }

    for (const [key, value] of Object.entries(current.value).slice(0, maxTopLevelKeys)) {
      if (current.depth > 0) {
        nestedKeys.add(sanitizeKeyName(key, fallbackIndex));
        fallbackIndex += 1;
      }

      queue.push({ value, depth: current.depth + 1 });

      if (nestedKeys.size >= maxNestedKeys || queue.length + inspectedNodes >= maxTraversalNodes) {
        break;
      }
    }
  }

  nestedKeyNames.push(...nestedKeys);
  return { topLevelKeyNames, nestedKeyNames, fieldTypes };
}

function findExpectedValue(payload: Record<string, unknown>, expectedKey: string): unknown {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  let inspectedNodes = 0;

  while (queue.length > 0 && inspectedNodes < maxTraversalNodes) {
    const current = queue.shift();

    if (!current) {
      break;
    }

    inspectedNodes += 1;

    if (current.depth > maxTraversalDepth) {
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, maxArrayElements)) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    if (!isRecord(current.value)) {
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(current.value, expectedKey)) {
      return current.value[expectedKey];
    }

    for (const value of Object.values(current.value).slice(0, maxTopLevelKeys)) {
      queue.push({ value, depth: current.depth + 1 });
    }
  }

  return undefined;
}

function hasValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

function getAttachmentHostnames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const hostnames = new Set<string>();

  for (const item of value.slice(0, maxArrayElements)) {
    const candidates: unknown[] = [item];

    if (isRecord(item)) {
      candidates.push(item.url, item.attachmentUrl);
    }

    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }

      try {
        const parsed = new URL(candidate);

        if (parsed.hostname) {
          hostnames.add(parsed.hostname.toLowerCase());
        }
      } catch {
        // Invalid attachment values are represented only by broad type metadata.
      }
    }
  }

  return [...hostnames].slice(0, maxArrayElements);
}

function getTiming(
  observation: StoredObservation,
  attempt: Stage1CreateAttempt | undefined
): Pick<Stage1CallbackObservation, "timingRelativeToCreateResponse" | "timingDeltaMs"> {
  if (!attempt) {
    return { timingRelativeToCreateResponse: "unknown", timingDeltaMs: null };
  }

  const timingDeltaMs = observation.observedAtMs - attempt.createResponseAtMs;
  return {
    timingRelativeToCreateResponse: timingDeltaMs < 0 ? "before" : "after",
    timingDeltaMs
  };
}

function attachObservationToRun(
  observation: StoredObservation,
  run: Stage1RunRecord,
  correlationStatus: Stage1CallbackObservation["correlationStatus"]
): void {
  const attempt = observation.messageIdDigest
    ? run.attempts.find((item) => item.messageIdDigest === observation.messageIdDigest)
    : run.attempts.at(-1);
  const timing = getTiming(observation, attempt);
  appendBounded(
    run.observations,
    { ...observation, ...timing, correlationStatus },
    maxObservationsPerRun
  );
}

function registerCreateResult(run: Stage1RunRecord, result: Stage1GhlRequestResult): void {
  const createResponseAtMs = Date.now();
  const messageIdDigest = result.messageId ? digest(result.messageId) : undefined;
  const attempt: Stage1CreateAttempt = {
    messageIdDigest,
    createResponseAt: new Date(createResponseAtMs).toISOString(),
    createResponseAtMs
  };
  appendBounded(run.attempts, attempt, maxCreateAttemptsPerRun);

  if (!messageIdDigest) {
    return;
  }

  messageDigestToRunId.set(messageIdDigest, run.probeRunId);

  for (const observation of pendingObservations.get(messageIdDigest) ?? []) {
    removeUnmatchedObservation(observation);
    attachObservationToRun(observation, run, "matched_by_message_id");
  }

  pendingObservations.delete(messageIdDigest);
}

export function requireStage1Config(): Stage1Config {
  const locationId = env.STAGE1_GHL_LOCATION_ID.trim();
  const contactId = env.STAGE1_GHL_CONTACT_ID.trim();
  const providerId = env.STAGE1_GHL_PROVIDER_ID.trim();

  if (!locationId || !contactId || !providerId) {
    throw new HttpError(503, "Stage 1 HighLevel probe configuration is incomplete");
  }

  if (env.GHL_CUSTOM_PROVIDER_ID.trim() && providerId === env.GHL_CUSTOM_PROVIDER_ID.trim()) {
    throw new HttpError(503, "Stage 1 provider must be isolated from the configured production provider");
  }

  if (env.GHL_LOCATION_ID.trim() && locationId === env.GHL_LOCATION_ID.trim()) {
    throw new HttpError(503, "Stage 1 location must be isolated from the configured production location");
  }

  return { locationId, contactId, providerId };
}

export function validateStage1ProbeRunId(value: string): string {
  if (!uuidPattern.test(value)) {
    throw new HttpError(400, "probeRunId must be a UUID");
  }

  return value;
}

export function validateStage1AssetUrl(value: string | undefined): string {
  if (!value) {
    throw new HttpError(400, "assetUrl is required for this Stage 1 probe case");
  }

  if (value.length > maxUrlLength) {
    throw new HttpError(400, `assetUrl must be ${maxUrlLength} characters or fewer`);
  }

  if (unsafeUrlCharacterPattern.test(value)) {
    throw new HttpError(400, "assetUrl must be percent-encoded and must not contain whitespace");
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, "assetUrl must be a valid absolute HTTPS URL");
  }

  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "assetUrl must use HTTPS");
  }

  if (parsed.username || parsed.password) {
    throw new HttpError(400, "assetUrl must not contain credentials");
  }

  const hostname = parsed.hostname.toLowerCase();
  const ipCandidate = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (hostname === "localhost" || hostname.endsWith(".localhost") || isIP(ipCandidate) !== 0) {
    throw new HttpError(400, "assetUrl must use a public hostname and not a literal IP address");
  }

  return value;
}

function buildPayload(
  input: Stage1ProbeInput,
  config: Stage1Config
): Stage1CustomMessagePayload {
  const base: Stage1CustomMessagePayload = {
    type: "Custom",
    contactId: config.contactId,
    conversationProviderId: config.providerId,
    status: input.initialStatus
  };

  if (input.case === "A") {
    return { ...base, message: `Stage 1 A ${input.probeRunId}` };
  }

  const assetUrl = validateStage1AssetUrl(input.assetUrl);

  if (input.case === "C" || input.case === "F") {
    return {
      ...base,
      message: `Stage 1 C ${input.probeRunId}`,
      attachments: [assetUrl]
    };
  }

  return { ...base, attachments: [assetUrl] };
}

function toSafeCreateResult(result: Stage1GhlRequestResult) {
  return {
    highLevelHttpStatus: result.statusCode,
    messageIdPresent: Boolean(result.messageId),
    ...(result.messageId ? { messageId: result.messageId } : {}),
    conversationIdPresent: Boolean(result.conversationId),
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    ...(result.upstreamError ? { upstreamError: result.upstreamError } : {})
  };
}

function toSafeUpstreamErrorLog(error: Stage1UpstreamErrorDiagnostic | undefined) {
  if (!error) {
    return undefined;
  }

  return {
    statusCode: error.statusCode,
    responseParsed: error.responseParsed,
    responseTruncated: error.responseTruncated,
    errorCategory: error.rejectedFields.length > 0 ? "validation_error" : "upstream_error",
    ...(error.code ? { errorCode: error.code } : {}),
    rejectedFields: error.rejectedFields.map((item) => item.field)
  };
}

function toSafeProviderCheckErrorLog(error: Stage1UpstreamErrorDiagnostic | undefined) {
  if (!error) {
    return undefined;
  }

  return {
    errorCategory: error.rejectedFields.length > 0 ? "validation_error" : "upstream_error",
    ...(error.code ? { errorCode: error.code } : {})
  };
}

export async function checkStage1SmsProviderVisibility() {
  const config = requireStage1Config();
  const result = await checkStage1SmsConversationProvider(config.locationId, config.providerId);
  const recognizedProviders = result.recognizedProviders.map((provider) => ({
    name: provider.name,
    type: provider.type,
    default: provider.default,
    matchesConfiguredStage1Provider: provider.matchesConfiguredStage1Provider
  }));

  logger.info(
    {
      highLevelHttpStatus: result.statusCode,
      recognizedSmsProviderCount: recognizedProviders.length,
      configuredProviderMatched: result.configuredProviderMatched,
      providerNames: recognizedProviders.map((provider) => provider.name),
      providerTypes: recognizedProviders.map((provider) => provider.type),
      providerDefaultFlags: recognizedProviders.map((provider) => provider.default),
      upstreamError: toSafeProviderCheckErrorLog(result.upstreamError)
    },
    "Stage 1 SMS conversation-provider visibility check completed"
  );

  return {
    ok: result.ok,
    highLevelHttpStatus: result.statusCode,
    configuredProviderMatched: result.configuredProviderMatched,
    configuredProviderExpectedType: "SMS" as const,
    recognizedSmsProviderCount: recognizedProviders.length,
    recognizedProviders,
    ...(result.upstreamError ? { upstreamError: result.upstreamError } : {})
  };
}

export async function bootstrapStage1ProviderContact() {
  const config = requireStage1Config();
  const payload: Stage1InboundBootstrapPayload = {
    locationId: config.locationId,
    contactId: config.contactId,
    conversationProviderId: config.providerId,
    externalConversationId: stage1BootstrapExternalConversationId,
    externalMessageId: stage1BootstrapExternalMessageId,
    type: "SMS",
    message: stage1BootstrapMessage
  };
  const result = await createStage1InboundBootstrapMessage(config.locationId, payload);

  logger.info(
    {
      stage1Bootstrap: true,
      locationIdPresent: true,
      contactIdPresent: true,
      conversationProviderIdPresent: true,
      messagePresent: true,
      messageLength: stage1BootstrapMessage.length,
      highLevelHttpStatus: result.statusCode,
      messageIdPresent: Boolean(result.messageId),
      conversationIdPresent: Boolean(result.conversationId),
      upstreamError: toSafeUpstreamErrorLog(result.upstreamError),
      dispatchStatus: result.ok ? "success" : "failed",
      lineDeliveryAttempted: false
    },
    "Stage 1 provider-contact association probe completed"
  );

  return {
    ok: result.ok,
    highLevelHttpStatus: result.statusCode,
    messageIdPresent: Boolean(result.messageId),
    conversationIdPresent: Boolean(result.conversationId),
    ...(result.upstreamError ? { upstreamError: result.upstreamError } : {})
  };
}

export async function runStage1CustomMessageProbe(input: Stage1ProbeInput) {
  const config = requireStage1Config();
  const probeRunId = validateStage1ProbeRunId(input.probeRunId);
  const payload = buildPayload(input, config);
  const createRequestCount = input.case === "F" ? 2 : 1;
  const startedAtMs = Date.now();
  const run: Stage1RunRecord = {
    probeRunId,
    probeRunRef: digest(probeRunId).slice(0, 12),
    case: input.case,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    attempts: [],
    observations: []
  };
  storeRun(run);
  const results: Stage1GhlRequestResult[] = [];

  for (let attempt = 0; attempt < createRequestCount; attempt += 1) {
    const result = await createStage1CustomMessage(config.locationId, payload);
    results.push(result);
    registerCreateResult(run, result);
  }

  logger.info(
    {
      probeRunRef: run.probeRunRef,
      probeCase: input.case,
      initialStatus: input.initialStatus,
      assetUrlPresent: Boolean(input.assetUrl),
      assetHostname:
        input.case !== "A" && input.assetUrl
          ? new URL(input.assetUrl).hostname.toLowerCase()
          : undefined,
      createRequestCount,
      highLevelHttpStatuses: results.map((result) => result.statusCode),
      highLevelMessageIdPresent: results.map((result) => Boolean(result.messageId)),
      highLevelConversationIdPresent: results.map((result) => Boolean(result.conversationId)),
      upstreamErrors: results.map((result) => toSafeUpstreamErrorLog(result.upstreamError)),
      dispatchStatus: results.every((result) => result.ok) ? "success" : "failed"
    },
    "Stage 1 HighLevel Custom message probe completed"
  );

  return {
    ok: results.every((result) => result.ok),
    case: input.case,
    initialStatus: input.initialStatus,
    results: results.map(toSafeCreateResult),
    createRequestCount,
    callbackObservationRequired: true,
    inboxObservationRequired: true,
    statusUpdateRequired: input.initialStatus === "pending"
  };
}

export async function updateStage1MessageStatus(messageId: string, status: Stage1FinalStatus) {
  const config = requireStage1Config();

  if (!safeMessageIdPattern.test(messageId)) {
    throw new HttpError(400, "Invalid HighLevel message ID");
  }

  const result = await updateStage1CustomMessageStatus(config.locationId, messageId, status);

  logger.info(
    {
      messageIdPresent: true,
      messageIdRef: buildShortLogRef(messageId),
      requestedStatus: status,
      highLevelHttpStatus: result.statusCode,
      upstreamError: toSafeUpstreamErrorLog(result.upstreamError),
      dispatchStatus: result.ok ? "success" : "failed"
    },
    "Stage 1 HighLevel message status update completed"
  );

  return {
    ok: result.ok,
    status,
    highLevelHttpStatus: result.statusCode,
    messageIdPresent: true
  };
}

export function recordStage1Callback(payload: Record<string, unknown>): {
  callbackKind: "provider";
  correlationStatus: Stage1CallbackObservation["correlationStatus"];
  messageIdPresent: boolean;
  messageIdRef?: string;
  probeRunRef?: string;
  providerCallbackCount: number;
  genericOutboundObservationConfigured: false;
  genericOutboundCallbackCount: null;
} {
  requireStage1Config();
  const now = Date.now();
  const messageId = findExpectedValue(payload, "messageId");
  const messageIdString = typeof messageId === "string" && messageId.trim() ? messageId : undefined;
  const messageIdDigest = messageIdString ? digest(messageIdString) : undefined;
  const message = findExpectedValue(payload, "message");
  const attachments = findExpectedValue(payload, "attachments");
  const callbackKind = "provider" as const;
  const keyMetadata = collectKeyMetadata(payload);
  const elementTypes = Array.isArray(attachments)
    ? [...new Set(attachments.slice(0, maxArrayElements).map(broadType))]
    : [];
  const observation: StoredObservation = {
    callbackReceived: true,
    signatureValid: true,
    observedAt: new Date(now).toISOString(),
    observedAtMs: now,
    callbackKind,
    correlationStatus: "unmatched",
    ...keyMetadata,
    locationIdPresent: hasValue(findExpectedValue(payload, "locationId")),
    contactIdPresent: hasValue(findExpectedValue(payload, "contactId")),
    messageIdPresent: Boolean(messageIdString),
    conversationIdPresent: hasValue(findExpectedValue(payload, "conversationId")),
    ...(messageIdString ? { messageIdRef: digest(messageIdString).slice(0, 12), messageIdDigest } : {}),
    messagePresent: typeof message === "string" && message.trim().length > 0,
    messageLength: typeof message === "string" ? message.length : 0,
    attachmentsPresent: attachments !== undefined && attachments !== null,
    attachmentArrayLength: Array.isArray(attachments) ? attachments.length : 0,
    attachmentElementTypes: elementTypes,
    attachmentUrlHostnames: getAttachmentHostnames(attachments),
    timingRelativeToCreateResponse: "unknown",
    timingDeltaMs: null
  };
  const runId = messageIdDigest ? messageDigestToRunId.get(messageIdDigest) : undefined;
  let run = runId ? runs.get(runId) : undefined;
  let correlationStatus: Stage1CallbackObservation["correlationStatus"] = "unmatched";

  if (run) {
    correlationStatus = "matched_by_message_id";
    attachObservationToRun(observation, run, correlationStatus);
  } else if (messageIdDigest) {
    addUnmatchedObservation(observation);
    storePendingObservation(messageIdDigest, observation);
  } else {
    const activeRuns = [...runs.values()].filter(
      (candidate) => now - candidate.startedAtMs >= 0 && now - candidate.startedAtMs <= activeRunWindowMs
    );

    if (activeRuns.length === 1) {
      [run] = activeRuns;
      correlationStatus = "single_active_run_fallback";
      attachObservationToRun(observation, run, correlationStatus);
    } else {
      addUnmatchedObservation(observation);
    }
  }

  const providerCallbackCount = run ? run.observations.length : 0;

  return {
    callbackKind,
    correlationStatus,
    messageIdPresent: Boolean(messageIdString),
    ...(messageIdString ? { messageIdRef: digest(messageIdString).slice(0, 12) } : {}),
    ...(run ? { probeRunRef: run.probeRunRef } : {}),
    providerCallbackCount,
    genericOutboundObservationConfigured: false,
    genericOutboundCallbackCount: null
  };
}

function toSafeObservation(observation: StoredObservation): Stage1CallbackObservation {
  const {
    messageIdDigest: _messageIdDigest,
    observedAtMs: _observedAtMs,
    ...safeObservation
  } = observation;
  return safeObservation;
}

export function getStage1ProbeObservations(probeRunId: string) {
  requireStage1Config();
  validateStage1ProbeRunId(probeRunId);
  const run = runs.get(probeRunId);

  if (!run) {
    throw new HttpError(404, "Stage 1 probe run was not found in this process");
  }

  const observations = run.observations.map(toSafeObservation);
  const safeUnmatchedObservations = unmatchedObservations.map(toSafeObservation);

  return {
    ok: true,
    probeRunId,
    case: run.case,
    startedAt: run.startedAt,
    createRequestCount: run.attempts.length,
    providerCallbackCount: observations.length,
    genericOutboundObservationConfigured: false,
    genericOutboundCallbackCount: null,
    genericOutboundObservationStatus: "not_observed" as const,
    unmatchedCallbackCount: safeUnmatchedObservations.length,
    unmatchedObservations: safeUnmatchedObservations,
    observations
  };
}

export function resetStage1ProbeStateForTests(): void {
  runs.clear();
  messageDigestToRunId.clear();
  pendingObservations.clear();
  unmatchedObservations.splice(0, unmatchedObservations.length);
}
