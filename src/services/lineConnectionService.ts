import crypto from "node:crypto";
import { logger } from "../config/logger";
import { getSupabase } from "../config/supabase";
import { getLineBotInfo, validateLineChannelAccessToken } from "../integrations/lineClient";
import { HttpError } from "../middleware/errors";

type TenantRecord = {
  id: string;
  location_id: string;
  updated_at?: string | null;
};

type LineChannelRecord = {
  id: string;
  tenant_id: string;
  webhook_key: string;
  channel_access_token: string;
  channel_secret: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type LineConnectionSettings = {
  connected: boolean;
  webhook_key: string | null;
  webhook_url: string | null;
  is_active: boolean;
  channel_access_token_length: number;
  channel_secret_length: number;
  line_bot_info: LineBotDisplayInfo | null;
};

export type LineBotDisplayInfo = {
  displayName: string | null;
  basicId: string | null;
  pictureUrl: string | null;
};

function normalizeLocationId(locationId: string): string {
  const normalizedLocationId = locationId.trim();

  if (!normalizedLocationId) {
    throw new HttpError(400, "locationId is required");
  }

  return normalizedLocationId;
}

function generateWebhookKey(): string {
  return `line_${crypto.randomBytes(16).toString("hex")}`;
}

function buildWebhookUrl(publicBaseUrl: string, webhookKey: string | null): string | null {
  if (!webhookKey) {
    return null;
  }

  return `${publicBaseUrl.replace(/\/+$/, "")}/webhooks/line/${encodeURIComponent(webhookKey)}/inbound`;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function getSafeLineBotInfo(channel: LineChannelRecord | null): Promise<LineBotDisplayInfo | null> {
  if (!channel?.is_active || !channel.channel_access_token?.trim()) {
    return null;
  }

  try {
    const botInfo = await getLineBotInfo(channel.channel_access_token);

    return {
      displayName: getString(botInfo.displayName),
      basicId: getString(botInfo.basicId),
      pictureUrl: getString(botInfo.pictureUrl)
    };
  } catch (error) {
    logger.warn(
      {
        lineChannelId: channel.id,
        errorMessage: error instanceof Error ? error.message : "Unknown LINE bot info error"
      },
      "Failed to load LINE bot info for connection settings"
    );

    return null;
  }
}

async function toSettings(channel: LineChannelRecord | null, publicBaseUrl: string): Promise<LineConnectionSettings> {
  const webhookKey = channel?.webhook_key?.trim() || null;
  const isActive = Boolean(channel?.is_active);
  const channelAccessTokenLength = isActive ? channel?.channel_access_token?.length ?? 0 : 0;
  const channelSecretLength = isActive ? channel?.channel_secret?.length ?? 0 : 0;
  const lineBotInfo = await getSafeLineBotInfo(channel);

  return {
    connected: isActive,
    webhook_key: webhookKey,
    webhook_url: buildWebhookUrl(publicBaseUrl, webhookKey),
    is_active: isActive,
    channel_access_token_length: channelAccessTokenLength,
    channel_secret_length: channelSecretLength,
    line_bot_info: lineBotInfo
  };
}

async function getTenantByLocationId(locationId: string): Promise<TenantRecord | null> {
  const normalizedLocationId = normalizeLocationId(locationId);
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tenants")
    .select("id, location_id, updated_at")
    .eq("location_id", normalizedLocationId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as TenantRecord | null;
}

async function getLineChannelByTenantId(tenantId: string): Promise<LineChannelRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("line_channels").select("*").eq("tenant_id", tenantId).maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineChannelRecord | null;
}

async function upsertLineChannelByTenantId(input: {
  tenantId: string;
  webhookKey: string;
  channelAccessToken: string;
  channelSecret: string;
}): Promise<LineChannelRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .upsert(
      {
        tenant_id: input.tenantId,
        webhook_key: input.webhookKey,
        channel_access_token: input.channelAccessToken,
        channel_secret: input.channelSecret,
        is_active: true,
        updated_at: new Date().toISOString()
      },
      { onConflict: "tenant_id" }
    )
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Supabase returned no LINE channel row");
  }

  return data as LineChannelRecord;
}

async function setLineChannelActiveByTenantId(
  tenantId: string,
  isActive: boolean
): Promise<LineChannelRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineChannelRecord | null;
}

export async function getLineConnectionSettings(input: {
  locationId: string;
  publicBaseUrl: string;
}): Promise<LineConnectionSettings> {
  const tenant = await getTenantByLocationId(input.locationId);

  if (!tenant) {
    return await toSettings(null, input.publicBaseUrl);
  }

  const channel = await getLineChannelByTenantId(tenant.id);

  logger.info(
    {
      tenantId: tenant.id,
      locationId: tenant.location_id,
      lineChannelId: channel?.id,
      connected: Boolean(channel?.is_active)
    },
    "Loaded LINE connection settings"
  );

  return await toSettings(channel, input.publicBaseUrl);
}

export async function connectLineChannel(input: {
  locationId: string;
  channelAccessToken: string;
  channelSecret: string;
  publicBaseUrl: string;
}): Promise<LineConnectionSettings> {
  const channelAccessToken = input.channelAccessToken.trim();
  const channelSecret = input.channelSecret.trim();

  if (!channelAccessToken) {
    throw new HttpError(400, "channelAccessToken is required");
  }

  if (!channelSecret) {
    throw new HttpError(400, "channelSecret is required");
  }

  try {
    await validateLineChannelAccessToken(channelAccessToken);
  } catch {
    throw new HttpError(400, "Invalid LINE channel access token");
  }

  const tenant = await getTenantByLocationId(input.locationId);

  if (!tenant) {
    throw new HttpError(404, "Tenant not found for locationId");
  }

  const existingChannel = await getLineChannelByTenantId(tenant.id);
  const webhookKey = existingChannel?.webhook_key?.trim() || generateWebhookKey();
  const channel = await upsertLineChannelByTenantId({
    tenantId: tenant.id,
    webhookKey,
    channelAccessToken,
    channelSecret
  });

  logger.info(
    {
      tenantId: tenant.id,
      locationId: tenant.location_id,
      lineChannelId: channel.id,
      connected: true,
      channelAccessTokenLength: channel.channel_access_token.length,
      channelSecretLength: channel.channel_secret.length
    },
    "Connected LINE channel for tenant"
  );

  return await toSettings(channel, input.publicBaseUrl);
}

export async function disconnectLineChannel(input: {
  locationId: string;
  publicBaseUrl: string;
}): Promise<LineConnectionSettings> {
  const tenant = await getTenantByLocationId(input.locationId);

  if (!tenant) {
    return await toSettings(null, input.publicBaseUrl);
  }

  const channel = await setLineChannelActiveByTenantId(tenant.id, false);

  logger.info(
    {
      tenantId: tenant.id,
      locationId: tenant.location_id,
      lineChannelId: channel?.id,
      connected: false
    },
    "Disconnected LINE channel for tenant"
  );

  return await toSettings(channel, input.publicBaseUrl);
}
