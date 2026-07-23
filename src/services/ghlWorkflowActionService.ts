import crypto from "node:crypto";
import { logger } from "../config/logger";
import { env, getWorkflowProviderFirstV3TenantRollout } from "../config/env";
import {
  createWorkflowProviderMessage,
  mirrorWorkflowOutboundMessageToGhl,
  type GhlWorkflowOutboundMirrorResult
} from "../integrations/ghlWorkflowOutboundMirrorClient";
import {
  LineApiError,
  lineMaxMessagesPerPush,
  pushLineImageMessage,
  pushLineMessages,
  pushLineTextMessage,
  type LineApiErrorCategory,
  type LinePushMessage,
  type LinePushMessageResult
} from "../integrations/lineClient";
import {
  isLineChannelNotConnectedError,
  resolveLineChannelForOutbound,
  type LineChannelSelection
} from "./lineOutboundChannelService";
import {
  findLineProfileByGhlIdsForTenantIds,
  getTenantById,
  getTenantIdsByLocationId,
  type LineProfileRecord,
  saveMessageEvent
} from "./repository";
import {
  buildWorkflowLineMessage,
  WorkflowLineMessageValidationError,
  type WorkflowLineAttachmentMessage,
  type WorkflowLineMessage,
  type WorkflowLineMessageInputPresence
} from "./workflowLineMessageBuilder";
import { buildMessageLogMetadata, buildShortLogRef, hasLogValue } from "../utils/logPrivacy";

type WorkflowSendLineStatus = "sent" | "skipped" | "failed";

export type WorkflowSendLineResponse = {
  ok: boolean;
  status: WorkflowSendLineStatus;
  provider: "line";
  lineMessageId: string | null;
  error: string;
};

export type WorkflowSendLineResult = {
  httpStatus: number;
  body: WorkflowSendLineResponse;
};

export type WorkflowSendLineContext = {
  requestId?: string;
};

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getWorkflowContextString(
  payload: Record<string, unknown>,
  extras: Record<string, unknown>,
  key: "locationId" | "contactId" | "workflowId"
): string | undefined {
  return getString(extras[key]) ?? getString(payload[key]);
}

function getWorkflowActionField(payload: Record<string, unknown>, key: string): unknown {
  const data = getRecord(payload.data);
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : payload[key];
}

function buildWorkflowInputLogMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const messageType = getWorkflowActionField(payload, "messageType");
  const normalizedMessageType = typeof messageType === "string" ? messageType.trim().toLowerCase() : undefined;
  const message = getWorkflowActionField(payload, "message");

  return {
    selectedMessageType:
      messageType === undefined || messageType === null || normalizedMessageType === ""
        ? "text"
        : normalizedMessageType === "text" || normalizedMessageType === "image"
          ? normalizedMessageType
          : "invalid",
    ...buildMessageLogMetadata(message),
    originalImageUrlPresent: hasLogValue(getWorkflowActionField(payload, "originalImageUrl")),
    previewImageUrlPresent: hasLogValue(getWorkflowActionField(payload, "previewImageUrl"))
  };
}

function buildAttachmentLogMetadata(message: WorkflowLineMessage): Record<string, unknown> {
  if (message.type !== "attachments") {
    return {};
  }

  return {
    selectedMessageType: "attachments",
    textPresent: Boolean(message.text),
    ...message.attachmentSummary
  };
}

function buildWorkflowIdentifierLogContext(input: {
  requestId?: string;
  locationId?: string;
  contactId?: string;
  workflowId?: string;
  mapping?: LineProfileRecord | null;
  lineChannelId?: string | null;
  lineMessageId?: string | null;
  ghlMessageId?: string | null;
  ghlConversationId?: string | null;
}): Record<string, unknown> {
  return {
    requestId: input.requestId,
    locationIdPresent: hasLogValue(input.locationId),
    locationRef: buildShortLogRef(input.locationId),
    contactIdPresent: hasLogValue(input.contactId),
    contactRef: buildShortLogRef(input.contactId),
    workflowIdPresent: hasLogValue(input.workflowId),
    mappingFound: Boolean(input.mapping),
    tenantRef: buildShortLogRef(input.mapping?.tenant_id),
    lineUserIdPresent: hasLogValue(input.mapping?.line_user_id),
    conversationIdPresent: hasLogValue(input.ghlConversationId ?? input.mapping?.ghl_conversation_id),
    channelRef: buildShortLogRef(input.lineChannelId ?? input.mapping?.line_channel_id),
    lineMessageIdPresent: hasLogValue(input.lineMessageId),
    ghlMessageIdPresent: hasLogValue(input.ghlMessageId)
  };
}

function buildResponse(
  httpStatus: number,
  status: WorkflowSendLineStatus,
  error = "",
  lineMessageId: string | null = null
): WorkflowSendLineResult {
  return {
    httpStatus,
    body: {
      ok: status === "sent",
      status,
      provider: "line",
      lineMessageId,
      error
    }
  };
}

function buildExternalMessageId(workflowId: string | undefined, metaKey: string | undefined): string | undefined {
  if (workflowId) {
    return `workflow:${workflowId}`;
  }

  if (metaKey) {
    return `workflow-action:${metaKey}`;
  }

  return undefined;
}

function buildImageAttemptExternalMessageId(requestId: string | undefined): string | undefined {
  const normalizedRequestId = requestId?.trim();

  if (!normalizedRequestId) {
    return undefined;
  }

  const digest = crypto.createHash("sha256").update(normalizedRequestId).digest("hex").slice(0, 32);
  return `workflow-image-attempt:${digest}`;
}

function buildAttachmentAttemptExternalMessageId(requestId: string | undefined): string | undefined {
  const normalizedRequestId = requestId?.trim();

  if (!normalizedRequestId) {
    return undefined;
  }

  const digest = crypto.createHash("sha256").update(normalizedRequestId).digest("hex").slice(0, 32);
  return `workflow-attachment-attempt:${digest}`;
}

function buildImageSuccessExternalMessageId(
  result: LinePushMessageResult,
  attemptExternalMessageId: string | undefined
): string | undefined {
  if (result.messageId) {
    return `line:${result.messageId}`;
  }

  if (result.acceptedByRetryKey && result.acceptedRequestId) {
    return `line-accepted-request:${result.acceptedRequestId}`;
  }

  return attemptExternalMessageId;
}

function getSafeLineErrorMetadata(error: unknown): {
  statusCode?: number;
  lineRequestId?: string;
  category: LineApiErrorCategory | "unknown";
} {
  return error instanceof LineApiError
    ? {
        statusCode: error.statusCode,
        lineRequestId: error.lineRequestId,
        category: error.category
      }
    : { category: "unknown" };
}

function buildWorkflowEventPayload(input: {
  locationId?: string;
  contactId?: string;
  workflowId?: string;
  metaKey?: string;
  metaVersion?: string;
  messageType: WorkflowLineMessage["type"];
  inputPresence: WorkflowLineMessageInputPresence;
}): Record<string, unknown> {
  return {
    source: "ghl_workflow_action",
    locationId: input.locationId ?? null,
    contactId: input.contactId ?? null,
    workflowId: input.workflowId ?? null,
    metaKey: input.metaKey ?? null,
    metaVersion: input.metaVersion ?? null,
    messageType: input.messageType,
    messagePresent: input.inputPresence.messagePresent,
    originalImageUrlPresent: input.inputPresence.originalImageUrlPresent,
    previewImageUrlPresent: input.inputPresence.previewImageUrlPresent
  };
}

function buildSanitizedImageAuditPayload(input: {
  eventPayload: Record<string, unknown>;
  originalHostname: string;
  previewHostname: string;
}): Record<string, unknown> {
  return {
    ...input.eventPayload,
    originalImageHostname: input.originalHostname,
    previewImageHostname: input.previewHostname
  };
}

async function persistWorkflowImageAudit(input: {
  requestId?: string;
  locationId: string;
  mapping: LineProfileRecord;
  externalMessageId?: string;
  payload: Record<string, unknown>;
  status: "sent" | "failed";
  errorMessage?: string;
  requestPayload: Record<string, unknown>;
  lineResultStatus: "sent" | "failed" | "not_attempted";
  lineHttpStatusCode?: number;
}): Promise<"stored" | "failed"> {
  try {
    await saveMessageEvent({
      tenantId: input.mapping.tenant_id,
      provider: "line",
      direction: "outbound",
      externalMessageId: input.externalMessageId,
      lineUserId: input.mapping.line_user_id,
      ghlConversationId: input.mapping.ghl_conversation_id ?? undefined,
      payload: input.payload,
      status: input.status,
      errorMessage: input.errorMessage,
      requestPayload: input.requestPayload
    });

    return "stored";
  } catch {
    logger.error(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: input.requestId,
          locationId: input.locationId,
          mapping: input.mapping
        }),
        selectedMessageType: "image",
        lineResultStatus: input.lineResultStatus,
        lineHttpStatusCode: input.lineHttpStatusCode,
        auditPersistenceStatus: "failed"
      },
      "Failed to persist GHL workflow LINE image audit event"
    );

    return "failed";
  }
}

async function persistWorkflowAttachmentAudit(input: {
  requestId?: string;
  locationId: string;
  mapping: LineProfileRecord;
  externalMessageId?: string;
  payload: Record<string, unknown>;
  status: "sent" | "failed";
  errorMessage?: string;
  requestPayload: Record<string, unknown>;
  dispatchStatus: "sent" | "failed" | "partial_failure" | "not_attempted";
  lineHttpStatusCode?: number;
}): Promise<"stored" | "failed"> {
  try {
    await saveMessageEvent({
      tenantId: input.mapping.tenant_id,
      provider: "line",
      direction: "outbound",
      externalMessageId: input.externalMessageId,
      lineUserId: input.mapping.line_user_id,
      ghlConversationId: input.mapping.ghl_conversation_id ?? undefined,
      payload: input.payload,
      status: input.status,
      errorMessage: input.errorMessage,
      requestPayload: input.requestPayload
    });

    return "stored";
  } catch {
    logger.error(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: input.requestId,
          locationId: input.locationId,
          mapping: input.mapping
        }),
        selectedMessageType: "attachments",
        dispatchStatus: input.dispatchStatus,
        lineHttpStatusCode: input.lineHttpStatusCode,
        auditPersistenceStatus: "failed"
      },
      "Failed to persist GHL workflow LINE attachment audit event"
    );

    return "failed";
  }
}

function buildAttachmentLineMessages(message: WorkflowLineAttachmentMessage): LinePushMessage[] {
  const messages: LinePushMessage[] = [];

  if (message.text) {
    messages.push({ type: "text", text: message.text });
  }

  for (const attachment of message.attachments) {
    if (attachment.category === "native_image") {
      messages.push({
        type: "image",
        originalContentUrl: attachment.url,
        previewImageUrl: attachment.url
      });
      continue;
    }

    messages.push({
      type: "text",
      text: `${attachment.displayName}\n${attachment.url}`
    });
  }

  return messages;
}

function stringifyForStorage(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

function buildMirrorExternalMessageId(input: {
  externalMessageId?: string;
  lineMessageId?: string | null;
  ghlMessageId?: string;
}): string | undefined {
  if (input.ghlMessageId) {
    return input.ghlMessageId;
  }

  if (input.lineMessageId) {
    return `line:${input.lineMessageId}:ghl-mirror`;
  }

  return input.externalMessageId ? `${input.externalMessageId}:ghl-mirror` : undefined;
}

function buildProviderDispatchExternalMessageId(input: {
  externalMessageId?: string;
  ghlMessageId?: string;
}): string | undefined {
  if (input.ghlMessageId) {
    return `ghl-workflow-provider-dispatch:${input.ghlMessageId}`;
  }

  return input.externalMessageId ? `ghl-workflow-provider-dispatch:${input.externalMessageId}` : undefined;
}

function buildMirrorRequestPayload(input: {
  eventPayload: Record<string, unknown>;
  mapping: LineProfileRecord;
  workflowId?: string;
  lineMessageId?: string | null;
  mirrorResult: GhlWorkflowOutboundMirrorResult;
}) {
  return {
    ...input.eventPayload,
    source: "ghl_workflow_outbound_mirror",
    tenantId: input.mapping.tenant_id,
    lineUserId: input.mapping.line_user_id,
    workflowId: input.workflowId ?? null,
    lineMessageId: input.lineMessageId ?? null,
    existingGhlConversationId: input.mapping.ghl_conversation_id ?? null,
    endpoint: input.mirrorResult.endpoint,
    method: input.mirrorResult.method,
    authMode: input.mirrorResult.authMode,
    statusCode: input.mirrorResult.statusCode ?? null,
    canonicalCode: input.mirrorResult.canonicalCode ?? null,
    mirrorStatus: input.mirrorResult.ok ? "success" : "failed",
    request_body: input.mirrorResult.requestBody
  };
}

async function mirrorWorkflowOutboundMessage(input: {
  requestId?: string;
  payload: Record<string, unknown>;
  eventPayload: Record<string, unknown>;
  locationId: string;
  contactId: string;
  message: string;
  workflowId?: string;
  metaKey?: string;
  externalMessageId?: string;
  mapping: LineProfileRecord;
  lineMessageId?: string | null;
}): Promise<void> {
  if (!env.GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED) {
    return;
  }

  const mirrorResult = await mirrorWorkflowOutboundMessageToGhl({
    ...(input.requestId ? { requestId: input.requestId } : {}),
    locationId: input.locationId,
    contactId: input.contactId,
    message: input.message,
    workflowId: input.workflowId,
    lineMessageId: input.lineMessageId,
    existingGhlConversationId: input.mapping.ghl_conversation_id
  });
  const mirrorStatus = mirrorResult.ok ? "success" : "failed";
  const mirrorExternalMessageId = buildMirrorExternalMessageId({
    externalMessageId: input.externalMessageId,
    lineMessageId: input.lineMessageId,
    ghlMessageId: mirrorResult.ghlMessageId
  });
  const requestPayload = buildMirrorRequestPayload({
    eventPayload: input.eventPayload,
    mapping: input.mapping,
    workflowId: input.workflowId,
    lineMessageId: input.lineMessageId,
    mirrorResult
  });

  await saveMessageEvent({
    tenantId: input.mapping.tenant_id,
    provider: "ghl",
    direction: "outbound",
    externalMessageId: mirrorExternalMessageId,
    lineUserId: input.mapping.line_user_id,
    ghlMessageId: mirrorResult.ghlMessageId,
    ghlConversationId: mirrorResult.ghlConversationId ?? input.mapping.ghl_conversation_id ?? undefined,
    payload: input.payload,
    status: mirrorStatus,
    errorMessage: mirrorResult.ok ? undefined : mirrorResult.errorMessage ?? "HighLevel workflow outbound mirror failed",
    ghlStatusCode: mirrorResult.statusCode,
    ghlResponseBody: stringifyForStorage(mirrorResult.responseBody),
    requestPayload
  });

  logger.info(
    {
      ...buildWorkflowIdentifierLogContext({
        requestId: input.requestId,
        locationId: input.locationId,
        contactId: input.contactId,
        workflowId: input.workflowId,
        mapping: input.mapping,
        lineMessageId: input.lineMessageId,
        ghlMessageId: mirrorResult.ghlMessageId,
        ghlConversationId: mirrorResult.ghlConversationId
      }),
      selectedMessageType: "text",
      ...buildMessageLogMetadata(input.message),
      metaKeyPresent: hasLogValue(input.metaKey),
      mirrorExternalMessageIdPresent: hasLogValue(mirrorExternalMessageId),
      mirrorStatus,
      statusCode: mirrorResult.statusCode,
      canonicalCode: mirrorResult.canonicalCode
    },
    "Saved HighLevel workflow outbound mirror attempt"
  );
}

async function resolveLineProfileByLocationAndGhlContact(
  locationId: string,
  contactId: string,
  requestId?: string
): Promise<{ tenantIds: string[]; mapping: LineProfileRecord | null }> {
  const normalizedLocationId = locationId.trim();
  const normalizedContactId = contactId.trim();
  const tenantIds = await getTenantIdsByLocationId(normalizedLocationId);

  if (tenantIds.length === 0) {
    logger.info(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId,
          locationId: normalizedLocationId,
          contactId: normalizedContactId
        }),
        tenantCount: 0,
        mappingFound: false
      },
      "GHL workflow LINE mapping lookup completed"
    );

    return { tenantIds, mapping: null };
  }

  const mapping = await findLineProfileByGhlIdsForTenantIds(tenantIds, {
    contactId: normalizedContactId
  });

  logger.info(
    {
      ...buildWorkflowIdentifierLogContext({
        requestId,
        locationId: normalizedLocationId,
        contactId: normalizedContactId,
        mapping
      }),
      tenantCount: tenantIds.length,
      mappingFound: Boolean(mapping)
    },
    "GHL workflow LINE mapping lookup completed"
  );

  return { tenantIds, mapping };
}

async function dispatchWorkflowProviderMessage(input: {
  context: WorkflowSendLineContext;
  locationId: string;
  contactId: string;
  workflowId?: string;
  mapping: LineProfileRecord;
  message?: string;
  attachments: string[];
  eventPayload: Record<string, unknown>;
  inputLogMetadata: Record<string, unknown>;
  selectedMessageType: "text" | "attachments" | "image";
}): Promise<WorkflowSendLineResult> {
  try {
    const tenant = await getTenantById(input.mapping.tenant_id);
    const tenantLocationId = tenant?.location_id?.trim();
    const conversationProviderId = tenant?.ghl_provider_id?.trim();

    if (!tenant) {
      throw new Error("Resolved tenant was not found");
    }

    if (!tenantLocationId || tenantLocationId !== input.locationId) {
      throw new Error("Resolved tenant does not belong to the workflow locationId");
    }

    if (!conversationProviderId) {
      throw new Error("Resolved tenant has no HighLevel conversation provider");
    }

    const lineChannelSelection = await resolveLineChannelForOutbound(
      input.mapping.tenant_id,
      input.mapping
    );
    const dispatchResult = await createWorkflowProviderMessage({
      ...(input.context.requestId ? { requestId: input.context.requestId } : {}),
      locationId: input.locationId,
      contactId: input.contactId,
      conversationProviderId,
      ...(input.message ? { message: input.message } : {}),
      attachments: input.attachments,
      workflowId: input.workflowId,
      existingGhlConversationId: input.mapping.ghl_conversation_id
    });
    const dispatchStatus = dispatchResult.ok ? "success" : "failed";
    const safePayload = {
      ...input.eventPayload,
      messagePresent: Boolean(input.message),
      attachmentCount: input.attachments.length
    };
    const requestPayload = {
      ...input.eventPayload,
      source: "ghl_workflow_provider_dispatch",
      tenantId: input.mapping.tenant_id,
      lineChannelId: lineChannelSelection.lineChannelId ?? null,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      channelConnected: true,
      conversationProviderIdPresent: true,
      endpoint: dispatchResult.endpoint,
      method: dispatchResult.method,
      authMode: dispatchResult.authMode,
      statusCode: dispatchResult.statusCode ?? null,
      canonicalCode: dispatchResult.canonicalCode ?? null,
      providerDispatchStatus: dispatchStatus,
      request_body: dispatchResult.requestBody,
      messagePresent: Boolean(input.message),
      attachmentCount: input.attachments.length
    };

    let auditPersistenceStatus: "stored" | "failed" = "stored";

    try {
      await saveMessageEvent({
        tenantId: input.mapping.tenant_id,
        provider: "ghl",
        direction: "outbound",
        externalMessageId: buildProviderDispatchExternalMessageId({
          ghlMessageId: dispatchResult.ghlMessageId
        }),
        lineUserId: input.mapping.line_user_id,
        ghlMessageId: dispatchResult.ghlMessageId,
        ghlConversationId:
          dispatchResult.ghlConversationId ?? input.mapping.ghl_conversation_id ?? undefined,
        payload: safePayload,
        status: dispatchStatus,
        errorMessage: dispatchResult.ok
          ? undefined
          : dispatchResult.errorMessage ?? "HighLevel provider message dispatch failed",
        ghlStatusCode: dispatchResult.statusCode,
        ghlResponseBody: stringifyForStorage(dispatchResult.responseBody),
        requestPayload
      });
    } catch {
      auditPersistenceStatus = "failed";
      logger.error(
        {
          ...buildWorkflowIdentifierLogContext({
            requestId: input.context.requestId,
            locationId: input.locationId,
            contactId: input.contactId,
            workflowId: input.workflowId,
            mapping: input.mapping,
            ghlMessageId: dispatchResult.ghlMessageId,
            ghlConversationId: dispatchResult.ghlConversationId
          }),
          selectedMessageType: input.selectedMessageType,
          auditPersistenceStatus
        },
        "HighLevel workflow provider dispatch audit persistence failed"
      );
    }

    logger.info(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: input.context.requestId,
          locationId: input.locationId,
          contactId: input.contactId,
          workflowId: input.workflowId,
          mapping: input.mapping,
          lineChannelId: lineChannelSelection.lineChannelId,
          ghlMessageId: dispatchResult.ghlMessageId,
          ghlConversationId: dispatchResult.ghlConversationId
        }),
        ...input.inputLogMetadata,
        selectedMessageType: input.selectedMessageType,
        channelConnected: true,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        conversationProviderIdPresent: true,
        providerDispatchStatus: dispatchStatus,
        statusCode: dispatchResult.statusCode,
        mirrorResultStatus: dispatchResult.ok ? "pending" : "failed",
        auditPersistenceStatus
      },
      "HighLevel workflow provider dispatch completed"
    );

    return dispatchResult.ok
      ? buildResponse(200, "sent")
      : buildResponse(
          200,
          "failed",
          dispatchResult.errorMessage ?? "HighLevel provider message dispatch failed"
        );
  } catch (error) {
    const isDisconnected = isLineChannelNotConnectedError(error);
    const errorMessage = isDisconnected
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unknown HighLevel provider dispatch error";

    logger[isDisconnected ? "warn" : "error"](
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: input.context.requestId,
          locationId: input.locationId,
          contactId: input.contactId,
          workflowId: input.workflowId,
          mapping: input.mapping,
          lineChannelId: isDisconnected
            ? error.lineChannelId ?? input.mapping.line_channel_id
            : input.mapping.line_channel_id
        }),
        ...input.inputLogMetadata,
        selectedMessageType: input.selectedMessageType,
        channelConnected: false,
        providerDispatchStatus: "failed",
        errorPresent: true,
        errorCategory: isDisconnected ? "channel_not_connected" : "provider_dispatch"
      },
      "Failed to dispatch HighLevel workflow message through the conversation provider"
    );

    return isDisconnected
      ? buildResponse(409, "failed", errorMessage)
      : buildResponse(200, "failed", errorMessage);
  }
}

async function dispatchLegacyWorkflowProviderText(input: {
  context: WorkflowSendLineContext;
  locationId: string;
  contactId: string;
  workflowId?: string;
  externalMessageId?: string;
  mapping: LineProfileRecord;
  message: string;
  eventPayload: Record<string, unknown>;
  inputLogMetadata: Record<string, unknown>;
}): Promise<WorkflowSendLineResult> {
  try {
    const tenant = await getTenantById(input.mapping.tenant_id);
    const tenantLocationId = tenant?.location_id?.trim();
    const conversationProviderId = tenant?.ghl_provider_id?.trim();

    if (!tenant) {
      throw new Error("Resolved tenant was not found");
    }

    if (!tenantLocationId || tenantLocationId !== input.locationId) {
      throw new Error("Resolved tenant does not belong to the workflow locationId");
    }

    if (!conversationProviderId) {
      throw new Error("Resolved tenant has no HighLevel conversation provider");
    }

    const lineChannelSelection = await resolveLineChannelForOutbound(
      input.mapping.tenant_id,
      input.mapping
    );
    const dispatchResult = await mirrorWorkflowOutboundMessageToGhl({
      ...(input.context.requestId ? { requestId: input.context.requestId } : {}),
      locationId: input.locationId,
      contactId: input.contactId,
      message: input.message,
      conversationProviderId,
      workflowId: input.workflowId,
      lineMessageId: null,
      existingGhlConversationId: input.mapping.ghl_conversation_id
    });
    const dispatchStatus = dispatchResult.ok ? "success" : "failed";
    const safePayload = {
      ...input.eventPayload,
      messagePresent: true,
      messageLength: input.message.length,
      attachmentCount: 0
    };
    const requestPayload = {
      ...input.eventPayload,
      source: "ghl_workflow_provider_dispatch",
      tenantId: input.mapping.tenant_id,
      lineChannelId: lineChannelSelection.lineChannelId ?? null,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      channelConnected: true,
      conversationProviderIdPresent: true,
      endpoint: dispatchResult.endpoint,
      method: dispatchResult.method,
      authMode: dispatchResult.authMode,
      statusCode: dispatchResult.statusCode ?? null,
      canonicalCode: dispatchResult.canonicalCode ?? null,
      providerDispatchStatus: dispatchStatus,
      messagePresent: true,
      attachmentCount: 0,
      lifecycle: "provider_first_legacy"
    };

    await saveMessageEvent({
      tenantId: input.mapping.tenant_id,
      provider: "ghl",
      direction: "outbound",
      externalMessageId: buildProviderDispatchExternalMessageId({
        externalMessageId: input.externalMessageId,
        ghlMessageId: dispatchResult.ghlMessageId
      }),
      lineUserId: input.mapping.line_user_id,
      ghlMessageId: dispatchResult.ghlMessageId,
      ghlConversationId:
        dispatchResult.ghlConversationId ?? input.mapping.ghl_conversation_id ?? undefined,
      payload: safePayload,
      status: dispatchStatus,
      errorMessage: dispatchResult.ok
        ? undefined
        : dispatchResult.errorMessage ?? "HighLevel workflow provider dispatch failed",
      ghlStatusCode: dispatchResult.statusCode,
      ghlResponseBody: stringifyForStorage(dispatchResult.responseBody),
      requestPayload
    });

    logger.info(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: input.context.requestId,
          locationId: input.locationId,
          contactId: input.contactId,
          workflowId: input.workflowId,
          mapping: input.mapping,
          lineChannelId: lineChannelSelection.lineChannelId,
          ghlMessageId: dispatchResult.ghlMessageId,
          ghlConversationId: dispatchResult.ghlConversationId
        }),
        ...input.inputLogMetadata,
        selectedMessageType: "text",
        channelConnected: true,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        conversationProviderIdPresent: true,
        providerDispatchStatus: dispatchStatus,
        statusCode: dispatchResult.statusCode,
        selectedLifecycle: "provider_first_legacy"
      },
      "HighLevel legacy workflow provider dispatch completed"
    );

    return dispatchResult.ok
      ? buildResponse(200, "sent")
      : buildResponse(
          200,
          "failed",
          dispatchResult.errorMessage ?? "HighLevel provider message dispatch failed"
        );
  } catch (error) {
    const isDisconnected = isLineChannelNotConnectedError(error);
    const errorMessage = isDisconnected
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unknown HighLevel provider dispatch error";

    logger[isDisconnected ? "warn" : "error"](
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: input.context.requestId,
          locationId: input.locationId,
          contactId: input.contactId,
          workflowId: input.workflowId,
          mapping: input.mapping,
          lineChannelId: isDisconnected
            ? error.lineChannelId ?? input.mapping.line_channel_id
            : input.mapping.line_channel_id
        }),
        ...input.inputLogMetadata,
        selectedMessageType: "text",
        channelConnected: false,
        providerDispatchStatus: "failed",
        selectedLifecycle: "provider_first_legacy",
        errorPresent: true,
        errorCategory: isDisconnected ? "channel_not_connected" : "provider_dispatch"
      },
      "Failed to dispatch legacy HighLevel workflow message through the conversation provider"
    );

    return isDisconnected
      ? buildResponse(409, "failed", errorMessage)
      : buildResponse(200, "failed", errorMessage);
  }
}

async function deliverWorkflowAttachments(input: {
  context: WorkflowSendLineContext;
  locationId: string;
  contactId: string;
  workflowId?: string;
  mapping: LineProfileRecord;
  message: WorkflowLineAttachmentMessage;
  eventPayload: Record<string, unknown>;
  inputLogMetadata: Record<string, unknown>;
}): Promise<WorkflowSendLineResult> {
  const lineMessages = buildAttachmentLineMessages(input.message);
  const batchCount = Math.ceil(lineMessages.length / lineMaxMessagesPerPush);
  const attemptExternalMessageId = buildAttachmentAttemptExternalMessageId(input.context.requestId);
  const sanitizedPayload = {
    ...input.eventPayload,
    textPresent: Boolean(input.message.text),
    ...input.message.attachmentSummary
  };
  let lineChannelSelection: LineChannelSelection;

  try {
    lineChannelSelection = await resolveLineChannelForOutbound(input.mapping.tenant_id, input.mapping);
  } catch (error) {
    const isDisconnected = isLineChannelNotConnectedError(error);
    const errorMessage = isDisconnected ? error.message : "LINE attachment channel resolution failed";
    const requestPayload = {
      ...input.eventPayload,
      source: "ghl_workflow_attachments_direct",
      tenantId: input.mapping.tenant_id,
      lineChannelId: isDisconnected
        ? error.lineChannelId ?? input.mapping.line_channel_id ?? null
        : input.mapping.line_channel_id ?? null,
      channelTokenSource: isDisconnected ? error.channelTokenSource : null,
      channelConnected: false,
      channelResolutionStatus: "failed",
      dispatchStatus: "not_attempted",
      lineResultStatus: "not_attempted",
      lineHttpStatusCode: null,
      mirrorResultStatus: "unsupported",
      batchCount,
      totalMessageCount: lineMessages.length,
      sentBatchCount: 0,
      sentMessageCount: 0,
      textPresent: Boolean(input.message.text),
      ...input.message.attachmentSummary
    };
    const auditPersistenceStatus = await persistWorkflowAttachmentAudit({
      requestId: input.context.requestId,
      locationId: input.locationId,
      mapping: input.mapping,
      externalMessageId: attemptExternalMessageId,
      payload: sanitizedPayload,
      status: "failed",
      errorMessage,
      requestPayload,
      dispatchStatus: "not_attempted"
    });
    const logContext = {
      ...buildWorkflowIdentifierLogContext({
        requestId: input.context.requestId,
        locationId: input.locationId,
        contactId: input.contactId,
        workflowId: input.workflowId,
        mapping: input.mapping,
        lineChannelId: requestPayload.lineChannelId
      }),
      ...input.inputLogMetadata,
      provider: "line",
      channelResolutionStatus: "failed",
      channelConnected: false,
      channelTokenSource: requestPayload.channelTokenSource,
      dispatchStatus: "not_attempted",
      lineResultStatus: "not_attempted",
      lineHttpStatusCode: null,
      mirrorResultStatus: "unsupported",
      auditPersistenceStatus,
      errorPresent: true,
      errorCategory: isDisconnected ? "channel_not_connected" : "channel_resolution"
    };

    if (isDisconnected) {
      logger.warn(logContext, "Blocked GHL workflow LINE attachments because LINE channel is not connected");
      return buildResponse(409, "failed", errorMessage);
    }

    logger.error(logContext, "Failed to resolve LINE channel for GHL workflow attachments");
    return buildResponse(200, "failed", errorMessage);
  }

  const lineResults: LinePushMessageResult[] = [];
  let sentMessageCount = 0;

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const batch = lineMessages.slice(
      batchIndex * lineMaxMessagesPerPush,
      (batchIndex + 1) * lineMaxMessagesPerPush
    );

    try {
      const result = await pushLineMessages(
        input.mapping.line_user_id,
        batch,
        lineChannelSelection.channelAccessToken
      );
      lineResults.push(result);
      sentMessageCount += batch.length;
    } catch (error) {
      const lineError = getSafeLineErrorMetadata(error);
      const firstLineMessageId = lineResults
        .flatMap((result) => result.messageIds?.length ? result.messageIds : result.messageId ? [result.messageId] : [])
        .at(0);
      const dispatchStatus = sentMessageCount > 0 ? "partial_failure" : "failed";
      const errorMessage = sentMessageCount > 0
        ? "LINE attachment delivery partially failed"
        : "LINE attachment send failed";
      const requestPayload = {
        ...input.eventPayload,
        source: "ghl_workflow_attachments_direct",
        tenantId: input.mapping.tenant_id,
        lineChannelId: lineChannelSelection.lineChannelId ?? null,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        channelConnected: true,
        channelResolutionStatus: "success",
        dispatchStatus,
        lineResultStatus: "failed",
        lineHttpStatusCode: lineError.statusCode ?? null,
        lineErrorCategory: lineError.category,
        mirrorResultStatus: "unsupported",
        batchCount,
        totalMessageCount: lineMessages.length,
        sentBatchCount: lineResults.length,
        sentMessageCount,
        failedBatchIndex: batchIndex,
        textPresent: Boolean(input.message.text),
        ...input.message.attachmentSummary
      };
      const auditPersistenceStatus = await persistWorkflowAttachmentAudit({
        requestId: input.context.requestId,
        locationId: input.locationId,
        mapping: input.mapping,
        externalMessageId: firstLineMessageId ? `line:${firstLineMessageId}` : attemptExternalMessageId,
        payload: sanitizedPayload,
        status: "failed",
        errorMessage,
        requestPayload,
        dispatchStatus,
        lineHttpStatusCode: lineError.statusCode
      });

      logger.error(
        {
          ...buildWorkflowIdentifierLogContext({
            requestId: input.context.requestId,
            locationId: input.locationId,
            contactId: input.contactId,
            workflowId: input.workflowId,
            mapping: input.mapping,
            lineChannelId: lineChannelSelection.lineChannelId,
            lineMessageId: firstLineMessageId
          }),
          ...input.inputLogMetadata,
          provider: "line",
          channelResolutionStatus: "success",
          channelConnected: true,
          channelTokenSource: lineChannelSelection.channelTokenSource,
          dispatchStatus,
          lineResultStatus: "failed",
          lineHttpStatusCode: lineError.statusCode,
          lineRequestIdPresent: hasLogValue(lineError.lineRequestId),
          lineRequestRef: buildShortLogRef(lineError.lineRequestId),
          lineErrorCategory: lineError.category,
          mirrorResultStatus: "unsupported",
          auditPersistenceStatus,
          batchCount,
          sentBatchCount: lineResults.length,
          sentMessageCount
        },
        "LINE attachment workflow delivery failed"
      );

      return buildResponse(200, "failed", errorMessage, firstLineMessageId ?? null);
    }
  }

  const messageIds = lineResults.flatMap((result) =>
    result.messageIds?.length ? result.messageIds : result.messageId ? [result.messageId] : []
  );
  const firstLineMessageId = messageIds[0];
  const lastLineResult = lineResults.at(-1);
  const requestPayload = {
    ...input.eventPayload,
    source: "ghl_workflow_attachments_direct",
    tenantId: input.mapping.tenant_id,
    lineChannelId: lineChannelSelection.lineChannelId ?? null,
    channelTokenSource: lineChannelSelection.channelTokenSource,
    channelConnected: true,
    channelResolutionStatus: "success",
    dispatchStatus: "sent",
    lineResultStatus: "sent",
    lineHttpStatusCode: lastLineResult?.statusCode ?? null,
    mirrorResultStatus: "unsupported",
    batchCount,
    totalMessageCount: lineMessages.length,
    sentBatchCount: lineResults.length,
    sentMessageCount,
    textPresent: Boolean(input.message.text),
    ...input.message.attachmentSummary
  };
  const auditPersistenceStatus = await persistWorkflowAttachmentAudit({
    requestId: input.context.requestId,
    locationId: input.locationId,
    mapping: input.mapping,
    externalMessageId: firstLineMessageId ? `line:${firstLineMessageId}` : attemptExternalMessageId,
    payload: sanitizedPayload,
    status: "sent",
    requestPayload,
    dispatchStatus: "sent",
    lineHttpStatusCode: lastLineResult?.statusCode
  });

  logger.info(
    {
      ...buildWorkflowIdentifierLogContext({
        requestId: input.context.requestId,
        locationId: input.locationId,
        contactId: input.contactId,
        workflowId: input.workflowId,
        mapping: input.mapping,
        lineChannelId: lineChannelSelection.lineChannelId,
        lineMessageId: firstLineMessageId
      }),
      ...input.inputLogMetadata,
      provider: "line",
      channelResolutionStatus: "success",
      channelConnected: true,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      dispatchStatus: "sent",
      lineResultStatus: "sent",
      lineHttpStatusCode: lastLineResult?.statusCode,
      mirrorResultStatus: "unsupported",
      auditPersistenceStatus,
      batchCount,
      sentBatchCount: lineResults.length,
      sentMessageCount
    },
    "GHL workflow LINE attachments sent without Inbox mirroring"
  );

  return buildResponse(200, "sent", "", firstLineMessageId ?? null);
}

export async function processGhlWorkflowSendLine(
  payload: Record<string, unknown>,
  context: WorkflowSendLineContext = {}
): Promise<WorkflowSendLineResult> {
  const extras = getRecord(payload.extras);
  const meta = getRecord(payload.meta);

  const locationId = getWorkflowContextString(payload, extras, "locationId");
  const contactId = getWorkflowContextString(payload, extras, "contactId");
  const workflowId = getWorkflowContextString(payload, extras, "workflowId");
  const metaKey = getString(meta.key);
  const metaVersion = getString(meta.version);
  let inputLogMetadata = buildWorkflowInputLogMetadata(payload);
  let workflowMessage: WorkflowLineMessage;

  try {
    workflowMessage = buildWorkflowLineMessage(payload);
  } catch (error) {
    if (!(error instanceof WorkflowLineMessageValidationError)) {
      throw error;
    }

    logger.warn(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          locationId,
          contactId,
          workflowId
        }),
        ...inputLogMetadata,
        validationStatus: "failed"
      },
      "Rejected invalid GHL workflow LINE message"
    );

    return buildResponse(400, "failed", error.message);
  }

  inputLogMetadata = {
    ...inputLogMetadata,
    ...buildAttachmentLogMetadata(workflowMessage)
  };

  const eventPayload = buildWorkflowEventPayload({
    locationId,
    contactId,
    workflowId,
    metaKey,
    metaVersion,
    messageType: workflowMessage.type,
    inputPresence: workflowMessage.inputPresence
  });
  const externalMessageId = buildExternalMessageId(workflowId, metaKey);

  logger.info(
    {
      ...buildWorkflowIdentifierLogContext({
        requestId: context.requestId,
        locationId,
        contactId,
        workflowId
      }),
      ...inputLogMetadata,
      validationStatus: "accepted"
    },
    "Accepted GHL workflow LINE message input"
  );

  if (!locationId) {
    logger.warn(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          contactId,
          workflowId
        }),
        ...inputLogMetadata,
        metaKeyPresent: hasLogValue(metaKey)
      },
      "Skipped GHL workflow LINE send because locationId is missing"
    );

    return buildResponse(400, "failed", "locationId is required");
  }

  if (!contactId) {
    logger.warn(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          locationId,
          workflowId
        }),
        ...inputLogMetadata,
        metaKeyPresent: hasLogValue(metaKey)
      },
      "Skipped GHL workflow LINE send because contactId is missing"
    );

    return env.GHL_WORKFLOW_LINE_DELIVERY_MODE === "provider_first"
      ? buildResponse(400, "failed", "contactId is required")
      : buildResponse(200, "skipped", "No LINE mapping found for contact");
  }

  const { mapping } = await resolveLineProfileByLocationAndGhlContact(locationId, contactId, context.requestId);

  if (!mapping) {
    logger.warn(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          locationId,
          contactId,
          workflowId,
          mapping: null
        }),
        ...inputLogMetadata,
        metaKeyPresent: hasLogValue(metaKey)
      },
      "Skipped GHL workflow LINE send because no LINE mapping exists"
    );

    return buildResponse(200, "skipped", "No LINE mapping found for contact");
  }

  const rollout = getWorkflowProviderFirstV3TenantRollout(mapping.tenant_id);
  const useProviderFirstV3 =
    env.GHL_WORKFLOW_LINE_DELIVERY_MODE === "provider_first" && rollout.tenantAllowlisted;
  const selectedLifecycle =
    env.GHL_WORKFLOW_LINE_DELIVERY_MODE === "direct_legacy"
      ? "direct_legacy"
      : useProviderFirstV3
        ? "provider_first_v3"
        : "provider_first_legacy";

  logger.info(
    {
      ...buildWorkflowIdentifierLogContext({
        requestId: context.requestId,
        locationId,
        contactId,
        workflowId,
        mapping
      }),
      rolloutMode: env.GHL_WORKFLOW_LINE_DELIVERY_MODE,
      allowlistConfigured: rollout.allowlistConfigured,
      tenantAllowlistMatch: rollout.tenantAllowlisted,
      tenantRef: buildShortLogRef(mapping.tenant_id),
      selectedLifecycle
    },
    "Selected GHL workflow LINE delivery lifecycle"
  );

  if (workflowMessage.type === "attachments") {
    if (useProviderFirstV3) {
      return dispatchWorkflowProviderMessage({
        context,
        locationId,
        contactId,
        workflowId,
        mapping,
        message: workflowMessage.text,
        attachments: workflowMessage.attachments.map((attachment) => attachment.url),
        eventPayload,
        inputLogMetadata,
        selectedMessageType: "attachments"
      });
    }

    return deliverWorkflowAttachments({
      context,
      locationId,
      contactId,
      workflowId,
      mapping,
      message: workflowMessage,
      eventPayload,
      inputLogMetadata
    });
  }

  if (workflowMessage.type === "image") {
    const attemptExternalMessageId = buildImageAttemptExternalMessageId(context.requestId);
    const sanitizedPayload = buildSanitizedImageAuditPayload({
      eventPayload,
      originalHostname: workflowMessage.originalHostname,
      previewHostname: workflowMessage.previewHostname
    });
    let lineChannelSelection: LineChannelSelection;

    try {
      lineChannelSelection = await resolveLineChannelForOutbound(mapping.tenant_id, mapping);
    } catch (error) {
      const isDisconnected = isLineChannelNotConnectedError(error);
      const errorMessage = isDisconnected ? error.message : "LINE image channel resolution failed";
      const requestPayload = {
        ...eventPayload,
        source: "ghl_workflow_image_direct",
        tenantId: mapping.tenant_id,
        lineChannelId: isDisconnected
          ? error.lineChannelId ?? mapping.line_channel_id ?? null
          : mapping.line_channel_id ?? null,
        channelTokenSource: isDisconnected ? error.channelTokenSource : null,
        channelConnected: false,
        channelResolutionStatus: "failed",
        lineResultStatus: "not_attempted",
        lineHttpStatusCode: null,
        lineErrorCategory: "channel_resolution",
        mirrorResultStatus: "unsupported"
      };

      const auditPersistenceStatus = await persistWorkflowImageAudit({
        requestId: context.requestId,
        locationId,
        mapping,
        externalMessageId: attemptExternalMessageId,
        payload: sanitizedPayload,
        status: "failed",
        errorMessage,
        requestPayload,
        lineResultStatus: "not_attempted"
      });

      const logContext = {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          locationId,
          contactId,
          workflowId,
          mapping,
          lineChannelId: requestPayload.lineChannelId
        }),
        ...inputLogMetadata,
        channelResolutionStatus: "failed",
        channelConnected: false,
        lineResultStatus: "not_attempted",
        lineHttpStatusCode: null,
        lineErrorCategory: "channel_resolution",
        mirrorResultStatus: "unsupported",
        auditPersistenceStatus,
        channelTokenSource: requestPayload.channelTokenSource,
        errorPresent: true,
        errorCategory: isDisconnected ? "channel_not_connected" : "channel_resolution"
      };

      if (isDisconnected) {
        logger.warn(logContext, "Blocked GHL workflow LINE image because LINE channel is not connected");
        return buildResponse(409, "failed", errorMessage);
      }

      logger.error(logContext, "Failed to send GHL workflow LINE image");
      return buildResponse(200, "failed", errorMessage);
    }

    let lineResult: LinePushMessageResult;

    try {
      lineResult = await pushLineImageMessage(
        mapping.line_user_id,
        workflowMessage.originalContentUrl,
        workflowMessage.previewImageUrl,
        lineChannelSelection.channelAccessToken
      );
    } catch (error) {
      const lineError = getSafeLineErrorMetadata(error);
      const errorMessage = "LINE image send failed";
      const requestPayload = {
        ...eventPayload,
        source: "ghl_workflow_image_direct",
        tenantId: mapping.tenant_id,
        lineChannelId: lineChannelSelection.lineChannelId ?? null,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        channelConnected: true,
        channelResolutionStatus: "success",
        lineResultStatus: "failed",
        lineHttpStatusCode: lineError.statusCode ?? null,
        lineRequestId: lineError.lineRequestId ?? null,
        lineErrorCategory: lineError.category,
        mirrorResultStatus: "unsupported"
      };
      const auditPersistenceStatus = await persistWorkflowImageAudit({
        requestId: context.requestId,
        locationId,
        mapping,
        externalMessageId: attemptExternalMessageId,
        payload: sanitizedPayload,
        status: "failed",
        errorMessage,
        requestPayload,
        lineResultStatus: "failed",
        lineHttpStatusCode: lineError.statusCode
      });

      logger.error(
        {
          ...buildWorkflowIdentifierLogContext({
            requestId: context.requestId,
            locationId,
            contactId,
            workflowId,
            mapping,
            lineChannelId: lineChannelSelection.lineChannelId
          }),
          ...inputLogMetadata,
          channelResolutionStatus: "success",
          channelConnected: true,
          lineResultStatus: "failed",
          lineHttpStatusCode: lineError.statusCode,
          lineRequestIdPresent: hasLogValue(lineError.lineRequestId),
          lineRequestRef: buildShortLogRef(lineError.lineRequestId),
          lineErrorCategory: lineError.category,
          mirrorResultStatus: "unsupported",
          auditPersistenceStatus,
          channelTokenSource: lineChannelSelection.channelTokenSource
        },
        "LINE rejected or failed the GHL workflow image delivery"
      );

      return buildResponse(200, "failed", errorMessage);
    }

    const requestPayload = {
      ...eventPayload,
      source: "ghl_workflow_image_direct",
      tenantId: mapping.tenant_id,
      lineChannelId: lineChannelSelection.lineChannelId ?? null,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      channelConnected: true,
      channelResolutionStatus: "success",
      lineResultStatus: "sent",
      lineHttpStatusCode: lineResult.statusCode,
      lineRequestId: lineResult.lineRequestId ?? null,
      acceptedRequestId: lineResult.acceptedRequestId ?? null,
      acceptedByRetryKey: lineResult.acceptedByRetryKey ?? false,
      mirrorResultStatus: "unsupported"
    };
    const auditPersistenceStatus = await persistWorkflowImageAudit({
      requestId: context.requestId,
      locationId,
      mapping,
      externalMessageId: buildImageSuccessExternalMessageId(lineResult, attemptExternalMessageId),
      payload: sanitizedPayload,
      status: "sent",
      requestPayload,
      lineResultStatus: "sent",
      lineHttpStatusCode: lineResult.statusCode
    });

    logger.info(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          locationId,
          contactId,
          workflowId,
          mapping,
          lineChannelId: lineChannelSelection.lineChannelId,
          lineMessageId: lineResult.messageId
        }),
        ...inputLogMetadata,
        channelResolutionStatus: "success",
        channelConnected: true,
        lineResultStatus: "sent",
        lineHttpStatusCode: lineResult.statusCode,
        lineRequestIdPresent: hasLogValue(lineResult.lineRequestId),
        lineRequestRef: buildShortLogRef(lineResult.lineRequestId),
        mirrorResultStatus: "unsupported",
        auditPersistenceStatus,
        channelTokenSource: lineChannelSelection.channelTokenSource
      },
      "GHL workflow LINE image sent without Inbox mirroring"
    );

    return buildResponse(200, "sent", "", lineResult.messageId ?? null);
  }

  if (env.GHL_WORKFLOW_LINE_DELIVERY_MODE === "provider_first") {
    return useProviderFirstV3
      ? dispatchWorkflowProviderMessage({
          context,
          locationId,
          contactId,
          workflowId,
          mapping,
          message: workflowMessage.text,
          attachments: [],
          eventPayload,
          inputLogMetadata,
          selectedMessageType: "text"
        })
      : dispatchLegacyWorkflowProviderText({
          context,
          locationId,
          contactId,
          workflowId,
          externalMessageId,
          mapping,
          message: workflowMessage.text,
          eventPayload,
          inputLogMetadata
        });
  }

  try {
    const lineChannelSelection = await resolveLineChannelForOutbound(mapping.tenant_id, mapping);
    const requestPayload = {
      ...eventPayload,
      lineChannelId: lineChannelSelection.lineChannelId ?? null,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      channelConnected: lineChannelSelection.channelTokenSource !== "env_fallback"
    };

    logger.info(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          locationId,
          contactId,
          workflowId,
          mapping,
          lineChannelId: lineChannelSelection.lineChannelId
        }),
        ...inputLogMetadata,
        metaKeyPresent: hasLogValue(metaKey),
        channelConnected: true,
        channelTokenSource: lineChannelSelection.channelTokenSource
      },
      "Selected LINE channel token source for GHL workflow LINE send"
    );

    const lineResult = await pushLineTextMessage(
      mapping.line_user_id,
      workflowMessage.text,
      lineChannelSelection.channelAccessToken
    );

    await saveMessageEvent({
      tenantId: mapping.tenant_id,
      provider: "line",
      direction: "outbound",
      externalMessageId,
      lineUserId: mapping.line_user_id,
      ghlConversationId: mapping.ghl_conversation_id ?? undefined,
      payload,
      status: "sent",
      requestPayload
    });

    logger.info(
      {
        ...buildWorkflowIdentifierLogContext({
          requestId: context.requestId,
          locationId,
          contactId,
          workflowId,
          mapping,
          lineChannelId: lineChannelSelection.lineChannelId,
          lineMessageId: lineResult.messageId
        }),
        ...inputLogMetadata,
        metaKeyPresent: hasLogValue(metaKey),
        channelConnected: true,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        lineResultStatus: "sent",
        lineHttpStatusCode: lineResult.statusCode
      },
      "GHL workflow LINE message sent"
    );

    try {
      await mirrorWorkflowOutboundMessage({
        requestId: context.requestId,
        payload,
        eventPayload,
        locationId,
        contactId,
        message: workflowMessage.text,
        workflowId,
        metaKey,
        externalMessageId,
        mapping,
        lineMessageId: lineResult.messageId ?? null
      });
    } catch (mirrorError) {
      logger.error(
        {
          ...buildWorkflowIdentifierLogContext({
            requestId: context.requestId,
            locationId,
            contactId,
            workflowId,
            mapping,
            lineMessageId: lineResult.messageId
          }),
          ...inputLogMetadata,
          metaKeyPresent: hasLogValue(metaKey),
          mirrorStatus: "failed",
          errorPresent: true,
          errorCategory: mirrorError instanceof Error ? mirrorError.name : "unknown"
        },
        "HighLevel workflow outbound mirror failed after LINE send succeeded"
      );
    }

    return buildResponse(200, "sent", "", lineResult.messageId ?? null);
  } catch (error) {
    const isDisconnected = isLineChannelNotConnectedError(error);
    const errorMessage = isDisconnected
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unknown LINE send error";
    const requestPayload = {
      ...eventPayload,
      lineChannelId: isDisconnected
        ? error.lineChannelId ?? mapping.line_channel_id ?? null
        : mapping.line_channel_id ?? null,
      channelTokenSource: isDisconnected ? error.channelTokenSource : null,
      channelConnected: false
    };

    await saveMessageEvent({
      tenantId: mapping.tenant_id,
      provider: "line",
      direction: "outbound",
      externalMessageId,
      lineUserId: mapping.line_user_id,
      ghlConversationId: mapping.ghl_conversation_id ?? undefined,
      payload,
      status: "failed",
      errorMessage,
      requestPayload
    });

    const logContext = {
      ...buildWorkflowIdentifierLogContext({
        requestId: context.requestId,
        locationId,
        contactId,
        workflowId,
        mapping,
        lineChannelId: requestPayload.lineChannelId
      }),
      ...inputLogMetadata,
      metaKeyPresent: hasLogValue(metaKey),
      channelConnected: false,
      channelTokenSource: requestPayload.channelTokenSource,
      lineResultStatus: "failed",
      errorPresent: true,
      errorCategory: isDisconnected ? "channel_not_connected" : "line_delivery"
    };

    if (isDisconnected) {
      logger.warn(logContext, "Blocked GHL workflow LINE send because LINE channel is not connected");
      return buildResponse(409, "failed", errorMessage);
    }

    logger.error(
      {
        ...logContext
      },
      "Failed to send GHL workflow LINE message"
    );

    return buildResponse(200, "failed", errorMessage);
  }
}
