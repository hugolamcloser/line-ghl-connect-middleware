import { logger } from "../config/logger";
import { pushLineTextMessage } from "../integrations/lineClient";
import type { NormalizedGhlOutboundMessage } from "../types/ghl";
import {
  ensureDefaultTenant,
  findLineProfileByGhlIds,
  getActiveLineChannelByTenantId,
  getLineChannelById,
  saveMessageEvent
} from "./repository";
import type { LineProfileRecord } from "./repository";

type ChannelTokenSource = "profile_channel" | "tenant_active_channel" | "env_fallback";

type LineChannelSelection = {
  channelAccessToken?: string;
  lineChannelId?: string;
  channelTokenSource: ChannelTokenSource;
};

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

function hasUsableChannelAccessToken(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function resolveLineChannelForOutbound(
  tenantId: string,
  mapping: LineProfileRecord
): Promise<LineChannelSelection> {
  if (mapping.line_channel_id) {
    try {
      const profileChannel = await getLineChannelById(mapping.line_channel_id);

      if (profileChannel?.is_active && hasUsableChannelAccessToken(profileChannel.channel_access_token)) {
        return {
          channelAccessToken: profileChannel.channel_access_token,
          lineChannelId: profileChannel.id,
          channelTokenSource: "profile_channel"
        };
      }
    } catch {
      // Keep outbound delivery resilient; the caller logs the final token source.
    }
  }

  try {
    const tenantChannel = await getActiveLineChannelByTenantId(tenantId);

    if (tenantChannel?.is_active && hasUsableChannelAccessToken(tenantChannel.channel_access_token)) {
      return {
        channelAccessToken: tenantChannel.channel_access_token,
        lineChannelId: tenantChannel.id,
        channelTokenSource: "tenant_active_channel"
      };
    }
  } catch {
    // Keep existing env-token behavior if Supabase channel lookup is unavailable.
  }

  return {
    lineChannelId: mapping.line_channel_id ?? undefined,
    channelTokenSource: "env_fallback"
  };
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
        tenantId,
        contactId: message.contactId,
        conversationId: message.conversationId,
        ghlMessageId: message.messageId,
        lineProfileFound: false,
        channelTokenSource: "env_fallback"
      },
      "Skipped HighLevel outbound message because no LINE mapping exists"
    );

    return { status: "skipped", reason: "No LINE mapping found" };
  }

  const lineChannelSelection = await resolveLineChannelForOutbound(tenantId, mapping);

  logger.info(
    {
      tenantId,
      contactId: message.contactId ?? mapping.ghl_contact_id ?? undefined,
      lineProfileFound: true,
      lineChannelId: lineChannelSelection.lineChannelId,
      channelTokenSource: lineChannelSelection.channelTokenSource
    },
    "Selected LINE channel token source for HighLevel outbound message"
  );

  await pushLineTextMessage(mapping.line_user_id, message.message, lineChannelSelection.channelAccessToken);

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
