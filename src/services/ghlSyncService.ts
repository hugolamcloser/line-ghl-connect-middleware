import { logger } from "../config/logger";
import { pushLineTextMessage } from "../integrations/lineClient";
import type { NormalizedGhlOutboundMessage } from "../types/ghl";
import {
  ensureDefaultTenant,
  findLineProfileByGhlIds,
  saveMessageEvent
} from "./repository";

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

function getAttachments(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

export function normalizeGhlOutboundMessage(payload: Record<string, unknown>): NormalizedGhlOutboundMessage {
  const message =
    getString(payload.message) ??
    getString(payload.body) ??
    getString(payload.text) ??
    getNestedString(payload, ["message", "body"]) ??
    getNestedString(payload, ["message", "text"]);

  if (!message) {
    throw new Error("Outbound GHL webhook did not include a text message");
  }

  return {
    contactId: getString(payload.contactId) ?? getNestedString(payload, ["contact", "id"]),
    conversationId: getString(payload.conversationId) ?? getNestedString(payload, ["conversation", "id"]),
    messageId: getString(payload.messageId) ?? getString(payload.id) ?? getNestedString(payload, ["message", "id"]),
    message,
    attachments: getAttachments(payload.attachments),
    raw: payload
  };
}

export async function processGhlOutboundWebhook(payload: Record<string, unknown>): Promise<{
  status: "processed" | "skipped";
  reason?: string;
}> {
  const tenantId = await ensureDefaultTenant();
  const message = normalizeGhlOutboundMessage(payload);

  logger.info(
    {
      contactId: message.contactId,
      conversationId: message.conversationId,
      ghlMessageId: message.messageId
    },
    "HighLevel outbound provider webhook accepted"
  );

  const mapping = await findLineProfileByGhlIds(tenantId, {
    contactId: message.contactId,
    conversationId: message.conversationId
  });

  if (!mapping) {
    await saveMessageEvent({
      tenantId,
      provider: "ghl",
      direction: "outbound",
      externalMessageId: message.messageId,
      ghlConversationId: message.conversationId,
      payload,
      status: "skipped",
      errorMessage: "No LINE mapping exists for the GHL contact/conversation"
    });

    logger.warn(
      {
        contactId: message.contactId,
        conversationId: message.conversationId,
        ghlMessageId: message.messageId
      },
      "Skipped HighLevel outbound message because no LINE mapping exists"
    );

    return { status: "skipped", reason: "No LINE mapping found" };
  }

  await pushLineTextMessage(mapping.line_user_id, message.message);

  await saveMessageEvent({
    tenantId,
    provider: "ghl",
    direction: "outbound",
    externalMessageId: message.messageId,
    lineUserId: mapping.line_user_id,
    ghlConversationId: message.conversationId,
    payload,
    status: "sent"
  });

  logger.info(
    {
      lineUserId: mapping.line_user_id,
      contactId: message.contactId,
      conversationId: message.conversationId,
      ghlMessageId: message.messageId
    },
    "HighLevel outbound message sent to LINE"
  );

  return { status: "processed" };
}
