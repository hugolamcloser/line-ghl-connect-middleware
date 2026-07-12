import { logger } from "../config/logger";
import { sendInboundMessageToGhl } from "../integrations/ghlInboundMessageClient";
import {
  createGhlContact,
  ensureGhlContactLineMetadata,
  getLineInboundFlowAuthDiagnostics,
  isStaleGhlContactError
} from "../integrations/ghlLocationClient";
import { getLineProfile } from "../integrations/lineClient";
import type { LineMessage, LineProfile, LineSource, LineWebhookEvent } from "../types/line";
import { getErrorMessage, serializeError } from "../utils/errors";
import { redactSecrets, redactSensitiveText } from "../utils/redaction";
import {
  clearGhlMapping,
  ensureDefaultTenant,
  getTenantById,
  linkGhlMapping,
  markWebhookEventProcessed,
  saveMessageEvent,
  saveWebhookEvent,
  upsertLineProfile,
  type LineProfileRecord
} from "./repository";

export type LineInboundProcessingContext = {
  tenantId?: string;
  lineChannelId?: string;
  webhookKey?: string;
  channelAccessToken?: string;
};

type ResolvedTenantGhlConfig = {
  locationId: string;
  providerId: string;
  configSource: "tenant";
};

function getTrimmedValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function resolveTenantGhlConfig(tenantId: string): Promise<ResolvedTenantGhlConfig> {
  const tenant = await getTenantById(tenantId);

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} was not found`);
  }

  const locationId = getTrimmedValue(tenant.location_id);

  if (!locationId) {
    throw new Error(`Tenant ${tenantId} has no location_id`);
  }

  const providerId = getTrimmedValue(tenant.ghl_provider_id);

  if (!providerId) {
    throw new Error(`Tenant ${tenantId} has no ghl_provider_id`);
  }

  return {
    locationId,
    providerId,
    configSource: "tenant"
  };
}

function getLineUserId(source: LineSource): string | undefined {
  return "userId" in source ? source.userId : undefined;
}

function getLineSourceId(source: LineSource): string {
  if (source.type === "group") {
    return source.groupId;
  }

  if (source.type === "room") {
    return source.roomId;
  }

  return source.userId;
}

function messageToText(message: LineMessage): { text?: string; attachments?: string[]; supported: boolean; skipReason?: string } {
  if (message.type === "text") {
    return {
      text: message.text,
      supported: true
    };
  }

  return {
    supported: false,
    skipReason: `Unsupported LINE message type for GHL inbound send: ${message.type}`
  };
}

function getLineMessageId(event: LineWebhookEvent): string | undefined {
  return event.message?.id;
}

function getWebhookEventId(event: LineWebhookEvent): string | undefined {
  return event.webhookEventId ?? getLineMessageId(event);
}

function appendMessage(parts: string[], message: string | undefined): string | undefined {
  const cleanParts = [...parts, message].filter((part): part is string => Boolean(part?.trim()));
  return cleanParts.length > 0 ? cleanParts.join("; ") : undefined;
}

async function recordTenantGhlConfigFailure(input: {
  tenantId: string;
  event: LineWebhookEvent;
  lineUserId?: string;
  lineMessageId?: string;
  webhookKey?: string;
  error: unknown;
}): Promise<string> {
  const errorMessage = redactSensitiveText(getErrorMessage(input.error));
  const reason = `Tenant GHL configuration resolution failed: ${errorMessage}`;
  const requestPayload = {
    source: "tenant_ghl_config_resolution",
    tenantId: input.tenantId,
    webhookKey: input.webhookKey,
    configSource: "tenant",
    messageEventStatus: "failed"
  };

  try {
    await saveMessageEvent({
      tenantId: input.tenantId,
      provider: "line",
      direction: "inbound",
      externalMessageId: input.lineMessageId ?? input.event.webhookEventId,
      lineUserId: input.lineUserId,
      payload: input.event,
      status: "failed",
      errorMessage: reason,
      requestPayload
    });
  } catch (persistenceError) {
    logger.error(
      {
        tenantId: input.tenantId,
        webhookKey: input.webhookKey,
        lineUserId: input.lineUserId,
        lineMessageId: input.lineMessageId,
        persistenceError: redactSensitiveText(getErrorMessage(persistenceError)),
        messageEventStatus: "failed"
      },
      "Failed to persist LINE inbound tenant configuration failure"
    );
  }

  logger.error(
    {
      tenantId: input.tenantId,
      webhookKey: input.webhookKey,
      lineUserId: input.lineUserId,
      lineMessageId: input.lineMessageId,
      error: errorMessage,
      configSource: "tenant",
      messageEventStatus: "failed"
    },
    "Blocked LINE inbound processing because tenant GHL configuration could not be resolved"
  );

  return reason;
}

function mergeRequestPayloadWithAuthDiagnostics(requestPayload: unknown): unknown {
  const authDiagnostics = getLineInboundFlowAuthDiagnostics("send_message");

  if (requestPayload && typeof requestPayload === "object" && !Array.isArray(requestPayload)) {
    return redactSecrets({
      ...authDiagnostics,
      ...(requestPayload as Record<string, unknown>)
    });
  }

  if (requestPayload) {
    return redactSecrets({
      ...authDiagnostics,
      request_payload: requestPayload
    });
  }

  return redactSecrets(authDiagnostics);
}

function buildLineExternalConversationId(lineUserId: string): string {
  return `line:${lineUserId}`;
}

async function createAndLinkGhlContactForLineUser(input: {
  tenantId: string;
  lineUserId: string;
  lineMessageId?: string;
  profile: LineProfile | null;
  ghlConfig: ResolvedTenantGhlConfig;
  metadataWarnings: string[];
}): Promise<LineProfileRecord> {
  const contact = await createGhlContact({
    lineUserId: input.lineUserId,
    locationId: input.ghlConfig.locationId,
    displayName: input.profile?.displayName ?? undefined,
    pictureUrl: input.profile?.pictureUrl ?? undefined
  });
  const record = await linkGhlMapping({
    tenantId: input.tenantId,
    lineUserId: input.lineUserId,
    ghlContactId: contact.id
  });

  logger.info(
    { lineUserId: input.lineUserId, lineMessageId: input.lineMessageId, ghlContactId: contact.id },
    "Created GHL contact for LINE user"
  );

  try {
    await ensureGhlContactLineMetadata(contact.id, {
      lineUserId: input.lineUserId,
      locationId: input.ghlConfig.locationId,
      displayName: input.profile?.displayName ?? undefined,
      pictureUrl: input.profile?.pictureUrl ?? undefined
    });
  } catch (error) {
    const warning = redactSecrets(serializeError(error));
    input.metadataWarnings.push(`Failed to ensure LINE tags/custom fields on new GHL contact: ${warning.message}`);
    logger.warn(
      {
        lineUserId: input.lineUserId,
        lineMessageId: input.lineMessageId,
        ghlContactId: contact.id,
        error: warning
      },
      "Failed to ensure LINE tags/custom fields on new GHL contact"
    );
  }

  return record;
}

async function recoverStaleGhlContactMapping(input: {
  tenantId: string;
  lineUserId: string;
  lineMessageId?: string;
  record: LineProfileRecord;
  profile: LineProfile | null;
  ghlConfig: ResolvedTenantGhlConfig;
  metadataWarnings: string[];
  cause: unknown;
}): Promise<LineProfileRecord> {
  const oldContactId = input.record.ghl_contact_id ?? undefined;
  const staleError = redactSecrets(serializeError(input.cause));

  logger.warn(
    {
      lineUserId: input.lineUserId,
      lineMessageId: input.lineMessageId,
      oldGhlContactId: oldContactId,
      oldGhlConversationId: input.record.ghl_conversation_id ?? undefined,
      staleError
    },
    "Stale GHL contact mapping detected"
  );

  await clearGhlMapping({
    tenantId: input.tenantId,
    lineUserId: input.lineUserId
  });

  const recoveredRecord = await createAndLinkGhlContactForLineUser({
    tenantId: input.tenantId,
    lineUserId: input.lineUserId,
    lineMessageId: input.lineMessageId,
    profile: input.profile,
    ghlConfig: input.ghlConfig,
    metadataWarnings: input.metadataWarnings
  });

  logger.info(
    {
      lineUserId: input.lineUserId,
      lineMessageId: input.lineMessageId,
      oldGhlContactId: oldContactId,
      newGhlContactId: recoveredRecord.ghl_contact_id
    },
    "Created replacement GHL contact after stale mapping recovery"
  );

  return recoveredRecord;
}

export async function processLineWebhookEvent(event: LineWebhookEvent, context: LineInboundProcessingContext = {}): Promise<{
  status: "processed" | "skipped" | "failed";
  reason?: string;
}> {
  const lineUserId = getLineUserId(event.source);
  const lineMessageId = getLineMessageId(event);
  const webhookEvent = await saveWebhookEvent({
    source: "line",
    eventId: getWebhookEventId(event),
    payload: event
  });

  try {
    const tenantId = context.tenantId ?? (await ensureDefaultTenant());
    let ghlConfig: ResolvedTenantGhlConfig;

    try {
      ghlConfig = await resolveTenantGhlConfig(tenantId);
    } catch (error) {
      const reason = await recordTenantGhlConfigFailure({
        tenantId,
        event,
        lineUserId,
        lineMessageId,
        webhookKey: context.webhookKey,
        error
      });
      return { status: "failed", reason };
    }

    logger.info(
      {
        tenantId,
        locationId: ghlConfig.locationId,
        providerId: ghlConfig.providerId,
        webhookKey: context.webhookKey,
        configSource: ghlConfig.configSource,
        selectedContactAuthMode: getLineInboundFlowAuthDiagnostics("send_message").contact_auth_mode_used,
        selectedInboundSendAuthMode: getLineInboundFlowAuthDiagnostics("send_message").inbound_send_auth_mode_used
      },
      "Resolved GHL tenant config for LINE inbound processing"
    );

    if (!lineUserId) {
      return { status: "skipped", reason: "LINE event has no userId" };
    }

    if (event.type !== "message" || !event.message) {
      await saveMessageEvent({
        tenantId,
        provider: "line",
        direction: "inbound",
        externalMessageId: event.webhookEventId,
        lineUserId,
        payload: event,
        status: "skipped"
      });
      return { status: "skipped", reason: `Unsupported LINE event type: ${event.type}` };
    }

    const lineMessage = event.message;
    const profile = event.source.type === "user" ? await getLineProfile(lineUserId, context.channelAccessToken) : null;
    let record = await upsertLineProfile({
      tenantId,
      lineUserId,
      lineSourceType: event.source.type,
      lineSourceId: getLineSourceId(event.source),
      lineChannelId: context.lineChannelId,
      displayName: profile?.displayName,
      pictureUrl: profile?.pictureUrl
    });

    const { text, attachments, supported, skipReason } = messageToText(lineMessage);

    if (!supported || !text) {
      const requestPayload = redactSecrets({
        ...getLineInboundFlowAuthDiagnostics("send_message"),
        contact_step: "send_message",
        skipped_reason: skipReason,
        line_message_type: lineMessage.type,
        line_message_id: lineMessage.id,
        outbound_ghl_request_body: null
      });

      await saveMessageEvent({
        tenantId,
        provider: "line",
        direction: "inbound",
        externalMessageId: lineMessage.id,
        lineUserId,
        payload: event,
        status: "skipped",
        errorMessage: skipReason,
        requestPayload
      });

      logger.info(
        {
          lineUserId,
          lineMessageId,
          lineMessageType: lineMessage.type,
          webhookKey: context.webhookKey,
          messageEventStatus: "skipped"
        },
        "Skipped unsupported LINE message type for HighLevel inbound message send"
      );

      return { status: "skipped", reason: skipReason };
    }

    const metadataWarnings: string[] = [];
    let staleMappingRecovered = false;

    try {
      if (!record.ghl_contact_id) {
        record = await createAndLinkGhlContactForLineUser({
          tenantId,
          lineUserId,
          lineMessageId,
          profile,
          ghlConfig,
          metadataWarnings
        });
      } else {
        try {
          await ensureGhlContactLineMetadata(record.ghl_contact_id, {
            lineUserId,
            locationId: ghlConfig.locationId,
            displayName: profile?.displayName ?? undefined,
            pictureUrl: profile?.pictureUrl ?? undefined
          });
        } catch (error) {
          if (isStaleGhlContactError(error)) {
            record = await recoverStaleGhlContactMapping({
              tenantId,
              lineUserId,
              lineMessageId,
              record,
              profile,
              ghlConfig,
              metadataWarnings,
              cause: error
            });
            staleMappingRecovered = true;
          } else {
            const warning = redactSecrets(serializeError(error));
            metadataWarnings.push(`Failed to ensure LINE tags/custom fields on existing GHL contact: ${warning.message}`);
            logger.warn(
              {
                lineUserId,
                lineMessageId,
                ghlContactId: record.ghl_contact_id,
                error: warning
              },
              "Failed to ensure LINE tags/custom fields on existing GHL contact"
            );
          }
        }
      }

      if (!record.ghl_contact_id) {
        throw new Error("LINE user could not be linked to a GHL contact");
      }

      const sendInboundMessage = () =>
        sendInboundMessageToGhl({
          tenantId,
          contactId: record.ghl_contact_id as string,
          locationId: ghlConfig.locationId,
          conversationProviderId: ghlConfig.providerId,
          externalConversationId: buildLineExternalConversationId(lineUserId),
          externalMessageId: lineMessage.id,
          message: text,
          ...(attachments && attachments.length > 0 ? { attachments } : {})
        });
      let inboundSendResult: Awaited<ReturnType<typeof sendInboundMessageToGhl>>;

      try {
        inboundSendResult = await sendInboundMessage();
      } catch (error) {
        if (!staleMappingRecovered && isStaleGhlContactError(error)) {
          record = await recoverStaleGhlContactMapping({
            tenantId,
            lineUserId,
            lineMessageId,
            record,
            profile,
            ghlConfig,
            metadataWarnings,
            cause: error
          });
          staleMappingRecovered = true;

          if (!record.ghl_contact_id) {
            throw new Error("LINE user could not be linked to a replacement GHL contact");
          }

          inboundSendResult = await sendInboundMessage();
          logger.info(
            {
              lineUserId,
              lineMessageId,
              newGhlContactId: record.ghl_contact_id
            },
            "Inbound LINE message resent after stale GHL contact mapping recovery"
          );
        } else {
          throw error;
        }
      }
      const response = inboundSendResult.response;
      const requestPayload = redactSecrets(inboundSendResult.diagnostics);

      const ghlConversationId = typeof response.conversationId === "string" ? response.conversationId : undefined;

      if (ghlConversationId && ghlConversationId !== record.ghl_conversation_id) {
        await linkGhlMapping({
          tenantId,
          lineUserId,
          ghlConversationId
        });
      }

      await saveMessageEvent({
        tenantId,
        provider: "line",
        direction: "inbound",
        externalMessageId: lineMessage.id,
        lineUserId,
        ghlMessageId: typeof response.messageId === "string" ? response.messageId : response.id,
        ghlConversationId,
        payload: {
          lineEvent: event,
          ghlResponse: response,
          diagnostics: requestPayload
        },
        status: "success",
        errorMessage: appendMessage(metadataWarnings, undefined),
        requestPayload
      });

      logger.info(
        {
          tenantId,
          locationId: ghlConfig.locationId,
          ghlProviderId: ghlConfig.providerId,
          webhookKey: context.webhookKey,
          authModeUsed: requestPayload.actual_auth_mode_used,
          ghlStatusCode: requestPayload.statusCode,
          lineUserId,
          lineMessageId,
          ghlContactId: record.ghl_contact_id,
          ghlConversationId,
          ghlMessageId: typeof response.messageId === "string" ? response.messageId : response.id,
          messageEventStatus: "success"
        },
        "Saved successful LINE inbound message event"
      );

      return { status: "processed" };
    } catch (error) {
      const serializedError = redactSecrets(serializeError(error));
      const errorMessage = appendMessage(metadataWarnings, getErrorMessage(error));
      const requestPayload = mergeRequestPayloadWithAuthDiagnostics(serializedError.requestPayload);

      logger.error(
        {
          tenantId,
          locationId: ghlConfig.locationId,
          ghlProviderId: ghlConfig.providerId,
          webhookKey: context.webhookKey,
          lineUserId,
          lineMessageId,
          error: serializedError,
          requestPayload,
          ghlStatusCode: serializedError.statusCode,
          canonicalCode: serializedError.canonicalCode,
          ghlPath: serializedError.path,
          ghlMethod: serializedError.method,
          authMode: serializedError.authMode,
          authModeUsed: serializedError.authMode,
          shortGhlErrorMessage:
            requestPayload && typeof requestPayload === "object" && !Array.isArray(requestPayload)
              ? (requestPayload as Record<string, unknown>).short_ghl_error_message
              : undefined,
          messageEventStatus: "failed"
        },
        "Failed to sync LINE inbound message to HighLevel"
      );

      await saveMessageEvent({
        tenantId,
        provider: "line",
        direction: "inbound",
        externalMessageId: lineMessage.id,
        lineUserId,
        payload: {
          lineEvent: event,
          ghlError: serializedError,
          diagnostics: requestPayload
        },
        status: "failed",
        errorMessage,
        ghlStatusCode: serializedError.statusCode,
        ghlResponseBody: serializedError.responseBody,
        requestPayload
      });

      logger.error(
        {
          tenantId,
          locationId: ghlConfig.locationId,
          ghlProviderId: ghlConfig.providerId,
          webhookKey: context.webhookKey,
          lineUserId,
          lineMessageId,
          ghlStatusCode: serializedError.statusCode,
          canonicalCode: serializedError.canonicalCode,
          ghlPath: serializedError.path,
          ghlMethod: serializedError.method,
          authMode: serializedError.authMode,
          authModeUsed: serializedError.authMode,
          shortGhlErrorMessage:
            requestPayload && typeof requestPayload === "object" && !Array.isArray(requestPayload)
              ? (requestPayload as Record<string, unknown>).short_ghl_error_message
              : undefined,
          messageEventStatus: "failed"
        },
        "Saved failed LINE inbound message event"
      );

      return { status: "failed", reason: errorMessage };
    }
  } finally {
    await markWebhookEventProcessed(webhookEvent.id);
  }
}
