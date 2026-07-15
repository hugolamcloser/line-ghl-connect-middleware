import { Router, type RequestHandler } from "express";
import { env, getEnvPresenceReport } from "../config/env";
import { logger } from "../config/logger";
import { requireSharedSecret } from "../middleware/sharedSecret";
import {
  getGhlInboundSendAuthConfigDebug,
  getGhlProviderConfigDebug,
  testGhlInboundMessageEndpoint,
  testGhlConversationProviderAccess,
  testGhlOAuthToken
} from "../integrations/ghlClient";
import { testGhlInboundMessageAuthMatrix } from "../integrations/ghlInboundAuthMatrix";
import { getGhlInboundSendPayloadDebug, testGhlInboundSendAuth } from "../integrations/ghlInboundMessageClient";
import {
  getConfiguredLocationApiAuthMode,
  getEffectiveInboundSendAuthMode,
  testGhlContactAuth
} from "../integrations/ghlLocationClient";
import {
  getGhlTokenInstallSummary,
  testGhlInboundPayloadMatrix,
  testGhlConversationPermissions
} from "../integrations/ghlConversationPermissionTest";
import {
  getConfiguredGhlOAuthStatus,
  getConfiguredGhlOAuthTokenClaims,
  getOAuthCallbackConfig
} from "../services/ghlOAuthService";
import { getRecentDebugEvents } from "../services/repository";
import { redactSecrets } from "../utils/redaction";

export const debugRouter = Router();

type AttachmentProbeValueType = "string" | "array" | "object" | "missing";
type AttachmentProbeBroadType = "string" | "array" | "object" | "number" | "boolean" | "null" | "other";
type ExpectedProbePropertyName =
  | "locationId"
  | "contactId"
  | "workflowId"
  | "imageAttachmentProbe"
  | "imageUrlProbe";

type DiscoveredProbeField = {
  path: string;
  value: unknown;
};

const attachmentProbeMaxTopLevelKeys = 20;
const attachmentProbeMaxArrayElements = 10;
const attachmentProbeMaxTraversalDepth = 6;
const attachmentProbeMaxInspectedNodes = 100;
const safePropertyNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const expectedProbePropertyNames = new Set<ExpectedProbePropertyName>([
  "locationId",
  "contactId",
  "workflowId",
  "imageAttachmentProbe",
  "imageUrlProbe"
]);

export type WorkflowActionAttachmentProbeSummary = {
  requestId: string;
  payloadValueType: AttachmentProbeBroadType;
  payloadTopLevelKeys: string[];
  payloadTopLevelValueTypes: string[];
  locationIdPresent: boolean;
  locationIdKeyFound: boolean;
  locationIdFieldPath: string | null;
  locationIdValueType: AttachmentProbeBroadType | "missing";
  contactIdPresent: boolean;
  contactIdKeyFound: boolean;
  contactIdFieldPath: string | null;
  contactIdValueType: AttachmentProbeBroadType | "missing";
  workflowIdPresent: boolean;
  workflowIdKeyFound: boolean;
  workflowIdFieldPath: string | null;
  workflowIdValueType: AttachmentProbeBroadType | "missing";
  imageAttachmentProbePresent: boolean;
  imageAttachmentProbeKeyFound: boolean;
  imageAttachmentProbeFieldPath: string | null;
  imageAttachmentProbeValueType: AttachmentProbeBroadType | "missing";
  attachmentEntryCount: number;
  attachmentTopLevelKeys: string[];
  attachmentArrayElementTypes: string[];
  attachmentStringLooksLikeJson: boolean;
  attachmentStringDecodedType: AttachmentProbeBroadType | null;
  httpsUrlDetected: boolean;
  httpsUrlFieldPath: string | null;
  urlHostname: string | null;
  urlHasQueryParameters: boolean;
  imageUrlProbePresent: boolean;
  imageUrlProbeKeyFound: boolean;
  imageUrlProbeFieldPath: string | null;
  imageUrlProbeValueType: AttachmentProbeBroadType | "missing";
  imageUrlProbeHttps: boolean;
  imageUrlProbeHostname: string | null;
};

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length > 0;
  }

  return value !== undefined && value !== null;
}

function classifyAttachmentValue(value: unknown): AttachmentProbeValueType {
  if (typeof value === "string") {
    return "string";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  if (typeof value === "object" && value !== null) {
    return "object";
  }

  return "missing";
}

function countAttachmentEntries(value: unknown, valueType: AttachmentProbeValueType): number {
  if (valueType === "array") {
    return (value as unknown[]).length;
  }

  if (valueType === "string") {
    return (value as string).trim().length > 0 ? 1 : 0;
  }

  return valueType === "object" ? 1 : 0;
}

function getBroadType(value: unknown): AttachmentProbeBroadType {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  if (typeof value === "object") {
    return "object";
  }

  if (["string", "number", "boolean"].includes(typeof value)) {
    return typeof value as "string" | "number" | "boolean";
  }

  return "other";
}

function sanitizePropertyName(name: string, index: number): string {
  return safePropertyNamePattern.test(name) ? name : `field_${index}`;
}

function getAttachmentTopLevelKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value)
    .slice(0, attachmentProbeMaxTopLevelKeys)
    .map((key, index) => sanitizePropertyName(key, index));
}

function getAttachmentArrayElementTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, attachmentProbeMaxArrayElements).map(getBroadType);
}

function getPayloadTopLevelEntries(value: unknown): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).slice(0, attachmentProbeMaxTopLevelKeys);
}

function hasOwnProperty(record: Record<string, unknown>, propertyName: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, propertyName);
}

function discoverExpectedProbeFields(payload: unknown): Partial<Record<ExpectedProbePropertyName, DiscoveredProbeField>> {
  const payloadRecord = getRecord(payload);
  const data = getRecord(payloadRecord.data);
  const extras = getRecord(payloadRecord.extras);
  const discovered: Partial<Record<ExpectedProbePropertyName, DiscoveredProbeField>> = {};
  const canonicalFields: Array<{
    record: Record<string, unknown>;
    propertyName: ExpectedProbePropertyName;
    path: string;
  }> = [
    { record: extras, propertyName: "locationId", path: "$.extras.locationId" },
    { record: extras, propertyName: "contactId", path: "$.extras.contactId" },
    { record: extras, propertyName: "workflowId", path: "$.extras.workflowId" },
    { record: data, propertyName: "imageAttachmentProbe", path: "$.data.imageAttachmentProbe" },
    { record: data, propertyName: "imageUrlProbe", path: "$.data.imageUrlProbe" }
  ];

  for (const canonicalField of canonicalFields) {
    if (hasOwnProperty(canonicalField.record, canonicalField.propertyName)) {
      discovered[canonicalField.propertyName] = {
        path: canonicalField.path,
        value: canonicalField.record[canonicalField.propertyName]
      };
    }
  }

  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value: payload, path: "$", depth: 0 }];
  let inspected = 0;

  while (pending.length > 0 && inspected < attachmentProbeMaxInspectedNodes) {
    const candidate = pending.shift();
    if (!candidate) {
      break;
    }

    inspected += 1;

    if (candidate.depth >= attachmentProbeMaxTraversalDepth) {
      continue;
    }

    if (Array.isArray(candidate.value)) {
      candidate.value.slice(0, attachmentProbeMaxArrayElements).forEach((element, index) => {
        pending.push({
          value: element,
          path: `${candidate.path}[${index}]`,
          depth: candidate.depth + 1
        });
      });
      continue;
    }

    if (typeof candidate.value !== "object" || candidate.value === null) {
      continue;
    }

    Object.entries(candidate.value as Record<string, unknown>)
      .slice(0, attachmentProbeMaxTopLevelKeys)
      .forEach(([key, childValue], index) => {
        const safeKey = sanitizePropertyName(key, index);
        const childPath = `${candidate.path}.${safeKey}`;

        if (
          expectedProbePropertyNames.has(key as ExpectedProbePropertyName) &&
          !discovered[key as ExpectedProbePropertyName]
        ) {
          discovered[key as ExpectedProbePropertyName] = {
            path: childPath,
            value: childValue
          };
        }

        pending.push({
          value: childValue,
          path: childPath,
          depth: candidate.depth + 1
        });
      });
  }

  return discovered;
}

function getDiscoveredValueType(field: DiscoveredProbeField | undefined): AttachmentProbeBroadType | "missing" {
  return field ? getBroadType(field.value) : "missing";
}

function inspectJsonEncodedString(value: unknown): {
  looksLikeJson: boolean;
  decodedType: AttachmentProbeBroadType | null;
} {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { looksLikeJson: false, decodedType: null };
  }

  try {
    return {
      looksLikeJson: true,
      decodedType: getBroadType(JSON.parse(value))
    };
  } catch {
    return { looksLikeJson: false, decodedType: null };
  }
}

function parseHttpsUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findHttpsUrl(value: unknown): { parsed: URL; path: string } | undefined {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "$", depth: 0 }];
  let inspected = 0;

  while (pending.length > 0 && inspected < attachmentProbeMaxInspectedNodes) {
    const candidate = pending.shift();
    if (!candidate) {
      break;
    }

    inspected += 1;

    const parsed = parseHttpsUrl(candidate.value);
    if (parsed) {
      return { parsed, path: candidate.path };
    }

    if (candidate.depth >= attachmentProbeMaxTraversalDepth) {
      continue;
    }

    if (Array.isArray(candidate.value)) {
      candidate.value.slice(0, attachmentProbeMaxArrayElements).forEach((element, index) => {
        pending.push({
          value: element,
          path: `${candidate.path}[${index}]`,
          depth: candidate.depth + 1
        });
      });
      continue;
    }

    if (typeof candidate.value === "object" && candidate.value !== null) {
      Object.entries(candidate.value as Record<string, unknown>)
        .slice(0, attachmentProbeMaxTopLevelKeys)
        .forEach(([key, childValue], index) => {
          pending.push({
            value: childValue,
            path: `${candidate.path}.${sanitizePropertyName(key, index)}`,
            depth: candidate.depth + 1
          });
        });
    }
  }

  return undefined;
}

export function summarizeWorkflowActionAttachmentProbe(
  payload: unknown,
  requestId: string
): WorkflowActionAttachmentProbeSummary {
  const payloadTopLevelEntries = getPayloadTopLevelEntries(payload);
  const discovered = discoverExpectedProbeFields(payload);
  const locationIdField = discovered.locationId;
  const contactIdField = discovered.contactId;
  const workflowIdField = discovered.workflowId;
  const attachmentField = discovered.imageAttachmentProbe;
  const imageUrlField = discovered.imageUrlProbe;
  const attachmentValue = attachmentField?.value;
  const attachmentValueType = classifyAttachmentValue(attachmentValue);
  const attachmentUrl = findHttpsUrl(attachmentValue);
  const jsonString = inspectJsonEncodedString(attachmentValue);
  const imageUrlValue = imageUrlField?.value;
  const parsedImageUrl = parseHttpsUrl(imageUrlValue);

  return {
    requestId,
    payloadValueType: getBroadType(payload),
    payloadTopLevelKeys: payloadTopLevelEntries.map(([key], index) => sanitizePropertyName(key, index)),
    payloadTopLevelValueTypes: payloadTopLevelEntries.map(([, value]) => getBroadType(value)),
    locationIdPresent: hasNonEmptyValue(locationIdField?.value),
    locationIdKeyFound: Boolean(locationIdField),
    locationIdFieldPath: locationIdField?.path ?? null,
    locationIdValueType: getDiscoveredValueType(locationIdField),
    contactIdPresent: hasNonEmptyValue(contactIdField?.value),
    contactIdKeyFound: Boolean(contactIdField),
    contactIdFieldPath: contactIdField?.path ?? null,
    contactIdValueType: getDiscoveredValueType(contactIdField),
    workflowIdPresent: hasNonEmptyValue(workflowIdField?.value),
    workflowIdKeyFound: Boolean(workflowIdField),
    workflowIdFieldPath: workflowIdField?.path ?? null,
    workflowIdValueType: getDiscoveredValueType(workflowIdField),
    imageAttachmentProbePresent: hasNonEmptyValue(attachmentValue),
    imageAttachmentProbeKeyFound: Boolean(attachmentField),
    imageAttachmentProbeFieldPath: attachmentField?.path ?? null,
    imageAttachmentProbeValueType: getDiscoveredValueType(attachmentField),
    attachmentEntryCount: countAttachmentEntries(attachmentValue, attachmentValueType),
    attachmentTopLevelKeys: getAttachmentTopLevelKeys(attachmentValue),
    attachmentArrayElementTypes: getAttachmentArrayElementTypes(attachmentValue),
    attachmentStringLooksLikeJson: jsonString.looksLikeJson,
    attachmentStringDecodedType: jsonString.decodedType,
    httpsUrlDetected: Boolean(attachmentUrl),
    httpsUrlFieldPath: attachmentUrl?.path ?? null,
    urlHostname: attachmentUrl?.parsed.hostname ?? null,
    urlHasQueryParameters: Boolean(attachmentUrl?.parsed.search),
    imageUrlProbePresent: hasNonEmptyValue(imageUrlValue),
    imageUrlProbeKeyFound: Boolean(imageUrlField),
    imageUrlProbeFieldPath: imageUrlField?.path ?? null,
    imageUrlProbeValueType: getDiscoveredValueType(imageUrlField),
    imageUrlProbeHttps: Boolean(parsedImageUrl),
    imageUrlProbeHostname: parsedImageUrl?.hostname ?? null
  };
}

const requireSharedSecretInProduction: RequestHandler = (req, res, next) => {
  if (env.NODE_ENV !== "production") {
    next();
    return;
  }

  requireSharedSecret(req, res, next);
};

debugRouter.use("/debug", requireSharedSecretInProduction);

debugRouter.post("/debug/workflow-action-attachment-probe", (req, res) => {
  const requestIdValue = (req as typeof req & { id?: unknown }).id;
  const requestId =
    typeof requestIdValue === "string" || typeof requestIdValue === "number"
      ? String(requestIdValue)
      : "unavailable";
  const summary = summarizeWorkflowActionAttachmentProbe(req.body, requestId);

  logger.info(summary, "Inspected HighLevel workflow action attachment probe metadata");
  res.json(summary);
});

debugRouter.get("/debug/env-check", (_req, res) => {
  res.json({
    ok: true,
    environment: getEnvPresenceReport()
  });
});

debugRouter.get("/debug/recent-events", async (_req, res, next) => {
  try {
    const events = redactSecrets(await getRecentDebugEvents());
    res.json({
      ok: true,
      ...events
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/oauth-status", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      oauth: await getConfiguredGhlOAuthStatus()
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/oauth-token-claims", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      claims: await getConfiguredGhlOAuthTokenClaims()
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/oauth-callback-config", (_req, res) => {
  res.json({
    ok: true,
    config: getOAuthCallbackConfig()
  });
});

debugRouter.get("/debug/provider-config", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      provider: await getGhlProviderConfigDebug()
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/inbound-send-auth-config", (_req, res) => {
  const inboundSendConfig = getGhlInboundSendAuthConfigDebug();
  const inboundSendPayloadConfig = getGhlInboundSendPayloadDebug();
  const effectiveInboundSendAuthMode = getEffectiveInboundSendAuthMode();
  const contactAuthMode = getConfiguredLocationApiAuthMode();

  res.json({
    ok: true,
    config: redactSecrets({
      ...inboundSendConfig,
      ...inboundSendPayloadConfig,
      effective_inbound_send_auth_mode: effectiveInboundSendAuthMode,
      contact_auth_mode: contactAuthMode,
      token_source_selected_for_inbound_send:
        effectiveInboundSendAuthMode === "private_integration" ? "private_integration_token" : "stored_oauth_access_token",
      GHL_LOCATION_API_AUTH_MODE: contactAuthMode
    })
  });
});

debugRouter.get("/debug/ghl-token-test", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlOAuthToken())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-provider-test", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlConversationProviderAccess())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-inbound-message-endpoint-test", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlInboundMessageEndpoint())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-inbound-send-auth-test", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlInboundSendAuth())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-contact-auth-test", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlContactAuth())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-inbound-message-auth-matrix-test", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlInboundMessageAuthMatrix())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-conversation-permission-test", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlConversationPermissions())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-inbound-payload-matrix", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await testGhlInboundPayloadMatrix())
    });
  } catch (error) {
    next(error);
  }
});

debugRouter.get("/debug/ghl-token-install-summary", async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      result: redactSecrets(await getGhlTokenInstallSummary())
    });
  } catch (error) {
    next(error);
  }
});
