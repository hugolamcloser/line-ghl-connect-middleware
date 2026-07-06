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
import { redactSecrets } from "../utils/redaction";
import {
  clearGhlMapping,
  ensureDefaultTenant,
  linkGhlMapping,
  markWebhookEventProcessed,
  saveMessageEvent,
  saveWebhookEvent,
  upsertLineProfile,
  type LineProfileRecord
} from "./repository";

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
  metadataWarnings: string[];
}): Promise<LineProfileRecord> {
  const contact = await createGhlContact({
    lineUserId: input.lineUserId,
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

export async function processLineWebhookEvent(event: LineWebhookEvent): Promise<{
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
    const tenantId = await ensureDefaultTenant();

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
    const profile = event.source.type === "user" ? await getLineProfile(lineUserId) : null;
    let record = await upsertLineProfile({
      tenantId,
      lineUserId,
      lineSourceType: event.source.type,
      lineSourceId: getLineSourceId(event.source),
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
          metadataWarnings
        });
      } else {
        try {
          await ensureGhlContactLineMetadata(record.ghl_contact_id, {
            lineUserId,
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
          contactId: record.ghl_contact_id as string,
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
          lineUserId,
          lineMessageId,
          error: serializedError,
          requestPayload,
          ghlStatusCode: serializedError.statusCode,
          canonicalCode: serializedError.canonicalCode,
          ghlPath: serializedError.path,
          ghlMethod: serializedError.method,
          authMode: serializedError.authMode,
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
          lineUserId,
          lineMessageId,
          ghlStatusCode: serializedError.statusCode,
          canonicalCode: serializedError.canonicalCode,
          ghlPath: serializedError.path,
          ghlMethod: serializedError.method,
          authMode: serializedError.authMode,
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
