import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import { getSupabase } from "../config/supabase";

export type LineProfileRecord = {
  id: string;
  tenant_id: string;
  line_user_id: string;
  line_source_type: string;
  line_source_id: string;
  display_name: string | null;
  picture_url: string | null;
  ghl_contact_id: string | null;
  ghl_conversation_id: string | null;
  line_channel_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LineChannelRecord = {
  id: string;
  tenant_id: string;
  webhook_key: string;
  channel_access_token: string;
  channel_secret: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type TenantRecord = {
  id: string;
  location_id: string;
  ghl_provider_id: string;
  line_channel_id: string;
  created_at: string;
  updated_at: string;
};

export type UpsertLineProfileInput = {
  tenantId: string;
  lineUserId: string;
  lineSourceType: string;
  lineSourceId: string;
  lineChannelId?: string;
  displayName?: string;
  pictureUrl?: string;
};

export type SaveMessageEventInput = {
  tenantId: string;
  provider: "line" | "ghl";
  direction: "inbound" | "outbound";
  externalMessageId?: string;
  lineUserId?: string;
  ghlMessageId?: string;
  ghlConversationId?: string;
  payload: unknown;
  status: "received" | "sent" | "success" | "skipped" | "failed";
  errorMessage?: string;
  ghlStatusCode?: number;
  ghlResponseBody?: string;
  requestPayload?: unknown;
};

export type SaveWebhookEventInput = {
  source: "line" | "ghl";
  eventId?: string;
  payload: unknown;
};

export type WebhookEventRecord = {
  id: string;
  source: "line" | "ghl";
  event_id: string | null;
  payload: unknown;
  processed_at: string | null;
  created_at: string;
};

export type WorkflowOutboundMirrorEventRecord = {
  id: string;
  tenant_id: string;
  ghl_message_id: string | null;
  request_payload: unknown;
  created_at: string;
};

export type WorkflowProviderDispatchEventRecord = {
  id: string;
  tenant_id: string;
  line_user_id: string | null;
  ghl_message_id: string | null;
  ghl_conversation_id: string | null;
  request_payload: unknown;
  created_at: string;
};

export type GhlOutboundProviderDeliveryClaimResult =
  | {
      claimed: true;
      eventId: string;
      externalMessageId: string;
    }
  | {
      claimed: false;
      externalMessageId: string;
    };

export type ClaimGhlOutboundProviderDeliveryInput = {
  tenantId: string;
  lineUserId: string;
  ghlMessageId: string;
  ghlConversationId?: string;
  payload: unknown;
  requestPayload: unknown;
};

export type FinalizeGhlOutboundProviderDeliveryInput = {
  eventId: string;
  tenantId: string;
  status: "sent" | "failed";
  lineUserId: string;
  ghlMessageId: string;
  ghlConversationId?: string;
  errorMessage?: string;
  requestPayload: unknown;
};

export type GhlOAuthTokenRecord = {
  id: string;
  tenant_id: string | null;
  location_id: string;
  company_id: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[];
  token_type: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertGhlOAuthTokenInput = {
  tenantId?: string;
  locationId: string;
  companyId?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes?: string[];
  tokenType?: string;
};

export type GhlOAuthOnboardingSessionRecord = {
  id: string;
  app_id: string;
  company_id: string;
  access_token: string | null;
  status: "active" | "expired" | "failed";
  expires_at: string;
  last_reconciled_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type GhlPendingAppInstallRecord = {
  id: string;
  app_id: string;
  company_id: string;
  location_id: string;
  tenant_id: string;
  delivery_key: string;
  status: "pending" | "processing" | "completed" | "failed";
  processing_started_at: string | null;
  completed_at: string | null;
  completed_session_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertLineChannelInput = {
  tenantId: string;
  webhookKey: string;
  channelAccessToken: string;
  channelSecret: string;
  isActive?: boolean;
};

function requireSingle<T>(data: T | null, error: { message: string } | null): T {
  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Supabase returned no data");
  }

  return data;
}

function getProfileTimeValue(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortCanonicalLineProfiles(records: LineProfileRecord[]): LineProfileRecord[] {
  return [...records].sort((left, right) => {
    const leftHasContact = left.ghl_contact_id ? 1 : 0;
    const rightHasContact = right.ghl_contact_id ? 1 : 0;

    if (leftHasContact !== rightHasContact) {
      return rightHasContact - leftHasContact;
    }

    const leftHasConversation = left.ghl_conversation_id ? 1 : 0;
    const rightHasConversation = right.ghl_conversation_id ? 1 : 0;

    if (leftHasConversation !== rightHasConversation) {
      return rightHasConversation - leftHasConversation;
    }

    const leftUpdatedAt = getProfileTimeValue(left.updated_at ?? left.created_at);
    const rightUpdatedAt = getProfileTimeValue(right.updated_at ?? right.created_at);

    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    return getProfileTimeValue(right.created_at) - getProfileTimeValue(left.created_at);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkflowOutboundMirrorRequestPayload(value: unknown): boolean {
  return isRecord(value) && value.source === "ghl_workflow_outbound_mirror";
}

function isWorkflowProviderDispatchRequestPayload(value: unknown): boolean {
  return isRecord(value) && value.source === "ghl_workflow_provider_dispatch";
}

async function findCanonicalLineProfileByLineUser(
  tenantId: string,
  lineUserId: string
): Promise<LineProfileRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("line_user_id", lineUserId);

  if (error) {
    throw new Error(error.message);
  }

  const records = (data ?? []) as LineProfileRecord[];

  if (records.length === 0) {
    return null;
  }

  const [canonical] = sortCanonicalLineProfiles(records);

  if (records.length > 1) {
    logger.warn(
      {
        tenantId,
        lineUserId,
        duplicateCount: records.length,
        canonicalLineProfileId: canonical.id
      },
      "Duplicate line_profiles rows detected; using canonical row"
    );
  }

  return canonical;
}

export async function upsertGhlOAuthToken(input: UpsertGhlOAuthTokenInput): Promise<GhlOAuthTokenRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ghl_oauth_tokens")
    .upsert(
      {
        tenant_id: input.tenantId ?? null,
        location_id: input.locationId,
        company_id: input.companyId ?? null,
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
        expires_at: input.expiresAt,
        scopes: input.scopes ?? [],
        token_type: input.tokenType ?? null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "location_id" }
    )
    .select("*")
    .single();

  return requireSingle<GhlOAuthTokenRecord>(data, error);
}

export async function getGhlOAuthToken(locationId: string): Promise<GhlOAuthTokenRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ghl_oauth_tokens")
    .select("*")
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as GhlOAuthTokenRecord | null;
}

export async function getGhlOAuthTokenStatus(locationId: string): Promise<{
  location_id: string;
  token_present: boolean;
  refresh_token_present: boolean;
  expires_at: string | null;
  expired: boolean;
  scopes: string[];
  company_id: string | null;
}> {
  const token = await getGhlOAuthToken(locationId);

  if (!token) {
    return {
      location_id: locationId,
      token_present: false,
      refresh_token_present: false,
      expires_at: null,
      expired: true,
      scopes: [],
      company_id: null
    };
  }

  return {
    location_id: token.location_id,
    token_present: Boolean(token.access_token),
    refresh_token_present: Boolean(token.refresh_token),
    expires_at: token.expires_at,
    expired: new Date(token.expires_at).getTime() <= Date.now(),
    scopes: token.scopes ?? [],
    company_id: token.company_id
  };
}

export async function upsertGhlOAuthOnboardingSession(input: {
  appId: string;
  companyId: string;
  accessToken: string;
  expiresAt: string;
}): Promise<GhlOAuthOnboardingSessionRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ghl_oauth_onboarding_sessions")
    .upsert(
      {
        app_id: input.appId,
        company_id: input.companyId,
        access_token: input.accessToken,
        status: "active",
        expires_at: input.expiresAt,
        last_reconciled_at: null,
        error_code: null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "app_id,company_id" }
    )
    .select("*")
    .single();

  return requireSingle<GhlOAuthOnboardingSessionRecord>(data, error);
}

export async function getActiveGhlOAuthOnboardingSession(
  appId: string,
  companyId: string
): Promise<GhlOAuthOnboardingSessionRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ghl_oauth_onboarding_sessions")
    .select("*")
    .eq("app_id", appId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const session = data as GhlOAuthOnboardingSessionRecord | null;

  if (!session || session.status !== "active" || !session.access_token) {
    return null;
  }

  if (new Date(session.expires_at).getTime() > Date.now()) {
    return session;
  }

  const { error: expireError } = await supabase
    .from("ghl_oauth_onboarding_sessions")
    .update({
      access_token: null,
      status: "expired",
      error_code: "oauth_onboarding_session_expired",
      updated_at: new Date().toISOString()
    })
    .eq("id", session.id)
    .eq("status", "active");

  if (expireError) {
    throw new Error(expireError.message);
  }

  return null;
}

export async function markGhlOAuthOnboardingSessionReconciled(sessionId: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("ghl_oauth_onboarding_sessions")
    .update({
      last_reconciled_at: new Date().toISOString(),
      error_code: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .eq("status", "active");

  if (error) {
    throw new Error(error.message);
  }
}

export async function upsertPendingGhlAppInstall(input: {
  appId: string;
  companyId: string;
  locationId: string;
  tenantId: string;
  deliveryKey: string;
}): Promise<GhlPendingAppInstallRecord> {
  const supabase = getSupabase();
  const insertPayload = {
    app_id: input.appId,
    company_id: input.companyId,
    location_id: input.locationId,
    tenant_id: input.tenantId,
    delivery_key: input.deliveryKey,
    status: "pending",
    error_code: null
  };
  const { data, error } = await supabase
    .from("ghl_pending_app_installs")
    .insert(insertPayload)
    .select("*")
    .single();

  if (!error) {
    return requireSingle<GhlPendingAppInstallRecord>(data, null);
  }

  if (error.code !== "23505") {
    throw new Error(error.message);
  }

  const { data: existingData, error: existingError } = await supabase
    .from("ghl_pending_app_installs")
    .select("*")
    .eq("app_id", input.appId)
    .eq("company_id", input.companyId)
    .eq("location_id", input.locationId)
    .single();
  const existing = requireSingle<GhlPendingAppInstallRecord>(existingData, existingError);

  if (existing.delivery_key === input.deliveryKey) {
    return existing;
  }

  const { data: reinstalledData, error: reinstalledError } = await supabase
    .from("ghl_pending_app_installs")
    .update({
      tenant_id: input.tenantId,
      delivery_key: input.deliveryKey,
      status: "pending",
      processing_started_at: null,
      completed_at: null,
      completed_session_id: null,
      error_code: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", existing.id)
    .select("*")
    .single();

  return requireSingle<GhlPendingAppInstallRecord>(reinstalledData, reinstalledError);
}

export async function getGhlPendingAppInstall(
  appId: string,
  companyId: string,
  locationId: string
): Promise<GhlPendingAppInstallRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ghl_pending_app_installs")
    .select("*")
    .eq("app_id", appId)
    .eq("company_id", companyId)
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as GhlPendingAppInstallRecord | null;
}

export async function listReconcileableGhlAppInstalls(
  appId: string,
  companyId: string
): Promise<GhlPendingAppInstallRecord[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("ghl_pending_app_installs")
    .select("*")
    .eq("app_id", appId)
    .eq("company_id", companyId)
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as GhlPendingAppInstallRecord[];
}

export async function claimGhlPendingAppInstall(id: string): Promise<GhlPendingAppInstallRecord | null> {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("ghl_pending_app_installs")
    .update({ status: "processing", processing_started_at: now, error_code: null, updated_at: now })
    .eq("id", id)
    .in("status", ["pending", "failed"])
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (data) {
    return data as GhlPendingAppInstallRecord;
  }

  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data: staleData, error: staleError } = await supabase
    .from("ghl_pending_app_installs")
    .update({ status: "processing", processing_started_at: now, error_code: null, updated_at: now })
    .eq("id", id)
    .eq("status", "processing")
    .lt("processing_started_at", staleBefore)
    .select("*")
    .maybeSingle();

  if (staleError) {
    throw new Error(staleError.message);
  }

  return staleData as GhlPendingAppInstallRecord | null;
}

export async function completeGhlPendingAppInstall(input: {
  id: string;
  sessionId?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const supabase = getSupabase();
  const { error } = await supabase
    .from("ghl_pending_app_installs")
    .update({
      status: "completed",
      processing_started_at: null,
      completed_at: now,
      completed_session_id: input.sessionId ?? null,
      error_code: null,
      updated_at: now
    })
    .eq("id", input.id);

  if (error) {
    throw new Error(error.message);
  }
}

export async function failGhlPendingAppInstall(id: string, errorCode: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("ghl_pending_app_installs")
    .update({
      status: "failed",
      processing_started_at: null,
      error_code: errorCode,
      updated_at: new Date().toISOString()
    })
    .eq("id", id);

  if (error) {
    throw new Error(error.message);
  }
}

export async function saveWebhookEvent(input: SaveWebhookEventInput): Promise<WebhookEventRecord> {
  const supabase = getSupabase();
  const insertPayload = {
    source: input.source,
    event_id: input.eventId ?? null,
    payload: input.payload
  };

  const { data, error } = await supabase.from("webhook_events").insert(insertPayload).select("*").single();

  if (!error) {
    return requireSingle<WebhookEventRecord>(data, null);
  }

  if (error.code === "23505" && input.eventId) {
    const { data: existing, error: existingError } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("source", input.source)
      .eq("event_id", input.eventId)
      .single();

    return requireSingle<WebhookEventRecord>(existing, existingError);
  }

  throw new Error(error.message);
}

export async function markWebhookEventProcessed(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    throw new Error(error.message);
  }
}

export async function ensureDefaultTenant(): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tenants")
    .upsert(
      {
        location_id: requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID),
        ghl_provider_id: requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID),
        line_channel_id: "default"
      },
      { onConflict: "location_id,ghl_provider_id,line_channel_id" }
    )
    .select("id")
    .single();

  return requireSingle<{ id: string }>(data, error).id;
}

export async function getTenantById(tenantId: string): Promise<TenantRecord | null> {
  const normalizedTenantId = tenantId.trim();

  if (!normalizedTenantId) {
    return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", normalizedTenantId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as TenantRecord | null;
}

export async function getTenantByLocationId(locationId: string): Promise<TenantRecord | null> {
  const normalizedLocationId = locationId.trim();

  if (!normalizedLocationId) {
    return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("location_id", normalizedLocationId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as TenantRecord | null;
}

export async function getTenantIdsByLocationId(locationId: string): Promise<string[]> {
  const normalizedLocationId = locationId.trim();

  if (!normalizedLocationId) {
    return [];
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("location_id", normalizedLocationId)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? [])
    .map((tenant) => (typeof tenant.id === "string" ? tenant.id : undefined))
    .filter((tenantId): tenantId is string => Boolean(tenantId));
}

export async function ensureTenantForLocation(locationId: string): Promise<TenantRecord> {
  const normalizedLocationId = locationId.trim();

  if (!normalizedLocationId) {
    throw new Error("locationId is required");
  }

  const existing = await getTenantByLocationId(normalizedLocationId);

  if (existing) {
    return existing;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("tenants")
    .insert({
      location_id: normalizedLocationId,
      ghl_provider_id: requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID),
      line_channel_id: "default"
    })
    .select("*")
    .single();

  if (error?.code === "23505") {
    const concurrentExisting = await getTenantByLocationId(normalizedLocationId);

    if (concurrentExisting) {
      return concurrentExisting;
    }
  }

  if (!error) {
    logger.info({ locationId: normalizedLocationId }, "Auto-created tenant for GHL location");
  }

  return requireSingle<TenantRecord>(data, error);
}

export async function getLineChannelByWebhookKey(webhookKey: string): Promise<LineChannelRecord | null> {
  const normalizedWebhookKey = webhookKey.trim();

  if (!normalizedWebhookKey) {
    return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .select("*")
    .eq("webhook_key", normalizedWebhookKey)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineChannelRecord | null;
}

export async function getLineChannelById(lineChannelId: string): Promise<LineChannelRecord | null> {
  const normalizedLineChannelId = lineChannelId.trim();

  if (!normalizedLineChannelId) {
    return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .select("*")
    .eq("id", normalizedLineChannelId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineChannelRecord | null;
}

export async function getLineChannelByTenantId(tenantId: string): Promise<LineChannelRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineChannelRecord | null;
}

export async function getActiveLineChannelByTenantId(tenantId: string): Promise<LineChannelRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineChannelRecord | null;
}

export async function upsertLineChannelByTenantId(input: UpsertLineChannelInput): Promise<LineChannelRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .upsert(
      {
        tenant_id: input.tenantId,
        webhook_key: input.webhookKey,
        channel_access_token: input.channelAccessToken,
        channel_secret: input.channelSecret,
        is_active: input.isActive ?? true,
        updated_at: new Date().toISOString()
      },
      { onConflict: "tenant_id" }
    )
    .select("*")
    .single();

  return requireSingle<LineChannelRecord>(data, error);
}

export async function setLineChannelActiveByTenantId(
  tenantId: string,
  isActive: boolean
): Promise<LineChannelRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_channels")
    .update({
      is_active: isActive,
      updated_at: new Date().toISOString()
    })
    .eq("tenant_id", tenantId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineChannelRecord | null;
}

export async function upsertLineProfile(input: UpsertLineProfileInput): Promise<LineProfileRecord> {
  const supabase = getSupabase();
  const upsertPayload: {
    tenant_id: string;
    line_user_id: string;
    line_source_type: string;
    line_source_id: string;
    line_channel_id?: string;
    display_name: string | null;
    picture_url: string | null;
    updated_at: string;
  } = {
    tenant_id: input.tenantId,
    line_user_id: input.lineUserId,
    line_source_type: input.lineSourceType,
    line_source_id: input.lineSourceId,
    display_name: input.displayName ?? null,
    picture_url: input.pictureUrl ?? null,
    updated_at: new Date().toISOString()
  };

  if (input.lineChannelId) {
    upsertPayload.line_channel_id = input.lineChannelId;
  }

  const { data, error } = await supabase
    .from("line_profiles")
    .upsert(upsertPayload, { onConflict: "tenant_id,line_user_id" })
    .select("*")
    .single();

  return requireSingle<LineProfileRecord>(data, error);
}

export async function findLineProfileByLineUser(tenantId: string, lineUserId: string): Promise<LineProfileRecord | null> {
  return findCanonicalLineProfileByLineUser(tenantId, lineUserId);
}

export async function findLineProfileByGhlIds(
  tenantId: string,
  ids: { contactId?: string; conversationId?: string }
): Promise<LineProfileRecord | null> {
  return findLineProfileByGhlIdsForTenantIds([tenantId], ids);
}

export async function findLineProfileByGhlIdsForTenantIds(
  tenantIds: string[],
  ids: { contactId?: string; conversationId?: string }
): Promise<LineProfileRecord | null> {
  const normalizedTenantIds = tenantIds.map((tenantId) => tenantId.trim()).filter(Boolean);

  if (normalizedTenantIds.length === 0) {
    return null;
  }

  const supabase = getSupabase();
  let query = supabase
    .from("line_profiles")
    .select("*")
    .in("tenant_id", normalizedTenantIds)
    .order("updated_at", { ascending: false });

  if (!ids.conversationId && !ids.contactId) {
    return null;
  }

  if (ids.conversationId) {
    query = query.eq("ghl_conversation_id", ids.conversationId);
  }

  if (ids.contactId) {
    query = query.eq("ghl_contact_id", ids.contactId);
  }

  if (ids.contactId && !ids.conversationId) {
    const { data, error } = await query.limit(2);

    if (error) {
      throw new Error(error.message);
    }

    const matches = (data ?? []) as LineProfileRecord[];

    if (matches.length > 1) {
      logger.warn(
        {
          tenantIds: normalizedTenantIds,
          contactId: ids.contactId,
          matchCount: matches.length
        },
        "Rejected ambiguous tenant-scoped LINE profile contact fallback"
      );

      return null;
    }

    return matches[0] ?? null;
  }

  const { data, error } = await query.limit(1).maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineProfileRecord | null;
}

export async function findLatestLineProfileWithGhlContact(): Promise<LineProfileRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_profiles")
    .select("*")
    .not("ghl_contact_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineProfileRecord | null;
}

export async function findLatestLineProfileWithGhlContactForLocation(locationId: string): Promise<LineProfileRecord | null> {
  const supabase = getSupabase();
  const { data: tenants, error: tenantsError } = await supabase
    .from("tenants")
    .select("id")
    .eq("location_id", locationId);

  if (tenantsError) {
    throw new Error(tenantsError.message);
  }

  const tenantIds = (tenants ?? [])
    .map((tenant) => (typeof tenant.id === "string" ? tenant.id : undefined))
    .filter((tenantId): tenantId is string => Boolean(tenantId));

  if (tenantIds.length === 0) {
    return null;
  }

  const { data, error } = await supabase
    .from("line_profiles")
    .select("*")
    .in("tenant_id", tenantIds)
    .not("line_user_id", "is", null)
    .neq("line_user_id", "")
    .not("ghl_contact_id", "is", null)
    .neq("ghl_contact_id", "")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineProfileRecord | null;
}

export async function linkGhlMapping(input: {
  tenantId: string;
  lineUserId: string;
  ghlContactId?: string;
  ghlConversationId?: string;
}): Promise<LineProfileRecord> {
  const supabase = getSupabase();
  const existing = await findCanonicalLineProfileByLineUser(input.tenantId, input.lineUserId);

  if (!existing) {
    throw new Error("LINE profile does not exist for GHL mapping update");
  }

  const patch: Record<string, string | null> = {
    updated_at: new Date().toISOString()
  };

  if (input.ghlContactId) {
    patch.ghl_contact_id = input.ghlContactId;
  }

  if (input.ghlConversationId) {
    patch.ghl_conversation_id = input.ghlConversationId;
  }

  const { data, error } = await supabase
    .from("line_profiles")
    .update(patch)
    .eq("id", existing.id)
    .select("*")
    .single();

  if (!error) {
    logger.info(
      {
        tenantId: input.tenantId,
        lineUserId: input.lineUserId,
        lineProfileId: existing.id,
        ghlContactId: input.ghlContactId,
        ghlConversationId: input.ghlConversationId
      },
      "Updated LINE profile GHL mapping"
    );
  }

  return requireSingle<LineProfileRecord>(data, error);
}

export async function clearGhlMapping(input: { tenantId: string; lineUserId: string }): Promise<LineProfileRecord> {
  const supabase = getSupabase();
  const existing = await findCanonicalLineProfileByLineUser(input.tenantId, input.lineUserId);

  if (!existing) {
    throw new Error("LINE profile does not exist for GHL mapping clear");
  }

  const { data, error } = await supabase
    .from("line_profiles")
    .update({
      ghl_contact_id: null,
      ghl_conversation_id: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", existing.id)
    .select("*")
    .single();

  if (!error) {
    logger.info(
      {
        tenantId: input.tenantId,
        lineUserId: input.lineUserId,
        lineProfileId: existing.id,
        oldGhlContactId: existing.ghl_contact_id,
        oldGhlConversationId: existing.ghl_conversation_id
      },
      "Cleared LINE profile GHL mapping"
    );
  }

  return requireSingle<LineProfileRecord>(data, error);
}

export async function findWorkflowOutboundMirrorMessageEvent(input: {
  tenantId: string;
  ghlMessageId?: string;
}): Promise<WorkflowOutboundMirrorEventRecord | null> {
  return findWorkflowOutboundMirrorMessageEventForTenantIds({
    tenantIds: [input.tenantId],
    ghlMessageId: input.ghlMessageId
  });
}

export async function findWorkflowOutboundMirrorMessageEventForTenantIds(input: {
  tenantIds: string[];
  ghlMessageId?: string;
}): Promise<WorkflowOutboundMirrorEventRecord | null> {
  const normalizedTenantIds = input.tenantIds.map((tenantId) => tenantId.trim()).filter(Boolean);
  const normalizedGhlMessageId = input.ghlMessageId?.trim();

  if (normalizedTenantIds.length === 0 || !normalizedGhlMessageId) {
    return null;
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("message_events")
    .select("id, tenant_id, ghl_message_id, request_payload, created_at")
    .in("tenant_id", normalizedTenantIds)
    .eq("provider", "ghl")
    .eq("direction", "outbound")
    .eq("ghl_message_id", normalizedGhlMessageId)
    .contains("request_payload", { source: "ghl_workflow_outbound_mirror" })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const record = data as WorkflowOutboundMirrorEventRecord | null;

  if (!record || !isWorkflowOutboundMirrorRequestPayload(record.request_payload)) {
    return null;
  }

  return record;
}

export async function findWorkflowProviderDispatchMessageEvent(input: {
  tenantId: string;
  ghlMessageId: string;
  lineUserId: string;
  ghlContactId?: string;
  ghlConversationId?: string;
}): Promise<WorkflowProviderDispatchEventRecord | null> {
  const tenantId = input.tenantId.trim();
  const ghlMessageId = input.ghlMessageId.trim();
  const lineUserId = input.lineUserId.trim();
  const ghlContactId = input.ghlContactId?.trim();
  const ghlConversationId = input.ghlConversationId?.trim();

  if (!tenantId || !ghlMessageId || !lineUserId) {
    return null;
  }

  const supabase = getSupabase();
  let query = supabase
    .from("message_events")
    .select(
      "id, tenant_id, line_user_id, ghl_message_id, ghl_conversation_id, request_payload, created_at"
    )
    .eq("tenant_id", tenantId)
    .eq("provider", "ghl")
    .eq("direction", "outbound")
    .eq("status", "success")
    .eq("ghl_message_id", ghlMessageId)
    .eq("line_user_id", lineUserId)
    .contains("request_payload", {
      source: "ghl_workflow_provider_dispatch",
      ...(ghlContactId ? { contactId: ghlContactId } : {})
    });

  if (ghlConversationId) {
    query = query.eq("ghl_conversation_id", ghlConversationId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const record = data as WorkflowProviderDispatchEventRecord | null;

  if (
    !record ||
    record.tenant_id !== tenantId ||
    record.ghl_message_id !== ghlMessageId ||
    record.line_user_id !== lineUserId ||
    (ghlConversationId && record.ghl_conversation_id !== ghlConversationId) ||
    !isWorkflowProviderDispatchRequestPayload(record.request_payload)
  ) {
    return null;
  }

  return record;
}

export async function claimGhlOutboundProviderDelivery(
  input: ClaimGhlOutboundProviderDeliveryInput
): Promise<GhlOutboundProviderDeliveryClaimResult> {
  const tenantId = input.tenantId.trim();
  const ghlMessageId = input.ghlMessageId.trim();

  if (!tenantId || !ghlMessageId) {
    throw new Error("tenantId and ghlMessageId are required for outbound provider delivery claim");
  }

  const externalMessageId = `ghl-provider-delivery:${ghlMessageId}`;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("message_events")
    .insert({
      tenant_id: tenantId,
      provider: "ghl",
      direction: "outbound",
      external_message_id: externalMessageId,
      line_user_id: input.lineUserId,
      ghl_message_id: ghlMessageId,
      ghl_conversation_id: input.ghlConversationId ?? null,
      payload: input.payload,
      status: "received",
      error_message: null,
      request_payload: input.requestPayload
    })
    .select("id")
    .single();

  if (error?.code === "23505") {
    return { claimed: false, externalMessageId };
  }

  if (error) {
    throw new Error(error.message);
  }

  const eventId = isRecord(data) && typeof data.id === "string" ? data.id : undefined;

  if (!eventId) {
    throw new Error("Outbound provider delivery claim did not return a message event ID");
  }

  return { claimed: true, eventId, externalMessageId };
}

export async function finalizeGhlOutboundProviderDelivery(
  input: FinalizeGhlOutboundProviderDeliveryInput
): Promise<void> {
  const eventId = input.eventId.trim();
  const tenantId = input.tenantId.trim();

  if (!eventId || !tenantId) {
    throw new Error("eventId and tenantId are required to finalize outbound provider delivery");
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("message_events")
    .update({
      status: input.status,
      line_user_id: input.lineUserId,
      ghl_message_id: input.ghlMessageId,
      ghl_conversation_id: input.ghlConversationId ?? null,
      error_message: input.errorMessage ?? null,
      request_payload: input.requestPayload
    })
    .eq("id", eventId)
    .eq("tenant_id", tenantId)
    .eq("provider", "ghl")
    .eq("direction", "outbound")
    .eq("ghl_message_id", input.ghlMessageId)
    .eq("status", "received")
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Outbound provider delivery claim was not found for finalization");
  }
}

export async function saveMessageEvent(input: SaveMessageEventInput): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("message_events").insert({
    tenant_id: input.tenantId,
    provider: input.provider,
    direction: input.direction,
    external_message_id: input.externalMessageId ?? null,
    line_user_id: input.lineUserId ?? null,
    ghl_message_id: input.ghlMessageId ?? null,
    ghl_conversation_id: input.ghlConversationId ?? null,
    payload: input.payload,
    status: input.status,
    error_message: input.errorMessage ?? null,
    ghl_status_code: input.ghlStatusCode ?? null,
    ghl_response_body: input.ghlResponseBody ?? null,
    request_payload: input.requestPayload ?? null
  });

  if (error && error.code !== "23505") {
    throw new Error(error.message);
  }
}

export async function getRecentDebugEvents(): Promise<{
  lineProfiles: LineProfileRecord[];
  messageEvents: unknown[];
  webhookEvents: WebhookEventRecord[];
}> {
  const supabase = getSupabase();
  const [lineProfiles, messageEvents, webhookEvents] = await Promise.all([
    supabase.from("line_profiles").select("*").order("updated_at", { ascending: false }).limit(10),
    supabase.from("message_events").select("*").order("created_at", { ascending: false }).limit(10),
    supabase.from("webhook_events").select("*").order("created_at", { ascending: false }).limit(10)
  ]);

  if (lineProfiles.error) {
    throw new Error(lineProfiles.error.message);
  }

  if (messageEvents.error) {
    throw new Error(messageEvents.error.message);
  }

  if (webhookEvents.error) {
    throw new Error(webhookEvents.error.message);
  }

  return {
    lineProfiles: (lineProfiles.data ?? []) as LineProfileRecord[],
    messageEvents: messageEvents.data ?? [],
    webhookEvents: (webhookEvents.data ?? []) as WebhookEventRecord[]
  };
}
