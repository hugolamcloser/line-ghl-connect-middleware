import { logger } from "../config/logger";
import { sendInboundMessageToGhl } from "../integrations/ghlInboundMessageClient";
import {
  createGhlContact,
  ensureGhlContactLineMetadata,
  getLineInboundFlowAuthDiagnostics
} from "../integrations/ghlLocationClient";
import { getLineProfile } from "../integrations/lineClient";
import type { LineMessage, LineSource, LineWebhookEvent } from "../types/line";
import { getErrorMessage, serializeError } from "../utils/errors";
import { redactSecrets } from "../utils/redaction";
import {
  ensureDefaultTenant,
  linkGhlMapping,
  markWebhookEventProcessed,
  saveMessageEvent,
  saveWebhookEvent,
  upsertLineProfile
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

function messageToText(message: LineMessage): { text?: string; attachments: string[]; supported: boolean; skipReason?: string } {
  if (message.type === "text") {
    return {
      text: message.text,
      attachments: [],
      supported: true
    };
  }

  return {
    attachments: [],
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

    const profile = event.source.type === "user" ? await getLineProfile(lineUserId) : null;
    let record = await upsertLineProfile({
      tenantId,
      lineUserId,
      lineSourceType: event.source.type,
      lineSourceId: getLineSourceId(event.source),
      displayName: profile?.displayName,
      pictureUrl: profile?.pictureUrl
    });

    const { text, attachments, supported, skipReason } = messageToText(event.message);

    if (!supported || !text) {
      const requestPayload = redactSecrets({
        ...getLineInboundFlowAuthDiagnostics("send_message"),
        contact_step: "send_message",
        skipped_reason: skipReason,
        line_message_type: event.message.type,
        line_message_id: event.message.id,
        outbound_ghl_request_body: null
      });

      await saveMessageEvent({
        tenantId,
        provider: "line",
        direction: "inbound",
        externalMessageId: event.message.id,
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
          lineMessageType: event.message.type,
          messageEventStatus: "skipped"
        },
        "Skipped unsupported LINE message type for HighLevel inbound message send"
      );

      return { status: "skipped", reason: skipReason };
    }

    const metadataWarnings: string[] = [];

    try {
      if (!record.ghl_contact_id) {
        const contact = await createGhlContact({
          lineUserId,
          displayName: profile?.displayName ?? undefined,
          pictureUrl: profile?.pictureUrl ?? undefined
        });

        record = await linkGhlMapping({
          tenantId,
          lineUserId,
          ghlContactId: contact.id
        });

        logger.info({ lineUserId, lineMessageId, ghlContactId: contact.id }, "Created GHL contact for LINE user");

        try {
          await ensureGhlContactLineMetadata(contact.id, {
            lineUserId,
            displayName: profile?.displayName ?? undefined,
            pictureUrl: profile?.pictureUrl ?? undefined
          });
        } catch (error) {
          const warning = redactSecrets(serializeError(error));
          metadataWarnings.push(`Failed to ensure LINE tags/custom fields on new GHL contact: ${warning.message}`);
          logger.warn(
            {
              lineUserId,
              lineMessageId,
              ghlContactId: contact.id,
              error: warning
            },
            "Failed to ensure LINE tags/custom fields on new GHL contact"
          );
        }
      } else {
        try {
          await ensureGhlContactLineMetadata(record.ghl_contact_id, {
            lineUserId,
            displayName: profile?.displayName ?? undefined,
            pictureUrl: profile?.pictureUrl ?? undefined
          });
        } catch (error) {
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

      if (!record.ghl_contact_id) {
        throw new Error("LINE user could not be linked to a GHL contact");
      }

      const inboundSendResult = await sendInboundMessageToGhl({
        contactId: record.ghl_contact_id,
        externalConversationId: buildLineExternalConversationId(lineUserId),
        externalMessageId: event.message.id,
        message: text,
        attachments
      });
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
        externalMessageId: event.message.id,
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
        externalMessageId: event.message.id,
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
