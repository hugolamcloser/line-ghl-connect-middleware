import crypto from "node:crypto";
import { logger } from "../config/logger";
import { env } from "../config/env";
import {
  mirrorWorkflowOutboundMessageToGhl,
  type GhlWorkflowOutboundMirrorResult
} from "../integrations/ghlWorkflowOutboundMirrorClient";
import {
  LineApiError,
  pushLineImageMessage,
  pushLineTextMessage,
  type LineApiErrorCategory,
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
  type WorkflowLineMessage,
  type WorkflowLineMessageInputPresence
} from "./workflowLineMessageBuilder";

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
        requestId: input.requestId,
        locationId: input.locationId,
        tenantId: input.mapping.tenant_id,
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
      locationId: input.locationId,
      contactId: input.contactId,
      tenantId: input.mapping.tenant_id,
      lineUserId: input.mapping.line_user_id,
      workflowId: input.workflowId,
      metaKey: input.metaKey,
      mirrorExternalMessageId,
      lineMessageId: input.lineMessageId,
      ghlConversationId: mirrorResult.ghlConversationId ?? input.mapping.ghl_conversation_id,
      ghlMessageId: mirrorResult.ghlMessageId,
      mirrorStatus,
      statusCode: mirrorResult.statusCode,
      canonicalCode: mirrorResult.canonicalCode
    },
    "Saved HighLevel workflow outbound mirror attempt"
  );
}

async function resolveLineProfileByLocationAndGhlContact(
  locationId: string,
  contactId: string
): Promise<{ tenantIds: string[]; mapping: LineProfileRecord | null }> {
  const normalizedLocationId = locationId.trim();
  const normalizedContactId = contactId.trim();
  const tenantIds = await getTenantIdsByLocationId(normalizedLocationId);

  if (tenantIds.length === 0) {
    logger.info(
      {
        locationId: normalizedLocationId,
        contactId: normalizedContactId,
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
      locationId: normalizedLocationId,
      contactId: normalizedContactId,
      tenantCount: tenantIds.length,
      mappingFound: Boolean(mapping),
      foundTenantId: mapping?.tenant_id,
      foundLineUserId: mapping?.line_user_id,
      foundGhlConversationId: mapping?.ghl_conversation_id
    },
    "GHL workflow LINE mapping lookup completed"
  );

  return { tenantIds, mapping };
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
  let workflowMessage: WorkflowLineMessage;

  try {
    workflowMessage = buildWorkflowLineMessage(payload);
  } catch (error) {
    if (!(error instanceof WorkflowLineMessageValidationError)) {
      throw error;
    }

    logger.warn(
      {
        requestId: context.requestId,
        locationId,
        selectedMessageType: "invalid",
        validationStatus: "failed"
      },
      "Rejected invalid GHL workflow LINE message"
    );

    return buildResponse(400, "failed", error.message);
  }

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
      requestId: context.requestId,
      locationId,
      selectedMessageType: workflowMessage.type,
      messagePresent: workflowMessage.inputPresence.messagePresent,
      originalImageUrlPresent: workflowMessage.inputPresence.originalImageUrlPresent,
      previewImageUrlPresent: workflowMessage.inputPresence.previewImageUrlPresent
    },
    "Accepted GHL workflow LINE message input"
  );

  if (!locationId) {
    logger.warn(
      {
        contactId,
        workflowId,
        metaKey
      },
      "Skipped GHL workflow LINE send because locationId is missing"
    );

    return buildResponse(400, "failed", "locationId is required");
  }

  if (!contactId) {
    logger.warn(
      {
        locationId,
        workflowId,
        metaKey
      },
      "Skipped GHL workflow LINE send because contactId is missing"
    );

    return env.GHL_WORKFLOW_LINE_DELIVERY_MODE === "provider_first"
      ? buildResponse(400, "failed", "contactId is required")
      : buildResponse(200, "skipped", "No LINE mapping found for contact");
  }

  const { mapping } = await resolveLineProfileByLocationAndGhlContact(locationId, contactId);

  if (!mapping) {
    logger.warn(
      {
        locationId,
        contactId,
        workflowId,
        metaKey
      },
      "Skipped GHL workflow LINE send because no LINE mapping exists"
    );

    return buildResponse(200, "skipped", "No LINE mapping found for contact");
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
        requestId: context.requestId,
        locationId,
        tenantId: mapping.tenant_id,
        selectedMessageType: workflowMessage.type,
        originalImageUrlPresent: workflowMessage.inputPresence.originalImageUrlPresent,
        previewImageUrlPresent: workflowMessage.inputPresence.previewImageUrlPresent,
        channelResolutionStatus: "failed",
        lineResultStatus: "not_attempted",
        lineHttpStatusCode: null,
        lineErrorCategory: "channel_resolution",
        mirrorResultStatus: "unsupported",
        auditPersistenceStatus,
        lineChannelId: requestPayload.lineChannelId,
        channelTokenSource: requestPayload.channelTokenSource,
        errorMessage
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
          requestId: context.requestId,
          locationId,
          tenantId: mapping.tenant_id,
          selectedMessageType: workflowMessage.type,
          originalImageUrlPresent: workflowMessage.inputPresence.originalImageUrlPresent,
          previewImageUrlPresent: workflowMessage.inputPresence.previewImageUrlPresent,
          channelResolutionStatus: "success",
          channelConnected: true,
          lineResultStatus: "failed",
          lineHttpStatusCode: lineError.statusCode,
          lineRequestId: lineError.lineRequestId,
          lineErrorCategory: lineError.category,
          mirrorResultStatus: "unsupported",
          auditPersistenceStatus,
          lineChannelId: lineChannelSelection.lineChannelId,
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
        requestId: context.requestId,
        locationId,
        tenantId: mapping.tenant_id,
        selectedMessageType: workflowMessage.type,
        originalImageUrlPresent: workflowMessage.inputPresence.originalImageUrlPresent,
        previewImageUrlPresent: workflowMessage.inputPresence.previewImageUrlPresent,
        channelResolutionStatus: "success",
        channelConnected: true,
        lineResultStatus: "sent",
        lineHttpStatusCode: lineResult.statusCode,
        lineRequestId: lineResult.lineRequestId,
        mirrorResultStatus: "unsupported",
        auditPersistenceStatus,
        lineChannelId: lineChannelSelection.lineChannelId,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        lineMessageId: lineResult.messageId
      },
      "GHL workflow LINE image sent without Inbox mirroring"
    );

    return buildResponse(200, "sent", "", lineResult.messageId ?? null);
  }

  if (env.GHL_WORKFLOW_LINE_DELIVERY_MODE === "provider_first") {
    try {
      const tenant = await getTenantById(mapping.tenant_id);
      const tenantLocationId = tenant?.location_id?.trim();
      const conversationProviderId = tenant?.ghl_provider_id?.trim();

      if (!tenant) {
        throw new Error(`Tenant ${mapping.tenant_id} was not found`);
      }

      if (!tenantLocationId || tenantLocationId !== locationId) {
        throw new Error("Resolved tenant does not belong to the workflow locationId");
      }

      if (!conversationProviderId) {
        throw new Error(`Tenant ${mapping.tenant_id} has no ghl_provider_id`);
      }

      const lineChannelSelection = await resolveLineChannelForOutbound(mapping.tenant_id, mapping);
      const dispatchResult = await mirrorWorkflowOutboundMessageToGhl({
        locationId,
        contactId,
        message: workflowMessage.text,
        conversationProviderId,
        workflowId,
        lineMessageId: null,
        existingGhlConversationId: mapping.ghl_conversation_id
      });
      const dispatchStatus = dispatchResult.ok ? "success" : "failed";
      const requestPayload = {
        ...eventPayload,
        source: "ghl_workflow_provider_dispatch",
        tenantId: mapping.tenant_id,
        lineUserId: mapping.line_user_id,
        existingGhlConversationId: mapping.ghl_conversation_id ?? null,
        lineChannelId: lineChannelSelection.lineChannelId ?? null,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        channelConnected: true,
        conversationProviderId,
        endpoint: dispatchResult.endpoint,
        method: dispatchResult.method,
        authMode: dispatchResult.authMode,
        statusCode: dispatchResult.statusCode ?? null,
        canonicalCode: dispatchResult.canonicalCode ?? null,
        dispatchStatus,
        request_body: dispatchResult.requestBody
      };

      await saveMessageEvent({
        tenantId: mapping.tenant_id,
        provider: "ghl",
        direction: "outbound",
        externalMessageId: buildProviderDispatchExternalMessageId({
          externalMessageId,
          ghlMessageId: dispatchResult.ghlMessageId
        }),
        lineUserId: mapping.line_user_id,
        ghlMessageId: dispatchResult.ghlMessageId,
        ghlConversationId: dispatchResult.ghlConversationId ?? mapping.ghl_conversation_id ?? undefined,
        payload,
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
          locationId,
          contactId,
          workflowId,
          metaKey,
          tenantId: mapping.tenant_id,
          lineUserId: mapping.line_user_id,
          lineChannelId: lineChannelSelection.lineChannelId,
          channelTokenSource: lineChannelSelection.channelTokenSource,
          ghlConversationId: dispatchResult.ghlConversationId ?? mapping.ghl_conversation_id,
          ghlMessageId: dispatchResult.ghlMessageId,
          dispatchStatus,
          statusCode: dispatchResult.statusCode
        },
        "HighLevel workflow provider dispatch completed"
      );

      return dispatchResult.ok
        ? buildResponse(200, "sent")
        : buildResponse(200, "failed", dispatchResult.errorMessage ?? "HighLevel workflow provider dispatch failed");
    } catch (error) {
      const isDisconnected = isLineChannelNotConnectedError(error);
      const errorMessage = error instanceof Error ? error.message : "Unknown HighLevel provider dispatch error";
      const requestPayload = {
        ...eventPayload,
        source: "ghl_workflow_provider_dispatch",
        tenantId: mapping.tenant_id,
        lineUserId: mapping.line_user_id,
        existingGhlConversationId: mapping.ghl_conversation_id ?? null,
        lineChannelId: isDisconnected
          ? error.lineChannelId ?? mapping.line_channel_id ?? null
          : mapping.line_channel_id ?? null,
        channelTokenSource: isDisconnected ? error.channelTokenSource : null,
        channelConnected: false,
        dispatchStatus: "failed"
      };

      await saveMessageEvent({
        tenantId: mapping.tenant_id,
        provider: "ghl",
        direction: "outbound",
        externalMessageId: buildProviderDispatchExternalMessageId({ externalMessageId }),
        lineUserId: mapping.line_user_id,
        ghlConversationId: mapping.ghl_conversation_id ?? undefined,
        payload,
        status: "failed",
        errorMessage,
        requestPayload
      });

      const logContext = {
        locationId,
        contactId,
        workflowId,
        metaKey,
        tenantId: mapping.tenant_id,
        lineUserId: mapping.line_user_id,
        lineChannelId: requestPayload.lineChannelId,
        channelTokenSource: requestPayload.channelTokenSource,
        errorMessage
      };

      if (isDisconnected) {
        logger.warn(logContext, "Blocked HighLevel workflow provider dispatch because LINE channel is not connected");
        return buildResponse(409, "failed", errorMessage);
      }

      logger.error(logContext, "Failed to dispatch HighLevel workflow message through the conversation provider");
      return buildResponse(200, "failed", errorMessage);
    }
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
        locationId,
        contactId,
        workflowId,
        metaKey,
        tenantId: mapping.tenant_id,
        lineChannelId: lineChannelSelection.lineChannelId,
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
        locationId,
        contactId,
        workflowId,
        metaKey,
        tenantId: mapping.tenant_id,
        lineUserId: mapping.line_user_id,
        lineChannelId: lineChannelSelection.lineChannelId,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        lineMessageId: lineResult.messageId
      },
      "GHL workflow LINE message sent"
    );

    try {
      await mirrorWorkflowOutboundMessage({
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
          locationId,
          contactId,
          workflowId,
          metaKey,
          tenantId: mapping.tenant_id,
          lineUserId: mapping.line_user_id,
          lineMessageId: lineResult.messageId,
          ghlConversationId: mapping.ghl_conversation_id,
          mirrorStatus: "failed",
          errorMessage: mirrorError instanceof Error ? mirrorError.message : String(mirrorError)
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
      locationId,
      contactId,
      workflowId,
      metaKey,
      tenantId: mapping.tenant_id,
      lineUserId: mapping.line_user_id,
      lineChannelId: requestPayload.lineChannelId,
      channelTokenSource: requestPayload.channelTokenSource,
      errorMessage
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
