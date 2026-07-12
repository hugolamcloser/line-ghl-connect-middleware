import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import { redactSensitiveText } from "../utils/redaction";
import {
  claimGhlPendingAppInstall,
  completeGhlPendingAppInstall,
  ensureTenantForLocation,
  failGhlPendingAppInstall,
  getActiveGhlOAuthOnboardingSession,
  getGhlOAuthToken,
  getGhlOAuthTokenStatus,
  getGhlPendingAppInstall,
  listReconcileableGhlAppInstalls,
  markGhlOAuthOnboardingSessionReconciled,
  upsertGhlOAuthOnboardingSession,
  upsertGhlOAuthToken,
  upsertPendingGhlAppInstall,
  type GhlPendingAppInstallRecord,
  type GhlOAuthTokenRecord
} from "./repository";

const tokenRefreshSkewMs = 5 * 60 * 1000;
const tokenExchangeTimeoutMs = 15000;
const companyOnboardingSessionTtlMs = 15 * 60 * 1000;
const highLevelV3Version = "v3";

export type GhlOAuthErrorCode =
  | "token_exchange_failed"
  | "token_response_parse_failed"
  | "oauth_storage_failed"
  | "oauth_missing_location_id"
  | "oauth_missing_company_id"
  | "oauth_missing_marketplace_app_id"
  | "oauth_missing_installed_locations"
  | "oauth_location_token_mismatch"
  | "oauth_app_id_mismatch"
  | "oauth_onboarding_reconciliation_failed";

type GhlOAuthTokenPayload = {
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
  expires_in?: number | string;
  expiresIn?: number | string;
  expires_at?: string;
  scope?: string;
  scopes?: string[] | string;
  token_type?: string;
  tokenType?: string;
  locationId?: string;
  location_id?: string;
  companyId?: string;
  company_id?: string;
  userType?: string;
  user_type?: string;
  approvedLocations?: unknown;
  approved_locations?: unknown;
  isBulkInstallation?: boolean | string;
  is_bulk_installation?: boolean | string;
  appId?: string;
  app_id?: string;
  versionId?: string;
  version_id?: string;
  [key: string]: unknown;
};

type SaveTokenPayloadFallbackMetadata = {
  companyId?: string | null;
  scopes?: string[] | null;
  tokenType?: string | null;
};

type GhlOAuthSafeLocationStatus = {
  location_id: string;
  tenant_id: string;
  token_present: boolean;
  refresh_token_present: boolean;
  expires_at: string | null;
};

type GhlOAuthCompanyInstallStatus = {
  mode: "company_to_location";
  company_id: string;
  status: "completed_locations" | "pending_app_install" | "failed";
  locations: GhlOAuthSafeLocationStatus[];
};

export type GhlOAuthInstallStatus =
  | (Awaited<ReturnType<typeof getGhlOAuthTokenStatus>> & {
      mode: "direct_location";
      status: "direct_location";
    })
  | GhlOAuthCompanyInstallStatus;

export type GhlOAuthOnboardingReconciliationResult = {
  status: "completed_locations" | "pending_app_install" | "failed";
  locations: GhlOAuthSafeLocationStatus[];
  failed_location_ids: string[];
};

export type GhlAuthContext = {
  mode: "oauth" | "private_integration";
  accessToken: string;
  locationId: string;
};

export class GhlOAuthError extends Error {
  public readonly publicErrorCode: GhlOAuthErrorCode;
  public readonly statusCode?: number;
  public readonly responseBody?: string;
  public readonly requestPayload?: unknown;

  constructor(input: {
    publicErrorCode: GhlOAuthErrorCode;
    message: string;
    statusCode?: number;
    responseBody?: string;
    requestPayload?: unknown;
  }) {
    super(input.message);
    this.name = "GhlOAuthError";
    this.publicErrorCode = input.publicErrorCode;
    this.statusCode = input.statusCode;
    this.responseBody = input.responseBody;
    this.requestPayload = input.requestPayload;
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNestedString(payload: Record<string, unknown>, ...path: string[]): string | undefined {
  let current: unknown = payload;

  for (const key of path) {
    const record = getRecord(current);

    if (!record || !(key in record)) {
      return undefined;
    }

    current = record[key];
  }

  return getString(current);
}

function getNestedRecord(payload: Record<string, unknown>, ...path: string[]): Record<string, unknown> | undefined {
  let current: unknown = payload;

  for (const key of path) {
    const record = getRecord(current);

    if (!record || !(key in record)) {
      return undefined;
    }

    current = record[key];
  }

  return getRecord(current);
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
}

function getAccessToken(payload: GhlOAuthTokenPayload): string | undefined {
  return getString(payload.access_token) ?? getString(payload.accessToken);
}

function getRefreshToken(payload: GhlOAuthTokenPayload): string | undefined {
  return getString(payload.refresh_token) ?? getString(payload.refreshToken);
}

function getTokenType(payload: GhlOAuthTokenPayload): string | undefined {
  return getString(payload.token_type) ?? getString(payload.tokenType);
}

function getUserType(payload: GhlOAuthTokenPayload): string | undefined {
  return getString(payload.user_type) ?? getString(payload.userType);
}

function getAppId(payload: GhlOAuthTokenPayload): string | undefined {
  return getString(payload.app_id) ?? getString(payload.appId);
}

function getVersionId(payload: GhlOAuthTokenPayload): string | undefined {
  return getString(payload.version_id) ?? getString(payload.versionId);
}

function getIsBulkInstallation(payload: GhlOAuthTokenPayload): boolean | undefined {
  return getBoolean(payload.is_bulk_installation) ?? getBoolean(payload.isBulkInstallation);
}

function parseScopes(payload: GhlOAuthTokenPayload): string[] {
  if (Array.isArray(payload.scopes)) {
    return payload.scopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
  }

  const scopes = getString(payload.scopes) ?? getString(payload.scope);
  return scopes ? scopes.split(/\s+/).filter(Boolean) : [];
}

function hasScopeMetadata(payload: GhlOAuthTokenPayload): boolean {
  return Object.prototype.hasOwnProperty.call(payload, "scope") || Object.prototype.hasOwnProperty.call(payload, "scopes");
}

function normalizeScopes(scopes: string[] | null | undefined): string[] {
  return (scopes ?? []).filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
}

function parseClaimScopes(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
  }

  const scopes = getString(value);
  return scopes ? scopes.split(/\s+/).filter(Boolean) : undefined;
}

function decodeBase64UrlJson(part: string): Record<string, unknown> {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  const parsed = JSON.parse(decoded) as unknown;
  const record = getRecord(parsed);

  if (!record) {
    throw new Error("JWT part did not decode to an object");
  }

  return record;
}

function decodeJwtHeaderAndPayload(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [headerPart, payloadPart] = token.split(".");

  if (!headerPart || !payloadPart) {
    throw new Error("Stored access token is not a JWT");
  }

  return {
    header: decodeBase64UrlJson(headerPart),
    payload: decodeBase64UrlJson(payloadPart)
  };
}

function getExpiresAt(payload: GhlOAuthTokenPayload): string {
  const explicitExpiresAt = getString(payload.expires_at);

  if (explicitExpiresAt) {
    return new Date(explicitExpiresAt).toISOString();
  }

  const expiresIn = getNumber(payload.expires_in) ?? getNumber(payload.expiresIn) ?? 3600;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function getCompanyOnboardingSessionExpiresAt(payload: GhlOAuthTokenPayload): string {
  const tokenExpiresAt = new Date(getExpiresAt(payload)).getTime();
  const shortLivedExpiry = Date.now() + companyOnboardingSessionTtlMs;
  return new Date(Math.min(tokenExpiresAt, shortLivedExpiry)).toISOString();
}

function isExpiredOrClose(token: GhlOAuthTokenRecord): boolean {
  return new Date(token.expires_at).getTime() <= Date.now() + tokenRefreshSkewMs;
}

function buildTokenRequestBody(entries: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(entries)) {
    if (value) {
      body.set(key, value);
    }
  }

  return body;
}

function getSafeTokenRequestDiagnostics(entries: Record<string, string>) {
  return {
    bodyKeys: Object.keys(entries).filter((key) => Boolean(entries[key])),
    grantType: entries.grant_type,
    codePresent: Boolean(entries.code),
    clientIdPresent: Boolean(entries.client_id),
    clientSecretPresent: Boolean(entries.client_secret),
    redirectUri: entries.redirect_uri
  };
}

function redactTokenExchangeText(value: string, entries: Record<string, string>): string {
  let redacted = redactSensitiveText(value);

  for (const sensitiveValue of [entries.code, entries.client_secret]) {
    if (sensitiveValue) {
      redacted = redacted.split(sensitiveValue).join("[redacted]");
    }
  }

  return redacted;
}

function parseTokenResponse(responseText: string): GhlOAuthTokenPayload {
  try {
    return responseText ? (JSON.parse(responseText) as GhlOAuthTokenPayload) : {};
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        redactedResponseText: redactSensitiveText(responseText)
      },
      "Failed to parse HighLevel OAuth token response"
    );
    throw new GhlOAuthError({
      publicErrorCode: "token_response_parse_failed",
      message: "HighLevel OAuth token response was not valid JSON",
      responseBody: redactSensitiveText(responseText)
    });
  }
}

function getTokenPayloadKeys(payload: GhlOAuthTokenPayload): string[] {
  return Object.keys(payload);
}

function resolveTokenLocationId(payload: GhlOAuthTokenPayload): string | undefined {
  return (
    getString(payload.locationId) ??
    getString(payload.location_id) ??
    getNestedString(payload, "location", "id") ??
    getNestedString(payload, "location", "locationId") ??
    getNestedString(payload, "location", "_id") ??
    getNestedString(payload, "activeLocation", "id") ??
    getNestedString(payload, "activeLocation", "locationId")
  );
}

function resolveTokenCompanyId(payload: GhlOAuthTokenPayload): string | undefined {
  return (
    getString(payload.companyId) ??
    getString(payload.company_id) ??
    getNestedString(payload, "company", "id") ??
    getNestedString(payload, "company", "companyId")
  );
}

function getLocationIdFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return getString(value);
  }

  const record = getRecord(value);

  if (!record) {
    return undefined;
  }

  return (
    getString(record._id) ??
    getString(record.id) ??
    getString(record.locationId) ??
    getString(record.location_id)
  );
}

function uniqueLocationIds(locationIds: Array<string | undefined>): string[] {
  return Array.from(new Set(locationIds.map((locationId) => locationId?.trim()).filter((locationId): locationId is string => Boolean(locationId))));
}

function parseLocationIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueLocationIds(value.map(getLocationIdFromUnknown));
  }

  const locationId = getLocationIdFromUnknown(value);
  return locationId ? [locationId] : [];
}

function getApprovedLocationIds(payload: GhlOAuthTokenPayload): string[] {
  return uniqueLocationIds([
    ...parseLocationIds(payload.approved_locations),
    ...parseLocationIds(payload.approvedLocations)
  ]);
}

function isCompanyTokenPayload(payload: GhlOAuthTokenPayload): boolean {
  const userType = getUserType(payload)?.toLowerCase();
  const locationId = resolveTokenLocationId(payload);
  const accessToken = getAccessToken(payload);

  return userType === "company" || Boolean(!locationId && accessToken);
}

async function requestOAuthToken(entries: Record<string, string>): Promise<GhlOAuthTokenPayload> {
  const body = buildTokenRequestBody(entries);
  const requestDiagnostics = getSafeTokenRequestDiagnostics(Object.fromEntries(body.entries()));

  logger.info(
    {
      tokenUrl: env.GHL_OAUTH_TOKEN_URL,
      redirectUri: entries.redirect_uri,
      clientIdPresent: Boolean(entries.client_id),
      clientSecretPresent: Boolean(entries.client_secret),
      tokenRequestBodyKeys: requestDiagnostics.bodyKeys
    },
    "Requesting HighLevel OAuth token"
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), tokenExchangeTimeoutMs);
  let response: Response;

  try {
    response = await fetch(env.GHL_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body,
      signal: controller.signal
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const message = timedOut
      ? `HighLevel OAuth token exchange timed out after ${tokenExchangeTimeoutMs}ms`
      : `HighLevel OAuth token exchange request failed: ${error instanceof Error ? error.message : String(error)}`;

    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        timedOut,
        tokenUrl: env.GHL_OAUTH_TOKEN_URL,
        tokenRequestBodyKeys: requestDiagnostics.bodyKeys
      },
      "HighLevel OAuth token exchange request failed"
    );

    throw new GhlOAuthError({
      publicErrorCode: "token_exchange_failed",
      message,
      requestPayload: requestDiagnostics
    });
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  const redactedResponseText = redactTokenExchangeText(responseText, entries);

  logger.info(
    {
      status: response.status,
      ok: response.ok
    },
    "HighLevel OAuth token exchange response received"
  );

  if (!response.ok) {
    throw new GhlOAuthError({
      publicErrorCode: "token_exchange_failed",
      message: `HighLevel OAuth token exchange failed with status ${response.status}`,
      statusCode: response.status,
      responseBody: redactedResponseText,
      requestPayload: requestDiagnostics
    });
  }

  const payload = parseTokenResponse(responseText);
  logger.info({ tokenResponseKeys: getTokenPayloadKeys(payload) }, "Parsed HighLevel OAuth token response");

  return payload;
}

async function requestLocationToken(input: {
  companyAccessToken: string;
  companyId: string;
  locationId: string;
}): Promise<GhlOAuthTokenPayload> {
  const body = buildTokenRequestBody({
    companyId: input.companyId,
    locationId: input.locationId
  });

  const response = await fetch(new URL("/oauth/location-token", env.GHL_API_BASE_URL).toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.companyAccessToken}`,
      Version: highLevelV3Version,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });
  const responseText = await response.text();

  logger.info(
    {
      companyId: input.companyId,
      locationId: input.locationId,
      status: response.status,
      ok: response.ok
    },
    "HighLevel location-token response received"
  );

  if (!response.ok) {
    throw new GhlOAuthError({
      publicErrorCode: "token_exchange_failed",
      message: `HighLevel location-token exchange failed with status ${response.status}`,
      statusCode: response.status,
      responseBody: redactSensitiveText(responseText)
    });
  }

  const payload = parseTokenResponse(responseText);
  logger.info(
    {
      companyId: input.companyId,
      locationId: input.locationId,
      tokenResponseKeys: getTokenPayloadKeys(payload)
    },
    "Parsed HighLevel location-token response"
  );

  return payload;
}

async function saveTokenPayload(
  payload: GhlOAuthTokenPayload,
  fallbackLocationId?: string,
  fallbackRefreshToken?: string,
  fallbackMetadata: SaveTokenPayloadFallbackMetadata = {}
): Promise<GhlOAuthTokenRecord> {
  const accessToken = getAccessToken(payload);
  const refreshToken = getRefreshToken(payload) ?? fallbackRefreshToken;
  const resolvedLocationId = resolveTokenLocationId(payload);
  const fallbackLocationIdValue = getString(fallbackLocationId);
  const locationId = resolvedLocationId ?? fallbackLocationIdValue;
  const companyId = resolveTokenCompanyId(payload) ?? getString(fallbackMetadata.companyId);
  const scopes = hasScopeMetadata(payload) ? parseScopes(payload) : normalizeScopes(fallbackMetadata.scopes);
  const tokenType = getTokenType(payload) ?? getString(fallbackMetadata.tokenType);

  logger.info(
    {
      tokenResponseKeys: getTokenPayloadKeys(payload),
      locationIdPresent: Boolean(locationId),
      resolvedLocationId: locationId,
      locationIdSource: resolvedLocationId ? "token_response" : fallbackLocationIdValue ? "caller_fallback" : "missing",
      companyIdPresent: Boolean(companyId),
      resolvedCompanyId: companyId
    },
    "Resolved HighLevel OAuth token install context"
  );

  if (!accessToken) {
    throw new GhlOAuthError({
      publicErrorCode: "token_response_parse_failed",
      message: "HighLevel OAuth response did not include access_token"
    });
  }

  if (!refreshToken) {
    throw new GhlOAuthError({
      publicErrorCode: "token_response_parse_failed",
      message: "HighLevel OAuth response did not include refresh_token"
    });
  }

  if (!locationId) {
    throw new GhlOAuthError({
      publicErrorCode: "oauth_missing_location_id",
      message: "HighLevel OAuth response did not include a location ID"
    });
  }

  let tenantId: string;

  try {
    const tenant = await ensureTenantForLocation(locationId);
    tenantId = tenant.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ locationId, companyId, error: message }, "Failed to resolve tenant before OAuth token upsert");
    throw new GhlOAuthError({
      publicErrorCode: "oauth_storage_failed",
      message: `Supabase tenant lookup failed before OAuth token storage: ${message}`
    });
  }

  logger.info({ locationId, companyId, tenantLinked: Boolean(tenantId) }, "Starting Supabase OAuth token upsert");

  try {
    const token = await upsertGhlOAuthToken({
      tenantId,
      locationId,
      companyId,
      accessToken,
      refreshToken,
      expiresAt: getExpiresAt(payload),
      scopes,
      tokenType
    });

    logger.info({ locationId: token.location_id, companyId: token.company_id, tokenRowId: token.id }, "Supabase OAuth token upsert succeeded");
    return token;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ locationId, companyId, error: message }, "Supabase OAuth token upsert failed");
    throw new GhlOAuthError({
      publicErrorCode: "oauth_storage_failed",
      message: `Supabase OAuth token storage failed: ${message}`
    });
  }
}

function validateLocationTokenPayload(input: {
  companyId: string;
  targetLocationId: string;
  payload: GhlOAuthTokenPayload;
}): void {
  const accessToken = getAccessToken(input.payload);
  const responseLocationId = resolveTokenLocationId(input.payload);

  if (!accessToken || !responseLocationId) {
    throw new GhlOAuthError({
      publicErrorCode: "oauth_missing_location_id",
      message: `HighLevel location-token response did not include a location-specific access token for location ${input.targetLocationId}`
    });
  }

  if (responseLocationId !== input.targetLocationId) {
    throw new GhlOAuthError({
      publicErrorCode: "oauth_location_token_mismatch",
      message: `HighLevel location-token response location ${responseLocationId} did not match requested location ${input.targetLocationId}`
    });
  }
}

function toSafeLocationStatus(
  pendingInstall: GhlPendingAppInstallRecord,
  token: GhlOAuthTokenRecord | null
): GhlOAuthSafeLocationStatus {
  const matchingToken = token?.location_id === pendingInstall.location_id && token.tenant_id === pendingInstall.tenant_id
    ? token
    : null;

  return {
    location_id: pendingInstall.location_id,
    tenant_id: pendingInstall.tenant_id,
    token_present: Boolean(matchingToken?.access_token),
    refresh_token_present: Boolean(matchingToken?.refresh_token),
    expires_at: matchingToken?.expires_at ?? null
  };
}

async function getReconciliationCandidates(input: {
  appId: string;
  companyId: string;
  locationIds?: string[];
}): Promise<GhlPendingAppInstallRecord[]> {
  if (!input.locationIds) {
    return listReconcileableGhlAppInstalls(input.appId, input.companyId);
  }

  const records = await Promise.all(
    uniqueLocationIds(input.locationIds).map((locationId) =>
      getGhlPendingAppInstall(input.appId, input.companyId, locationId)
    )
  );

  return records.filter((record): record is GhlPendingAppInstallRecord => Boolean(record));
}

export async function reconcileGhlOAuthOnboarding(input: {
  appId: string;
  companyId: string;
  locationIds?: string[];
}): Promise<GhlOAuthOnboardingReconciliationResult> {
  const candidates = await getReconciliationCandidates(input);
  const locations: GhlOAuthSafeLocationStatus[] = [];
  const failedLocationIds: string[] = [];
  const pendingCandidates: GhlPendingAppInstallRecord[] = [];

  for (const candidate of candidates) {
    if (candidate.status === "completed") {
      locations.push(toSafeLocationStatus(candidate, await getGhlOAuthToken(candidate.location_id)));
    } else {
      pendingCandidates.push(candidate);
    }
  }

  if (pendingCandidates.length === 0) {
    return {
      status: locations.length > 0 ? "completed_locations" : "pending_app_install",
      locations,
      failed_location_ids: []
    };
  }

  const session = await getActiveGhlOAuthOnboardingSession(input.appId, input.companyId);

  if (!session?.access_token) {
    logger.info(
      {
        appId: input.appId,
        companyId: input.companyId,
        targetLocationIds: pendingCandidates.map((candidate) => candidate.location_id),
        onboardingSessionPresent: false
      },
      "HighLevel AppInstall is pending a matching Company OAuth session"
    );
    return {
      status: "pending_app_install",
      locations,
      failed_location_ids: []
    };
  }

  for (const pendingInstall of pendingCandidates) {
    const claimedInstall = await claimGhlPendingAppInstall(pendingInstall.id);

    if (!claimedInstall) {
      continue;
    }

    try {
      const locationTokenPayload = await requestLocationToken({
        companyAccessToken: session.access_token,
        companyId: input.companyId,
        locationId: claimedInstall.location_id
      });

      validateLocationTokenPayload({
        companyId: input.companyId,
        targetLocationId: claimedInstall.location_id,
        payload: locationTokenPayload
      });

      const token = await saveTokenPayload(locationTokenPayload);

      if (token.location_id !== claimedInstall.location_id || token.tenant_id !== claimedInstall.tenant_id) {
        throw new GhlOAuthError({
          publicErrorCode: "oauth_storage_failed",
          message: `Stored OAuth token identity did not match pending installation for location ${claimedInstall.location_id}`
        });
      }

      await completeGhlPendingAppInstall({ id: claimedInstall.id, sessionId: session.id });
      locations.push(toSafeLocationStatus(claimedInstall, token));

      logger.info(
        {
          appId: input.appId,
          companyId: input.companyId,
          locationId: token.location_id,
          tenantId: token.tenant_id,
          tokenRowId: token.id,
          pendingInstallId: claimedInstall.id
        },
        "Completed exact HighLevel AppInstall OAuth reconciliation"
      );
    } catch (error) {
      const errorCode = error instanceof GhlOAuthError
        ? error.publicErrorCode
        : "oauth_onboarding_reconciliation_failed";
      await failGhlPendingAppInstall(claimedInstall.id, errorCode);
      failedLocationIds.push(claimedInstall.location_id);
      logger.error(
        {
          appId: input.appId,
          companyId: input.companyId,
          locationId: claimedInstall.location_id,
          tenantId: claimedInstall.tenant_id,
          errorCode
        },
        "Failed exact HighLevel AppInstall OAuth reconciliation"
      );
    }
  }

  await markGhlOAuthOnboardingSessionReconciled(session.id);

  return {
    status: failedLocationIds.length > 0
      ? "failed"
      : locations.length > 0
        ? "completed_locations"
        : "pending_app_install",
    locations,
    failed_location_ids: failedLocationIds
  };
}

export async function recordGhlAppInstall(input: {
  appId: string;
  companyId: string;
  locationId: string;
  deliveryKey: string;
}): Promise<GhlOAuthOnboardingReconciliationResult & { tenant_id: string }> {
  const configuredAppId = getString(env.GHL_MARKETPLACE_APP_ID);

  if (!configuredAppId || input.appId !== configuredAppId) {
    throw new GhlOAuthError({
      publicErrorCode: "oauth_app_id_mismatch",
      message: "HighLevel AppInstall appId did not match GHL_MARKETPLACE_APP_ID"
    });
  }

  const tenant = await ensureTenantForLocation(input.locationId);
  const pendingInstall = await upsertPendingGhlAppInstall({
    ...input,
    tenantId: tenant.id
  });

  logger.info(
    {
      appId: input.appId,
      companyId: input.companyId,
      locationId: input.locationId,
      tenantId: tenant.id,
      pendingInstallId: pendingInstall.id,
      pendingInstallStatus: pendingInstall.status
    },
    "Persisted idempotent HighLevel AppInstall correlation"
  );

  const result = await reconcileGhlOAuthOnboarding({
    appId: input.appId,
    companyId: input.companyId,
    locationIds: [input.locationId]
  });

  return { ...result, tenant_id: tenant.id };
}

async function saveCompanyOAuthOnboardingSession(payload: GhlOAuthTokenPayload): Promise<GhlOAuthCompanyInstallStatus> {
  const companyAccessToken = getAccessToken(payload);
  const companyId = resolveTokenCompanyId(payload);
  const approvedLocationIds = getApprovedLocationIds(payload);
  const userType = getUserType(payload);
  const configuredAppId = getString(env.GHL_MARKETPLACE_APP_ID);
  const responseAppId = getAppId(payload);

  logger.info(
    {
      tokenResponseKeys: getTokenPayloadKeys(payload),
      userType,
      companyId,
      locationIdPresent: Boolean(resolveTokenLocationId(payload)),
      approvedLocationCount: approvedLocationIds.length,
      isBulkInstallation: getIsBulkInstallation(payload),
      appIdPresent: Boolean(responseAppId),
      versionIdPresent: Boolean(getVersionId(payload))
    },
    "Detected HighLevel Company OAuth token response"
  );

  if (!companyAccessToken) {
    throw new GhlOAuthError({
      publicErrorCode: "token_response_parse_failed",
      message: "HighLevel Company OAuth response did not include accessToken"
    });
  }

  if (!companyId) {
    throw new GhlOAuthError({
      publicErrorCode: "oauth_missing_company_id",
      message: "HighLevel Company OAuth response did not include companyId"
    });
  }

  if (!configuredAppId) {
    throw new GhlOAuthError({
      publicErrorCode: "oauth_missing_marketplace_app_id",
      message: "GHL_MARKETPLACE_APP_ID is required for Company OAuth onboarding correlation"
    });
  }

  if (responseAppId && responseAppId !== configuredAppId) {
    throw new GhlOAuthError({
      publicErrorCode: "oauth_app_id_mismatch",
      message: "HighLevel Company OAuth response appId did not match GHL_MARKETPLACE_APP_ID"
    });
  }

  const session = await upsertGhlOAuthOnboardingSession({
    appId: configuredAppId,
    companyId,
    accessToken: companyAccessToken,
    expiresAt: getCompanyOnboardingSessionExpiresAt(payload)
  });
  const reconciliation = await reconcileGhlOAuthOnboarding({
    appId: configuredAppId,
    companyId
  });

  logger.info(
    {
      appId: configuredAppId,
      companyId,
      onboardingSessionId: session.id,
      onboardingSessionExpiresAt: session.expires_at,
      approvedLocationCount: approvedLocationIds.length,
      completedLocationIds: reconciliation.locations.map((location) => location.location_id),
      failedLocationIds: reconciliation.failed_location_ids,
      status: reconciliation.status
    },
    "Stored short-lived Company OAuth session and reconciled exact AppInstall locations"
  );

  return {
    mode: "company_to_location",
    company_id: companyId,
    status: reconciliation.status,
    locations: reconciliation.locations
  };
}

export async function exchangeGhlAuthorizationCode(
  code: string
): Promise<GhlOAuthInstallStatus> {
  logger.info(
    {
      codePresent: Boolean(code),
      codeLength: code.length,
      tokenUrl: env.GHL_OAUTH_TOKEN_URL,
      redirectUri: env.GHL_OAUTH_REDIRECT_URI,
      clientIdPresent: Boolean(env.GHL_OAUTH_CLIENT_ID),
      clientSecretPresent: Boolean(env.GHL_OAUTH_CLIENT_SECRET),
      tokenRequestBodyKeys: ["grant_type", "code", "client_id", "client_secret", "redirect_uri"]
    },
    "Preparing HighLevel OAuth authorization code exchange"
  );

  const payload = await requestOAuthToken({
    grant_type: "authorization_code",
    code,
    client_id: requireEnvValue("GHL_OAUTH_CLIENT_ID", env.GHL_OAUTH_CLIENT_ID),
    client_secret: requireEnvValue("GHL_OAUTH_CLIENT_SECRET", env.GHL_OAUTH_CLIENT_SECRET),
    redirect_uri: requireEnvValue("GHL_OAUTH_REDIRECT_URI", env.GHL_OAUTH_REDIRECT_URI)
  });

  if (isCompanyTokenPayload(payload)) {
    return saveCompanyOAuthOnboardingSession(payload);
  }

  const token = await saveTokenPayload(payload);
  const configuredAppId = getString(env.GHL_MARKETPLACE_APP_ID);

  if (configuredAppId && token.company_id) {
    const pendingInstall = await getGhlPendingAppInstall(configuredAppId, token.company_id, token.location_id);

    if (pendingInstall && pendingInstall.status !== "completed") {
      await completeGhlPendingAppInstall({ id: pendingInstall.id });
    }
  }

  return {
    ...(await getGhlOAuthTokenStatus(token.location_id)),
    mode: "direct_location",
    status: "direct_location"
  };
}

export async function refreshGhlOAuthToken(locationId = env.GHL_LOCATION_ID): Promise<GhlOAuthTokenRecord> {
  const token = await getGhlOAuthToken(locationId);

  if (!token) {
    throw new GhlOAuthError({
      publicErrorCode: "token_exchange_failed",
      message: `No HighLevel OAuth token is stored for location ${locationId}`
    });
  }

  const payload = await requestOAuthToken({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: requireEnvValue("GHL_OAUTH_CLIENT_ID", env.GHL_OAUTH_CLIENT_ID),
    client_secret: requireEnvValue("GHL_OAUTH_CLIENT_SECRET", env.GHL_OAUTH_CLIENT_SECRET)
  });

  return saveTokenPayload(payload, token.location_id, token.refresh_token, {
    companyId: token.company_id,
    scopes: token.scopes,
    tokenType: token.token_type
  });
}

export async function getGhlAuthContext(
  locationId = env.GHL_LOCATION_ID,
  options: { allowPrivateFallback?: boolean } = {}
): Promise<GhlAuthContext> {
  let token = await getGhlOAuthToken(locationId);

  if (token && isExpiredOrClose(token)) {
    token = await refreshGhlOAuthToken(locationId);
  }

  if (token) {
    return {
      mode: "oauth",
      accessToken: token.access_token,
      locationId: token.location_id
    };
  }

  if ((options.allowPrivateFallback ?? true) && env.GHL_ALLOW_PRIVATE_TOKEN_FALLBACK && env.GHL_PRIVATE_INTEGRATION_TOKEN) {
    logger.warn(
      { locationId },
      "Using optional GHL private integration token fallback because no OAuth token is stored"
    );
    return {
      mode: "private_integration",
      accessToken: env.GHL_PRIVATE_INTEGRATION_TOKEN,
      locationId
    };
  }

  throw new GhlOAuthError({
    publicErrorCode: "token_exchange_failed",
    message: `No HighLevel OAuth token is stored for location ${locationId}. Install the marketplace app and complete /oauth/callback first.`
  });
}

export async function forceRefreshGhlAuthContext(locationId = env.GHL_LOCATION_ID): Promise<GhlAuthContext> {
  const token = await refreshGhlOAuthToken(locationId);

  return {
    mode: "oauth",
    accessToken: token.access_token,
    locationId: token.location_id
  };
}

export async function getConfiguredGhlOAuthStatus() {
  return getGhlOAuthTokenStatus(requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID));
}

export function getOAuthCallbackConfig() {
  return {
    token_url: env.GHL_OAUTH_TOKEN_URL,
    redirect_uri: env.GHL_OAUTH_REDIRECT_URI,
    client_id_present: Boolean(env.GHL_OAUTH_CLIENT_ID),
    client_secret_present: Boolean(env.GHL_OAUTH_CLIENT_SECRET),
    marketplace_app_id_present: Boolean(env.GHL_MARKETPLACE_APP_ID),
    location_id_present: Boolean(env.GHL_LOCATION_ID),
    supabase_present: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

export async function getConfiguredGhlOAuthTokenClaims(): Promise<{
  authClass: string | null;
  authClassId: string | null;
  primaryAuthClassId: string | null;
  source: string | null;
  channel: string | null;
  oauthMeta: {
    scopes: string[];
  };
  location_id: string | null;
  company_id: string | null;
  expires_at: string | null;
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const token = await getGhlOAuthToken(locationId);

  if (!token?.access_token) {
    return {
      authClass: null,
      authClassId: null,
      primaryAuthClassId: null,
      source: null,
      channel: null,
      oauthMeta: {
        scopes: []
      },
      location_id: locationId,
      company_id: null,
      expires_at: null
    };
  }

  const { payload } = decodeJwtHeaderAndPayload(token.access_token);
  const oauthMeta = getNestedRecord(payload, "oauthMeta");
  const scopes = parseClaimScopes(oauthMeta?.scopes) ?? parseClaimScopes(payload.scopes) ?? token.scopes ?? [];

  return {
    authClass: getString(payload.authClass) ?? getString(oauthMeta?.authClass) ?? null,
    authClassId: getString(payload.authClassId) ?? getString(oauthMeta?.authClassId) ?? null,
    primaryAuthClassId: getString(payload.primaryAuthClassId) ?? getString(oauthMeta?.primaryAuthClassId) ?? null,
    source: getString(payload.source) ?? getString(oauthMeta?.source) ?? null,
    channel: getString(payload.channel) ?? getString(oauthMeta?.channel) ?? null,
    oauthMeta: {
      scopes
    },
    location_id:
      getString(payload.location_id) ??
      getString(payload.locationId) ??
      getString(oauthMeta?.location_id) ??
      getString(oauthMeta?.locationId) ??
      token.location_id,
    company_id:
      getString(payload.company_id) ??
      getString(payload.companyId) ??
      getString(oauthMeta?.company_id) ??
      getString(oauthMeta?.companyId) ??
      token.company_id,
    expires_at: token.expires_at
  };
}
