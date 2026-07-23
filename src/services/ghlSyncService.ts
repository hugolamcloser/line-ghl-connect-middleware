import { logger } from "../config/logger";
import { env, getWorkflowProviderFirstV3TenantRollout } from "../config/env";
import { pushLineMessages, pushLineTextMessage } from "../integrations/lineClient";
import { updateWorkflowProviderMessageStatus } from "../integrations/ghlWorkflowOutboundMirrorClient";
import { HttpError } from "../middleware/errors";
import type { NormalizedGhlOutboundMessage } from "../types/ghl";
import {
  isLineChannelNotConnectedError,
  resolveLineChannelForOutbound
} from "./lineOutboundChannelService";
import {
  claimGhlOutboundProviderDelivery,
  finalizeGhlOutboundProviderDelivery,
  findLineProfileByGhlIdsForTenantIds,
  findWorkflowProviderDispatchMessageEvent,
  findWorkflowOutboundMirrorMessageEventForTenantIds,
  getTenantById,
  getTenantIdsByLocationId,
  saveMessageEvent,
  type GhlOutboundProviderDeliveryClaimResult,
  type LineProfileRecord
} from "./repository";
import { buildGhlProviderOutboundLinePlan } from "./ghlProviderOutboundMessageBuilder";
import { buildShortLogRef, hasLogValue } from "../utils/logPrivacy";

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getNestedString(payload: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = payload;

  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return getString(current);
}

function getAttachments(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return value === undefined || value === null ? [] : [value];
  }

  return value.slice(0, 6);
}

export function normalizeGhlOutboundMessage(payload: Record<string, unknown>): NormalizedGhlOutboundMessage {
  const message =
    getString(payload.message) ??
    getString(payload.body) ??
    getString(payload.text) ??
    getNestedString(payload, ["message", "body"]) ??
    getNestedString(payload, ["message", "text"]);

  return {
    contactId: getString(payload.contactId) ?? getNestedString(payload, ["contact", "id"]),
    locationId:
      getString(payload.locationId) ??
      getString(payload.location_id) ??
      getNestedString(payload, ["location", "id"]) ??
      getNestedString(payload, ["location", "locationId"]),
    conversationId: getString(payload.conversationId) ?? getNestedString(payload, ["conversation", "id"]),
    messageId: getString(payload.messageId) ?? getString(payload.id) ?? getNestedString(payload, ["message", "id"]),
    conversationProviderId:
      getString(payload.conversationProviderId) ??
      getNestedString(payload, ["message", "conversationProviderId"]) ??
      getNestedString(payload, ["conversation", "conversationProviderId"]) ??
      getNestedString(payload, ["conversationProvider", "id"]),
    ...(message ? { message } : {}),
    attachments: getAttachments(payload.attachments),
    raw: payload
  };
}

function buildSanitizedProviderCallbackPayload(
  message: NormalizedGhlOutboundMessage
): Record<string, unknown> {
  return {
    source: "ghl_outbound_provider",
    locationIdPresent: hasLogValue(message.locationId),
    contactIdPresent: hasLogValue(message.contactId),
    conversationIdPresent: hasLogValue(message.conversationId),
    ghlMessageIdPresent: hasLogValue(message.messageId),
    conversationProviderIdPresent: hasLogValue(message.conversationProviderId),
    messagePresent: hasLogValue(message.message),
    messageLength: message.message?.length ?? 0,
    attachmentsPresent: message.attachments.length > 0,
    attachmentCount: message.attachments.length
  };
}

function buildProviderCallbackLogContext(
  message: NormalizedGhlOutboundMessage,
  input: {
    tenantId?: string;
    tenantCount?: number;
    lineChannelId?: string | null;
    lineUserId?: string;
  } = {}
): Record<string, unknown> {
  return {
    locationIdPresent: hasLogValue(message.locationId),
    locationRef: message.locationId ? buildShortLogRef(message.locationId) : undefined,
    contactIdPresent: hasLogValue(message.contactId),
    contactRef: message.contactId ? buildShortLogRef(message.contactId) : undefined,
    conversationIdPresent: hasLogValue(message.conversationId),
    conversationRef: message.conversationId ? buildShortLogRef(message.conversationId) : undefined,
    ghlMessageIdPresent: hasLogValue(message.messageId),
    ghlMessageRef: message.messageId ? buildShortLogRef(message.messageId) : undefined,
    conversationProviderIdPresent: hasLogValue(message.conversationProviderId),
    providerRef: message.conversationProviderId
      ? buildShortLogRef(message.conversationProviderId)
      : undefined,
    tenantCount: input.tenantCount,
    tenantRef: input.tenantId ? buildShortLogRef(input.tenantId) : undefined,
    lineChannelIdPresent: hasLogValue(input.lineChannelId),
    lineChannelRef: input.lineChannelId ? buildShortLogRef(input.lineChannelId) : undefined,
    lineUserIdPresent: hasLogValue(input.lineUserId),
    lineUserRef: input.lineUserId ? buildShortLogRef(input.lineUserId) : undefined
  };
}

async function resolveTenantIdsForGhlOutboundWebhook(message: NormalizedGhlOutboundMessage): Promise<string[]> {
  if (message.locationId) {
    const tenantIds = await getTenantIdsByLocationId(message.locationId);

    if (tenantIds.length > 0) {
      return tenantIds;
    }

    logger.warn(
      buildProviderCallbackLogContext(message),
      "Skipped HighLevel outbound provider webhook because no tenant exists for payload locationId"
    );

    return [];
  }

  logger.warn(
    buildProviderCallbackLogContext(message),
    "Skipped HighLevel outbound provider webhook because payload locationId is missing"
  );

  return [];
}

async function resolveLineProfileForGhlOutbound(
  tenantIds: string[],
  message: NormalizedGhlOutboundMessage
) {
  const exactMapping = await findLineProfileByGhlIdsForTenantIds(tenantIds, {
    contactId: message.contactId,
    conversationId: message.conversationId
  });

  if (exactMapping || !message.contactId || !message.conversationId) {
    return exactMapping;
  }

  const contactFallback = await findLineProfileByGhlIdsForTenantIds(tenantIds, {
    contactId: message.contactId
  });

  if (contactFallback) {
    logger.info(
      {
        ...buildProviderCallbackLogContext(message, {
          tenantId: contactFallback.tenant_id,
          tenantCount: tenantIds.length
        }),
        storedConversationIdPresent: hasLogValue(contactFallback.ghl_conversation_id)
      },
      "Resolved HighLevel outbound provider callback by unique exact-location contact fallback"
    );
  }

  return contactFallback;
}

async function processProviderCallback(input: {
  message: NormalizedGhlOutboundMessage;
  tenantIds: string[];
  mapping: LineProfileRecord;
}): Promise<{ status: "processed" | "skipped"; reason?: string }> {
  const { message, tenantIds, mapping } = input;
  const tenantId = mapping.tenant_id;
  let tenant;

  try {
    tenant = await getTenantById(tenantId);
  } catch (error) {
    logger.error(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        providerValidationStatus: "failed",
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "Failed to resolve tenant for provider callback"
    );
    throw new HttpError(503, "Unable to validate outbound conversation provider");
  }

  const configuredProviderId = tenant?.ghl_provider_id?.trim();
  const tenantLocationMatches = tenant?.location_id?.trim() === message.locationId;
  const callbackProviderPresent = hasLogValue(message.conversationProviderId);
  const configuredProviderPresent = hasLogValue(configuredProviderId);
  const callbackProviderMatches =
    callbackProviderPresent &&
    configuredProviderPresent &&
    message.conversationProviderId === configuredProviderId;
  let providerValidationMode: "exact_provider_id" | "exact_provider_dispatch" | undefined;
  let providerDispatchEventPresent = false;

  if (tenant && tenantLocationMatches && configuredProviderPresent) {
    if (callbackProviderPresent) {
      if (callbackProviderMatches) {
        providerValidationMode = "exact_provider_id";
      }
    } else if (message.message && message.attachments.length === 0) {
      try {
        const expectedConversationId =
          message.conversationId ?? mapping.ghl_conversation_id ?? undefined;
        const providerDispatchEvent = await findWorkflowProviderDispatchMessageEvent({
          tenantId,
          ghlMessageId: message.messageId as string,
          lineUserId: mapping.line_user_id,
          ...(message.contactId || mapping.ghl_contact_id
            ? { ghlContactId: message.contactId ?? mapping.ghl_contact_id ?? undefined }
            : {}),
          ...(expectedConversationId
            ? { ghlConversationId: expectedConversationId }
            : {})
        });
        providerDispatchEventPresent = Boolean(
          providerDispatchEvent &&
          providerDispatchEvent.tenant_id === tenantId &&
          providerDispatchEvent.ghl_message_id === message.messageId &&
          providerDispatchEvent.line_user_id === mapping.line_user_id &&
          (!expectedConversationId ||
            providerDispatchEvent.ghl_conversation_id === expectedConversationId)
        );

        if (providerDispatchEventPresent) {
          providerValidationMode = "exact_provider_dispatch";
        }
      } catch (error) {
        logger.error(
          {
            ...buildProviderCallbackLogContext(message, {
              tenantId,
              tenantCount: tenantIds.length
            }),
            callbackProviderPresent: false,
            providerDispatchEventPresent: false,
            providerValidationPassed: false,
            deliveryClaimStatus: "not_attempted",
            lineResultStatus: "not_attempted",
            errorCategory: error instanceof Error ? error.name : "unknown"
          },
          "Failed to validate provider callback against its workflow provider dispatch"
        );
        throw new HttpError(503, "Unable to validate outbound conversation provider");
      }
    }
  }

  const providerValidationPassed = providerValidationMode !== undefined;

  if (!tenant || !tenantLocationMatches || !providerValidationPassed) {
    logger.warn(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        tenantFound: Boolean(tenant),
        tenantLocationMatches,
        configuredProviderPresent,
        callbackProviderPresent,
        providerDispatchEventPresent,
        providerValidationPassed: false,
        deliveryClaimStatus: "not_attempted",
        lineResultStatus: "not_attempted"
      },
      "Rejected provider callback for an unverified conversation provider"
    );

    return { status: "skipped", reason: "Conversation provider validation failed" };
  }

  const providerValidationEvidence = {
    providerValidationMode,
    callbackProviderPresent,
    providerValidationPassed: true,
    providerDispatchEventPresent
  };
  const sanitizedPayload = {
    ...buildSanitizedProviderCallbackPayload(message),
    ...providerValidationEvidence
  };
  const claimedRequestPayload = {
    ...sanitizedPayload,
    deliveryState: "claimed",
    tenantVerified: true,
    lineProfileFound: true,
    channelConnected: false
  };
  let claim: GhlOutboundProviderDeliveryClaimResult;

  try {
    claim = await claimGhlOutboundProviderDelivery({
      tenantId,
      lineUserId: mapping.line_user_id,
      ghlMessageId: message.messageId as string,
      ghlConversationId: message.conversationId ?? mapping.ghl_conversation_id ?? undefined,
      payload: sanitizedPayload,
      requestPayload: claimedRequestPayload
    });
  } catch (error) {
    logger.error(
      {
        ...buildProviderCallbackLogContext(message, {
          tenantId,
          tenantCount: tenantIds.length,
          lineUserId: mapping.line_user_id
        }),
        deliveryClaimStatus: "failed",
        lineResultStatus: "not_attempted",
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "Failed to claim outbound provider delivery"
    );
    throw new HttpError(503, "Unable to claim outbound provider delivery");
  }

  if (!claim.claimed) {
    logger.info(
      {
        ...buildProviderCallbackLogContext(message, {
          tenantId,
          tenantCount: tenantIds.length,
          lineUserId: mapping.line_user_id
        }),
        deliveryClaimStatus: "already_claimed",
        lineResultStatus: "not_attempted"
      },
      "Skipped provider callback because delivery is already claimed"
    );
    return { status: "skipped", reason: "Already claimed" };
  }

  const finalizeFailure = async (input: {
    failureCategory: "invalid_content" | "channel_resolution" | "line_delivery";
    errorMessage: string;
    requestPayload?: Record<string, unknown>;
  }): Promise<{ statusUpdateOk: boolean; statusUpdateHttpStatusCode?: number }> => {
    try {
      await finalizeGhlOutboundProviderDelivery({
        eventId: claim.eventId,
        tenantId,
        status: "failed",
        lineUserId: mapping.line_user_id,
        ghlMessageId: message.messageId as string,
        ghlConversationId: message.conversationId ?? mapping.ghl_conversation_id ?? undefined,
        errorMessage: input.errorMessage,
        requestPayload: {
          ...claimedRequestPayload,
          ...input.requestPayload,
          deliveryState: "failed",
          failureCategory: input.failureCategory
        }
      });
    } catch (error) {
      logger.error(
        {
          ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
          deliveryClaimEventIdPresent: true,
          finalizationStatus: "failed",
          failureCategory: input.failureCategory,
          errorCategory: error instanceof Error ? error.name : "unknown"
        },
        "Failed to finalize provider callback claim"
      );
    }

    const statusResult = await updateWorkflowProviderMessageStatus({
      locationId: message.locationId as string,
      messageId: message.messageId as string,
      status: "failed"
    });

    return {
      statusUpdateOk: statusResult.ok,
      ...(statusResult.statusCode !== undefined
        ? { statusUpdateHttpStatusCode: statusResult.statusCode }
        : {})
    };
  };

  let linePlan;

  try {
    linePlan = buildGhlProviderOutboundLinePlan({
      message: message.message,
      attachments: message.attachments
    });
  } catch (error) {
    const failure = await finalizeFailure({
      failureCategory: "invalid_content",
      errorMessage: "Invalid outbound provider content"
    });

    logger.warn(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        messagePresent: hasLogValue(message.message),
        attachmentCount: message.attachments.length,
        validationStatus: "failed",
        lineResultStatus: "not_attempted",
        deliveryClaimStatus: "failed",
        statusUpdateStatus: failure.statusUpdateOk ? "success" : "failed",
        statusUpdateHttpStatusCode: failure.statusUpdateHttpStatusCode,
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "Handled invalid provider callback without LINE delivery"
    );
    return { status: "processed", reason: "Invalid outbound provider content" };
  }

  let lineChannelSelection;

  try {
    lineChannelSelection = await resolveLineChannelForOutbound(tenantId, mapping);
  } catch (error) {
    const failure = await finalizeFailure({
      failureCategory: "channel_resolution",
      errorMessage: "LINE channel resolution failed for provider delivery",
      requestPayload: {
        channelConnected: false,
        channelTokenSource: isLineChannelNotConnectedError(error) ? error.channelTokenSource : null
      }
    });

    logger.warn(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        messagePresent: linePlan.textPresent,
        attachmentCount: linePlan.attachmentCount,
        totalMessageCount: linePlan.messages.length,
        channelConnected: false,
        channelTokenSource: isLineChannelNotConnectedError(error) ? error.channelTokenSource : null,
        lineResultStatus: "not_attempted",
        deliveryClaimStatus: "failed",
        statusUpdateStatus: failure.statusUpdateOk ? "success" : "failed",
        statusUpdateHttpStatusCode: failure.statusUpdateHttpStatusCode,
        errorCategory: isLineChannelNotConnectedError(error)
          ? "channel_not_connected"
          : "channel_resolution"
      },
      "Handled provider callback with unavailable LINE channel"
    );
    return { status: "processed", reason: "LINE channel resolution failed" };
  }

  logger.info(
    {
      ...buildProviderCallbackLogContext(message, {
        tenantId,
        tenantCount: tenantIds.length,
        lineChannelId: lineChannelSelection.lineChannelId,
        lineUserId: mapping.line_user_id
      }),
      channelConnected: true,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      deliveryClaimStatus: "claimed"
    },
    "Selected LINE channel for claimed provider callback"
  );

  let lineResult;

  try {
    lineResult = await pushLineMessages(
      mapping.line_user_id,
      linePlan.messages,
      lineChannelSelection.channelAccessToken
    );
  } catch (error) {
    const failure = await finalizeFailure({
      failureCategory: "line_delivery",
      errorMessage: "LINE provider delivery failed",
      requestPayload: {
        channelConnected: true,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        attachmentCount: linePlan.attachmentCount,
        totalMessageCount: linePlan.messages.length
      }
    });

    logger.error(
      {
        ...buildProviderCallbackLogContext(message, {
          tenantId,
          tenantCount: tenantIds.length,
          lineChannelId: lineChannelSelection.lineChannelId,
          lineUserId: mapping.line_user_id
        }),
        messagePresent: linePlan.textPresent,
        attachmentCount: linePlan.attachmentCount,
        totalMessageCount: linePlan.messages.length,
        channelConnected: true,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        lineResultStatus: "failed",
        deliveryClaimStatus: "failed",
        statusUpdateStatus: failure.statusUpdateOk ? "success" : "failed",
        statusUpdateHttpStatusCode: failure.statusUpdateHttpStatusCode,
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "LINE provider delivery failed after atomic claim"
    );
    throw new HttpError(502, "LINE delivery failed after outbound provider claim");
  }

  let finalizationFailed = false;

  try {
    await finalizeGhlOutboundProviderDelivery({
      eventId: claim.eventId,
      tenantId,
      status: "sent",
      lineUserId: mapping.line_user_id,
      ghlMessageId: message.messageId as string,
      ghlConversationId: message.conversationId ?? mapping.ghl_conversation_id ?? undefined,
      requestPayload: {
        ...claimedRequestPayload,
        deliveryState: "sent",
        channelConnected: true,
        channelTokenSource: lineChannelSelection.channelTokenSource,
        lineMessageIdPresent: hasLogValue(lineResult.messageId),
        attachmentCount: linePlan.attachmentCount,
        totalMessageCount: linePlan.messages.length
      }
    });
  } catch (error) {
    finalizationFailed = true;
    logger.error(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        lineMessageIdPresent: hasLogValue(lineResult.messageId),
        deliveryClaimEventIdPresent: true,
        finalizationStatus: "failed",
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "LINE delivery succeeded but claim finalization failed"
    );
  }

  const statusResult = await updateWorkflowProviderMessageStatus({
    locationId: message.locationId as string,
    messageId: message.messageId as string,
    status: "delivered"
  });

  logger.info(
    {
      ...buildProviderCallbackLogContext(message, {
        tenantId,
        tenantCount: tenantIds.length,
        lineChannelId: lineChannelSelection.lineChannelId,
        lineUserId: mapping.line_user_id
      }),
      lineMessageIdPresent: hasLogValue(lineResult.messageId),
      messagePresent: linePlan.textPresent,
      attachmentCount: linePlan.attachmentCount,
      nativeImageCount: linePlan.nativeImageCount,
      videoLinkCount: linePlan.videoLinkCount,
      audioLinkCount: linePlan.audioLinkCount,
      documentLinkCount: linePlan.documentLinkCount,
      unknownLinkCount: linePlan.unknownLinkCount,
      totalMessageCount: linePlan.messages.length,
      channelConnected: true,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      lineResultStatus: "sent",
      lineHttpStatusCode: lineResult.statusCode,
      deliveryClaimStatus: finalizationFailed ? "finalization_failed" : "sent",
      statusUpdateStatus: statusResult.ok ? "success" : "failed",
      statusUpdateHttpStatusCode: statusResult.statusCode
    },
    "HighLevel provider callback sent one LINE message plan"
  );

  if (finalizationFailed) {
    throw new HttpError(500, "LINE delivery claim finalization failed");
  }

  return { status: "processed" };
}

async function processLegacyProviderCallback(input: {
  message: NormalizedGhlOutboundMessage;
  tenantIds: string[];
  mapping: LineProfileRecord;
}): Promise<{ status: "processed" | "skipped"; reason?: string }> {
  const { message, tenantIds, mapping } = input;
  const tenantId = mapping.tenant_id;

  if (!message.message) {
    logger.warn(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        selectedLifecycle: "provider_first_legacy",
        messagePresent: false,
        deliveryClaimStatus: "not_attempted",
        lineResultStatus: "not_attempted"
      },
      "Rejected legacy HighLevel provider callback because text is missing"
    );
    throw new Error("Outbound GHL webhook did not include a text message");
  }

  const sanitizedPayload = buildSanitizedProviderCallbackPayload(message);
  const lineChannelSelection = await resolveLineChannelForOutbound(tenantId, mapping).catch(
    async (error) => {
      if (!isLineChannelNotConnectedError(error)) {
        throw error;
      }

      await saveMessageEvent({
        tenantId,
        provider: "ghl",
        direction: "outbound",
        externalMessageId: `ghl-provider-channel-failure:${message.messageId}`,
        lineUserId: mapping.line_user_id,
        ghlMessageId: message.messageId,
        ghlConversationId: message.conversationId,
        payload: sanitizedPayload,
        status: "failed",
        errorMessage: error.message,
        requestPayload: {
          ...sanitizedPayload,
          selectedLifecycle: "provider_first_legacy",
          channelTokenSource: error.channelTokenSource,
          channelConnected: false
        }
      });

      logger.warn(
        {
          ...buildProviderCallbackLogContext(message, {
            tenantId,
            tenantCount: tenantIds.length,
            lineChannelId: error.lineChannelId ?? mapping.line_channel_id,
            lineUserId: mapping.line_user_id
          }),
          selectedLifecycle: "provider_first_legacy",
          lineProfileFound: true,
          channelTokenSource: error.channelTokenSource,
          channelConnected: false
        },
        "Blocked legacy HighLevel outbound message because LINE channel is not connected"
      );

      throw new HttpError(409, error.message);
    }
  );

  logger.info(
    {
      ...buildProviderCallbackLogContext(message, {
        tenantId,
        tenantCount: tenantIds.length,
        lineChannelId: lineChannelSelection.lineChannelId,
        lineUserId: mapping.line_user_id
      }),
      selectedLifecycle: "provider_first_legacy",
      lineProfileFound: true,
      channelTokenSource: lineChannelSelection.channelTokenSource,
      channelConnected: true
    },
    "Selected LINE channel for legacy HighLevel outbound message"
  );

  const claimedRequestPayload = {
    ...sanitizedPayload,
    selectedLifecycle: "provider_first_legacy",
    deliveryState: "claimed",
    channelTokenSource: lineChannelSelection.channelTokenSource,
    channelConnected: true
  };
  let claim: GhlOutboundProviderDeliveryClaimResult;

  try {
    claim = await claimGhlOutboundProviderDelivery({
      tenantId,
      lineUserId: mapping.line_user_id,
      ghlMessageId: message.messageId as string,
      ghlConversationId: message.conversationId ?? mapping.ghl_conversation_id ?? undefined,
      payload: sanitizedPayload,
      requestPayload: claimedRequestPayload
    });
  } catch (error) {
    logger.error(
      {
        ...buildProviderCallbackLogContext(message, {
          tenantId,
          tenantCount: tenantIds.length,
          lineUserId: mapping.line_user_id
        }),
        selectedLifecycle: "provider_first_legacy",
        deliveryClaimStatus: "failed",
        lineResultStatus: "not_attempted",
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "Failed to claim legacy HighLevel outbound provider delivery"
    );
    throw new HttpError(503, "Unable to claim outbound provider delivery");
  }

  if (!claim.claimed) {
    logger.info(
      {
        ...buildProviderCallbackLogContext(message, {
          tenantId,
          tenantCount: tenantIds.length,
          lineUserId: mapping.line_user_id
        }),
        selectedLifecycle: "provider_first_legacy",
        deliveryClaimStatus: "already_claimed",
        lineResultStatus: "not_attempted"
      },
      "Skipped legacy provider callback because delivery is already claimed"
    );
    return { status: "skipped", reason: "Already claimed" };
  }

  let lineResult;

  try {
    lineResult = await pushLineTextMessage(
      mapping.line_user_id,
      message.message,
      lineChannelSelection.channelAccessToken
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown LINE push error";

    try {
      await finalizeGhlOutboundProviderDelivery({
        eventId: claim.eventId,
        tenantId,
        status: "failed",
        lineUserId: mapping.line_user_id,
        ghlMessageId: message.messageId as string,
        ghlConversationId: message.conversationId ?? mapping.ghl_conversation_id ?? undefined,
        errorMessage,
        requestPayload: {
          ...claimedRequestPayload,
          deliveryState: "failed"
        }
      });
    } catch (finalizeError) {
      logger.error(
        {
          ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
          selectedLifecycle: "provider_first_legacy",
          deliveryClaimEventIdPresent: true,
          finalizationStatus: "failed",
          errorCategory: finalizeError instanceof Error ? finalizeError.name : "unknown"
        },
        "Failed to mark legacy outbound provider delivery claim as failed"
      );
    }

    logger.error(
      {
        ...buildProviderCallbackLogContext(message, {
          tenantId,
          tenantCount: tenantIds.length,
          lineUserId: mapping.line_user_id
        }),
        selectedLifecycle: "provider_first_legacy",
        deliveryClaimEventIdPresent: true,
        lineResultStatus: "failed",
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "LINE push failed after legacy outbound provider delivery was claimed"
    );
    throw new HttpError(502, "LINE delivery failed after outbound provider claim");
  }

  try {
    await finalizeGhlOutboundProviderDelivery({
      eventId: claim.eventId,
      tenantId,
      status: "sent",
      lineUserId: mapping.line_user_id,
      ghlMessageId: message.messageId as string,
      ghlConversationId: message.conversationId ?? mapping.ghl_conversation_id ?? undefined,
      requestPayload: {
        ...claimedRequestPayload,
        deliveryState: "sent",
        lineMessageIdPresent: hasLogValue(lineResult.messageId)
      }
    });
  } catch (error) {
    logger.error(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        selectedLifecycle: "provider_first_legacy",
        lineMessageIdPresent: hasLogValue(lineResult.messageId),
        deliveryClaimEventIdPresent: true,
        finalizationStatus: "failed",
        errorCategory: error instanceof Error ? error.name : "unknown"
      },
      "LINE push succeeded but legacy delivery claim finalization failed"
    );
    throw new HttpError(500, "LINE delivery claim finalization failed");
  }

  logger.info(
    {
      ...buildProviderCallbackLogContext(message, {
        tenantId,
        tenantCount: tenantIds.length,
        lineChannelId: lineChannelSelection.lineChannelId,
        lineUserId: mapping.line_user_id
      }),
      selectedLifecycle: "provider_first_legacy",
      lineMessageIdPresent: hasLogValue(lineResult.messageId),
      deliveryClaimStatus: "sent",
      lineResultStatus: "sent"
    },
    "Legacy HighLevel outbound message sent to LINE"
  );

  return { status: "processed" };
}

export async function processGhlOutboundWebhook(payload: Record<string, unknown>): Promise<{
  status: "processed" | "skipped";
  reason?: string;
}> {
  const message = normalizeGhlOutboundMessage(payload);
  const persistedCallbackPayload = buildSanitizedProviderCallbackPayload(message);
  const tenantIds = await resolveTenantIdsForGhlOutboundWebhook(message);

  if (tenantIds.length === 0) {
    return {
      status: "skipped",
      reason: message.locationId ? "No tenant found for locationId" : "Missing locationId"
    };
  }

  logger.info(
    {
      ...buildProviderCallbackLogContext(message, { tenantCount: tenantIds.length }),
      tenantCount: tenantIds.length,
      messagePresent: hasLogValue(message.message),
      attachmentCount: message.attachments.length
    },
    "HighLevel outbound provider webhook accepted"
  );

  if (!message.messageId) {
    logger.warn(
      buildProviderCallbackLogContext(message, { tenantCount: tenantIds.length }),
      "Skipped HighLevel outbound provider webhook because payload messageId is missing"
    );

    return { status: "skipped", reason: "Missing messageId" };
  }

  const mirroredWorkflowMessage = await findWorkflowOutboundMirrorMessageEventForTenantIds({
    tenantIds,
    ghlMessageId: message.messageId
  });

  if (mirroredWorkflowMessage) {
    const tenantId = mirroredWorkflowMessage.tenant_id;

    await saveMessageEvent({
      tenantId,
      provider: "ghl",
      direction: "outbound",
      externalMessageId: message.messageId ? `ghl-provider-echo:${message.messageId}` : undefined,
      ghlMessageId: message.messageId,
      ghlConversationId: message.conversationId,
      payload: persistedCallbackPayload,
      status: "skipped",
      errorMessage: "Skipped workflow outbound mirror echo to avoid duplicate LINE delivery",
      requestPayload: {
        ...buildSanitizedProviderCallbackPayload(message),
        skipReason: "workflow_outbound_mirror_echo",
        mirrorMessageEventIdPresent: true
      }
    });

    logger.warn(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        mirrorMessageEventIdPresent: hasLogValue(mirroredWorkflowMessage.id)
      },
      "Skipped HighLevel outbound provider webhook because it matches a workflow outbound mirror"
    );

    return { status: "skipped", reason: "Workflow outbound mirror echo" };
  }

  const mapping = await resolveLineProfileForGhlOutbound(tenantIds, message);

  if (!mapping) {
    const [tenantId] = tenantIds;

    await saveMessageEvent({
      tenantId,
      provider: "ghl",
      direction: "outbound",
      externalMessageId: `ghl-provider-unmapped:${message.messageId}`,
      ghlConversationId: message.conversationId,
      payload: persistedCallbackPayload,
      status: "skipped",
      errorMessage: "No LINE mapping exists for the GHL contact/conversation"
    });

    logger.warn(
      {
        ...buildProviderCallbackLogContext(message, { tenantId, tenantCount: tenantIds.length }),
        lineProfileFound: false,
        channelTokenSource: null
      },
      "Skipped HighLevel outbound message because no LINE mapping exists"
    );

    return { status: "skipped", reason: "No LINE mapping found" };
  }

  const rollout = getWorkflowProviderFirstV3TenantRollout(mapping.tenant_id);
  const useProviderFirstV3 =
    env.GHL_WORKFLOW_LINE_DELIVERY_MODE === "provider_first" && rollout.tenantAllowlisted;

  logger.info(
    {
      ...buildProviderCallbackLogContext(message, {
        tenantId: mapping.tenant_id,
        tenantCount: tenantIds.length
      }),
      rolloutMode: env.GHL_WORKFLOW_LINE_DELIVERY_MODE,
      allowlistConfigured: rollout.allowlistConfigured,
      tenantAllowlistMatch: rollout.tenantAllowlisted,
      tenantRef: buildShortLogRef(mapping.tenant_id),
      selectedLifecycle: useProviderFirstV3 ? "provider_first_v3" : "provider_first_legacy"
    },
    "Selected HighLevel provider callback lifecycle"
  );

  return useProviderFirstV3
    ? processProviderCallback({ message, tenantIds, mapping })
    : processLegacyProviderCallback({ message, tenantIds, mapping });
}
