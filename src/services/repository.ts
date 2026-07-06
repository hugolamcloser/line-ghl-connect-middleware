import { env, requireEnvValue } from "../config/env";
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
};

export type UpsertLineProfileInput = {
  tenantId: string;
  lineUserId: string;
  lineSourceType: string;
  lineSourceId: string;
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

function requireSingle<T>(data: T | null, error: { message: string } | null): T {
  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Supabase returned no data");
  }

  return data;
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

export async function upsertLineProfile(input: UpsertLineProfileInput): Promise<LineProfileRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_profiles")
    .upsert(
      {
        tenant_id: input.tenantId,
        line_user_id: input.lineUserId,
        line_source_type: input.lineSourceType,
        line_source_id: input.lineSourceId,
        display_name: input.displayName ?? null,
        picture_url: input.pictureUrl ?? null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "tenant_id,line_source_id,line_user_id" }
    )
    .select("*")
    .single();

  return requireSingle<LineProfileRecord>(data, error);
}

export async function findLineProfileByLineUser(tenantId: string, lineUserId: string): Promise<LineProfileRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("line_user_id", lineUserId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data as LineProfileRecord | null;
}

export async function findLineProfileByGhlIds(
  tenantId: string,
  ids: { contactId?: string; conversationId?: string }
): Promise<LineProfileRecord | null> {
  const supabase = getSupabase();
  let query = supabase.from("line_profiles").select("*").eq("tenant_id", tenantId);

  if (ids.conversationId) {
    query = query.eq("ghl_conversation_id", ids.conversationId);
  } else if (ids.contactId) {
    query = query.eq("ghl_contact_id", ids.contactId);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();

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
    .eq("tenant_id", input.tenantId)
    .eq("line_user_id", input.lineUserId)
    .select("*")
    .single();

  return requireSingle<LineProfileRecord>(data, error);
}

export async function clearGhlMapping(input: { tenantId: string; lineUserId: string }): Promise<LineProfileRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("line_profiles")
    .update({
      ghl_contact_id: null,
      ghl_conversation_id: null,
      updated_at: new Date().toISOString()
    })
    .eq("tenant_id", input.tenantId)
    .eq("line_user_id", input.lineUserId)
    .select("*")
    .single();

  return requireSingle<LineProfileRecord>(data, error);
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
