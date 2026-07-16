const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.GHL_LOCATION_ID = "legacy_global_location";
process.env.GHL_CUSTOM_PROVIDER_ID = "provider_default";
process.env.GHL_OAUTH_CLIENT_ID = "oauth-client";
process.env.GHL_OAUTH_CLIENT_SECRET = "oauth-client-secret";
process.env.GHL_OAUTH_REDIRECT_URI = "https://example.com/oauth/callback";
process.env.GHL_MARKETPLACE_APP_ID = "marketplace-app";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "global-line-token";
process.env.LINE_CHANNEL_SECRET = "global-line-secret";

const config = require("../dist/config/env");
const repository = require("../dist/services/repository");
const oauthService = require("../dist/services/ghlOAuthService");
const lineOutbound = require("../dist/services/lineOutboundChannelService");
const signatureVerifier = require("../dist/middleware/ghlWebhookSignature");
const {
  createApp,
  redactRequestHeaders,
  redactResponseHeaders,
  redactSensitiveQueryObject,
  redactSensitiveUrlQuery
} = require("../dist/app");

const repositoryMockKeys = [
  "ensureTenantForLocation",
  "getGhlOAuthToken",
  "getGhlOAuthTokenStatus",
  "upsertGhlOAuthToken",
  "upsertGhlOAuthOnboardingSession",
  "getActiveGhlOAuthOnboardingSession",
  "markGhlOAuthOnboardingSessionReconciled",
  "upsertPendingGhlAppInstall",
  "getGhlPendingAppInstall",
  "listReconcileableGhlAppInstalls",
  "claimGhlPendingAppInstall",
  "completeGhlPendingAppInstall",
  "failGhlPendingAppInstall",
  "getLineChannelById",
  "getLineChannelByTenantId"
];
const originalRepositoryExports = Object.fromEntries(
  repositoryMockKeys.map((key) => [key, repository[key]])
);
const originalFetch = global.fetch;
const originalEnv = { ...config.env };
const originalRecordGhlAppInstall = oauthService.recordGhlAppInstall;
const originalVerifyGhlWebhookSignature = signatureVerifier.verifyGhlWebhookSignature;

afterEach(() => {
  for (const [key, value] of Object.entries(originalRepositoryExports)) {
    repository[key] = value;
  }

  Object.assign(config.env, originalEnv);
  oauthService.recordGhlAppInstall = originalRecordGhlAppInstall;
  signatureVerifier.verifyGhlWebhookSignature = originalVerifyGhlWebhookSignature;
  global.fetch = originalFetch;
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tenantIdFor(locationId) {
  return `tenant_${locationId}`;
}

function buildTenant(locationId) {
  return {
    id: tenantIdFor(locationId),
    location_id: locationId,
    ghl_provider_id: `provider_${locationId}`,
    line_channel_id: "default",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  };
}

function buildTokenRow(locationId, accessToken, refreshToken, overrides = {}) {
  return {
    id: `token_${locationId}`,
    tenant_id: tenantIdFor(locationId),
    location_id: locationId,
    company_id: "company_1",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: "2999-01-01T00:00:00.000Z",
    scopes: ["oauth.readonly", "oauth.write"],
    token_type: "Bearer",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

function setupOAuthStore(input = {}) {
  const tokens = new Map(input.initialTokens ?? []);
  const tenants = new Map(input.initialTenants ?? []);
  const sessions = new Map();
  const pending = new Map();
  let sessionCounter = 0;
  let pendingCounter = 0;

  const sessionKey = (appId, companyId) => `${appId}:${companyId}`;
  const pendingKey = (appId, companyId, locationId) => `${appId}:${companyId}:${locationId}`;

  repository.ensureTenantForLocation = async (locationId) => {
    const existing = tenants.get(locationId);
    if (existing) return existing;
    const tenant = buildTenant(locationId);
    tenants.set(locationId, tenant);
    return tenant;
  };

  repository.getGhlOAuthToken = async (locationId) => tokens.get(locationId) ?? null;
  repository.getGhlOAuthTokenStatus = async (locationId) => {
    const token = tokens.get(locationId);
    return token
      ? {
          location_id: token.location_id,
          token_present: true,
          refresh_token_present: Boolean(token.refresh_token),
          expires_at: token.expires_at,
          expired: false,
          scopes: token.scopes,
          company_id: token.company_id
        }
      : {
          location_id: locationId,
          token_present: false,
          refresh_token_present: false,
          expires_at: null,
          expired: true,
          scopes: [],
          company_id: null
        };
  };

  repository.upsertGhlOAuthToken = async (tokenInput) => {
    const existing = tokens.get(tokenInput.locationId);
    const token = buildTokenRow(tokenInput.locationId, tokenInput.accessToken, tokenInput.refreshToken, {
      id: existing?.id ?? `token_${tokenInput.locationId}`,
      tenant_id: tokenInput.tenantId,
      company_id: tokenInput.companyId ?? null,
      expires_at: tokenInput.expiresAt,
      scopes: tokenInput.scopes ?? [],
      token_type: tokenInput.tokenType ?? null,
      created_at: existing?.created_at ?? "2026-07-11T00:00:00.000Z"
    });
    tokens.set(tokenInput.locationId, token);
    return token;
  };

  repository.upsertGhlOAuthOnboardingSession = async (sessionInput) => {
    const key = sessionKey(sessionInput.appId, sessionInput.companyId);
    const existing = sessions.get(key);
    const session = {
      id: existing?.id ?? `session_${++sessionCounter}`,
      app_id: sessionInput.appId,
      company_id: sessionInput.companyId,
      access_token: sessionInput.accessToken,
      status: "active",
      expires_at: sessionInput.expiresAt,
      last_reconciled_at: null,
      error_code: null,
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    sessions.set(key, session);
    return session;
  };

  repository.getActiveGhlOAuthOnboardingSession = async (appId, companyId) => {
    const session = sessions.get(sessionKey(appId, companyId));
    if (!session || session.status !== "active" || !session.access_token) return null;
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      session.status = "expired";
      session.access_token = null;
      return null;
    }
    return session;
  };

  repository.markGhlOAuthOnboardingSessionReconciled = async (sessionId) => {
    const session = [...sessions.values()].find((item) => item.id === sessionId);
    if (session) session.last_reconciled_at = new Date().toISOString();
  };

  repository.upsertPendingGhlAppInstall = async (installInput) => {
    const key = pendingKey(installInput.appId, installInput.companyId, installInput.locationId);
    const existing = pending.get(key);
    if (existing?.delivery_key === installInput.deliveryKey) return existing;
    const record = {
      id: existing?.id ?? `pending_${++pendingCounter}`,
      app_id: installInput.appId,
      company_id: installInput.companyId,
      location_id: installInput.locationId,
      tenant_id: installInput.tenantId,
      delivery_key: installInput.deliveryKey,
      status: "pending",
      processing_started_at: null,
      completed_at: null,
      completed_session_id: null,
      error_code: null,
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    pending.set(key, record);
    return record;
  };

  repository.getGhlPendingAppInstall = async (appId, companyId, locationId) =>
    pending.get(pendingKey(appId, companyId, locationId)) ?? null;
  repository.listReconcileableGhlAppInstalls = async (appId, companyId) =>
    [...pending.values()].filter(
      (item) => item.app_id === appId && item.company_id === companyId && ["pending", "failed"].includes(item.status)
    );
  repository.claimGhlPendingAppInstall = async (id) => {
    const record = [...pending.values()].find((item) => item.id === id);
    if (!record || !["pending", "failed"].includes(record.status)) return null;
    record.status = "processing";
    record.processing_started_at = new Date().toISOString();
    return record;
  };
  repository.completeGhlPendingAppInstall = async ({ id, sessionId }) => {
    const record = [...pending.values()].find((item) => item.id === id);
    assert.ok(record);
    record.status = "completed";
    record.processing_started_at = null;
    record.completed_at = new Date().toISOString();
    record.completed_session_id = sessionId ?? null;
    record.error_code = null;
  };
  repository.failGhlPendingAppInstall = async (id, errorCode) => {
    const record = [...pending.values()].find((item) => item.id === id);
    assert.ok(record);
    record.status = "failed";
    record.processing_started_at = null;
    record.error_code = errorCode;
  };

  return { tokens, tenants, sessions, pending, sessionKey, pendingKey };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function createFetchSequence(steps) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const step = steps.shift();
    const call = {
      url: new URL(typeof url === "string" ? url : url.toString()),
      method: init.method ?? "GET",
      init,
      body: init.body?.toString() ?? ""
    };
    calls.push(call);
    assert.ok(step, `Unexpected fetch call: ${call.method} ${call.url}`);
    step.assert?.(call);
    return jsonResponse(step.payload, step.status ?? 200);
  };
  return calls;
}

function authCodeStep(payload) {
  return {
    payload,
    assert: (call) => {
      assert.equal(call.method, "POST");
      assert.match(call.body, /grant_type=authorization_code/);
      assert.match(call.body, /code=/);
    }
  };
}

function locationTokenStep(locationId, payload) {
  return {
    payload,
    assert: (call) => {
      assert.equal(call.method, "POST");
      assert.equal(call.url.pathname, "/oauth/location-token");
      assert.equal(call.body, `companyId=company_1&locationId=${encodeURIComponent(locationId)}`);
      assert.equal(call.init.headers.Version, "v3");
    }
  };
}

function companyPayload(overrides = {}) {
  return {
    accessToken: "company_access",
    refreshToken: "company_refresh",
    expiresIn: 3600,
    companyId: "company_1",
    userType: "Company",
    appId: "marketplace-app",
    ...overrides
  };
}

function locationPayload(locationId, suffix = locationId) {
  return {
    accessToken: `access_${suffix}`,
    refreshToken: `refresh_${suffix}`,
    expiresIn: 3600,
    locationId,
    companyId: "company_1",
    scope: "oauth.readonly oauth.write",
    tokenType: "Bearer"
  };
}

function requestApp(input) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const rawBody = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: input.path,
          method: input.method ?? "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(rawBody),
            ...(input.headers ?? {})
          }
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const responseText = Buffer.concat(chunks).toString("utf8");
            server.close((closeError) => {
              if (closeError) {
                reject(closeError);
                return;
              }

              resolve({
                status: response.statusCode,
                body: responseText ? JSON.parse(responseText) : null
              });
            });
          });
        }
      );
      request.on("error", (error) => server.close(() => reject(error)));
      request.end(rawBody);
    });
    server.on("error", reject);
  });
}

test("AppInstall entrypoint accepts a signed INSTALL payload and reaches reconciliation", async () => {
  let reconciliationInput;
  signatureVerifier.verifyGhlWebhookSignature = ({ rawBody, ghlSignature }) => {
    assert.equal(ghlSignature, "signature-sensitive-value");
    assert.match(rawBody.toString("utf8"), /loc_entry_valid/);
    return true;
  };
  oauthService.recordGhlAppInstall = async (input) => {
    reconciliationInput = input;
    return {
      status: "completed_locations",
      locations: [{
        location_id: input.locationId,
        tenant_id: "tenant_entry_valid",
        token_present: true,
        refresh_token_present: true,
        expires_at: "2999-01-01T00:00:00.000Z"
      }],
      failed_location_ids: [],
      tenant_id: "tenant_entry_valid"
    };
  };

  const response = await requestApp({
    path: "/webhooks/ghl/app-install",
    headers: { "x-ghl-signature": "signature-sensitive-value" },
    body: {
      type: "INSTALL",
      appId: "marketplace-app",
      companyId: "company_1",
      locationId: "loc_entry_valid",
      webhookId: "entry-valid",
      accessToken: "token-sensitive-value"
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "completed_locations");
  assert.equal(reconciliationInput.locationId, "loc_entry_valid");
  assert.equal(reconciliationInput.deliveryKey, "webhook:entry-valid");
  assert.doesNotMatch(JSON.stringify(response.body), /token-sensitive-value|signature-sensitive-value/);
});

test("AppInstall entrypoint rejects a missing signature before reconciliation", async () => {
  oauthService.recordGhlAppInstall = async () => {
    throw new Error("reconciliation must not run");
  };

  const response = await requestApp({
    path: "/webhooks/ghl/app-install",
    body: {
      type: "INSTALL",
      appId: "marketplace-app",
      companyId: "company_1",
      locationId: "loc_unsigned"
    }
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "Invalid HighLevel webhook signature");
});

test("AppInstall entrypoint rejects an invalid signature before reconciliation", async () => {
  oauthService.recordGhlAppInstall = async () => {
    throw new Error("reconciliation must not run");
  };

  const response = await requestApp({
    path: "/webhooks/ghl/app-install",
    headers: { "x-ghl-signature": "invalid-signature" },
    body: {
      type: "INSTALL",
      appId: "marketplace-app",
      companyId: "company_1",
      locationId: "loc_invalid_signature"
    }
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "Invalid HighLevel webhook signature");
});

test("AppInstall entrypoint ignores a signed payload for another appId", async () => {
  signatureVerifier.verifyGhlWebhookSignature = () => true;
  oauthService.recordGhlAppInstall = async () => {
    throw new Error("reconciliation must not run");
  };

  const response = await requestApp({
    path: "/webhooks/ghl/app-install",
    headers: { "x-ghl-signature": "valid-test-signature" },
    body: {
      type: "INSTALL",
      appId: "other-app",
      companyId: "company_1",
      locationId: "loc_wrong_app"
    }
  });

  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { ok: true, ignored: true, reason: "app_id_mismatch" });
});

test("AppInstall entrypoint rejects a signed INSTALL payload without locationId", async () => {
  signatureVerifier.verifyGhlWebhookSignature = () => true;
  oauthService.recordGhlAppInstall = async () => {
    throw new Error("reconciliation must not run");
  };

  const response = await requestApp({
    path: "/webhooks/ghl/app-install",
    headers: { "x-ghl-signature": "valid-test-signature" },
    body: {
      type: "INSTALL",
      appId: "marketplace-app",
      companyId: "company_1"
    }
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Invalid HighLevel AppInstall payload");
});

test("AppInstall entrypoint keeps duplicate delivery idempotent end to end", async () => {
  const store = setupOAuthStore();
  store.sessions.set(store.sessionKey("marketplace-app", "company_1"), {
    id: "session_entry_duplicate",
    app_id: "marketplace-app",
    company_id: "company_1",
    access_token: "company_access",
    status: "active",
    expires_at: "2999-01-01T00:00:00.000Z",
    last_reconciled_at: null,
    error_code: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  });
  signatureVerifier.verifyGhlWebhookSignature = () => true;
  const calls = createFetchSequence([
    locationTokenStep("loc_entry_duplicate", locationPayload("loc_entry_duplicate"))
  ]);
  const request = {
    path: "/webhooks/ghl/app-install",
    headers: { "x-ghl-signature": "valid-test-signature" },
    body: {
      type: "INSTALL",
      appId: "marketplace-app",
      companyId: "company_1",
      locationId: "loc_entry_duplicate",
      webhookId: "entry-duplicate"
    }
  };

  const first = await requestApp(request);
  const second = await requestApp(request);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(store.tokens.get("loc_entry_duplicate").tenant_id, "tenant_loc_entry_duplicate");
});

test("request logging redacts OAuth codes, tokens, and webhook signatures", () => {
  const redactedUrl = redactSensitiveUrlQuery(
    "/oauth/callback?code=authorization-sensitive&accessToken=token-sensitive&state=state-sensitive&client_secret=client-secret-sensitive&id_token=id-token-sensitive&token=generic-token-sensitive&visible=retained"
  );
  const redactedHeaders = redactRequestHeaders({
    authorization: "Bearer authorization-sensitive",
    "x-line-signature": "line-signature-sensitive",
    "x-ghl-signature": "signature-sensitive",
    "x-wh-signature": "legacy-signature-sensitive",
    "x-wincrm-webhook-secret": "workflow-secret-sensitive",
    "x-webhook-secret": "legacy-webhook-secret-sensitive",
    "x-provider-secret": "provider-secret-sensitive",
    "x-ghl-secret": "ghl-secret-sensitive",
    "x-custom-customer-header": "customer-header-sensitive"
  });
  const serialized = JSON.stringify({ redactedUrl, redactedHeaders });

  assert.doesNotMatch(
    serialized,
    /authorization-sensitive|token-sensitive|state-sensitive|client-secret-sensitive|id-token-sensitive|signature-sensitive|workflow-secret-sensitive|legacy-webhook-secret-sensitive|provider-secret-sensitive|ghl-secret-sensitive|customer-header-sensitive/
  );
  assert.match(serialized, /%5Bredacted%5D/);
  assert.match(redactedUrl, /visible=retained/);
  assert.equal(redactedHeaders.authorizationPresent, true);
  assert.equal(redactedHeaders.webhookSecretPresent, true);
  assert.equal(redactedHeaders.providerSecretPresent, true);
  assert.equal(redactedHeaders.signaturePresent, true);
  assert.equal(redactedHeaders.headerCount, 9);
});

test("request logging redacts customer identifiers from URL and query metadata", () => {
  const redactedUrl = redactSensitiveUrlQuery(
    "/webhooks/ghl/workflows/send-line?locationId=location-complete-sensitive&CoNtAcTiD=contact-complete-sensitive&%77orkflow%49d=workflow-complete-sensitive&mode=proof"
  );
  const redactedQuery = redactSensitiveQueryObject({
    locationId: "location-complete-sensitive",
    CoNvErSaTiOnId: "conversation-complete-sensitive",
    "%74enant%49d": "tenant-complete-sensitive",
    mode: "proof"
  });

  assert.equal(
    redactedUrl,
    "/webhooks/ghl/workflows/send-line?locationId=%5Bredacted%5D&CoNtAcTiD=%5Bredacted%5D&workflowId=%5Bredacted%5D&mode=proof"
  );
  assert.deepEqual(redactedQuery, {
    locationId: "[redacted]",
    CoNvErSaTiOnId: "[redacted]",
    "%74enant%49d": "[redacted]",
    mode: "proof"
  });
  assert.doesNotMatch(
    JSON.stringify({ redactedUrl, redactedQuery }),
    /location-complete-sensitive|contact-complete-sensitive|workflow-complete-sensitive|conversation-complete-sensitive|tenant-complete-sensitive/
  );
});

test("response logging emits only safe header metadata", () => {
  const redactedHeaders = redactResponseHeaders({
    "set-cookie": "session=response-cookie-sensitive; HttpOnly",
    authorization: "Bearer response-authorization-sensitive",
    "proxy-authorization": "Basic proxy-authorization-sensitive",
    "x-access-token": "response-access-token-sensitive",
    "x-refresh-token": "response-refresh-token-sensitive",
    "x-wincrm-webhook-secret": "response-workflow-secret-sensitive",
    "x-webhook-secret": "response-legacy-webhook-secret-sensitive",
    "x-provider-secret": "response-provider-secret-sensitive",
    "x-ghl-secret": "response-ghl-secret-sensitive",
    "x-line-signature": "response-line-signature-sensitive",
    "x-ghl-signature": "response-ghl-signature-sensitive",
    "x-wh-signature": "response-wh-signature-sensitive",
    location: "/oauth/callback?state=location-state-sensitive&client_secret=location-client-secret-sensitive&visible=retained",
    "content-type": "application/json; customer=response-content-type-sensitive",
    "x-customer-data": "response-customer-header-sensitive"
  });
  const serialized = JSON.stringify(redactedHeaders);

  assert.doesNotMatch(
    serialized,
    /response-cookie-sensitive|response-authorization-sensitive|proxy-authorization-sensitive|response-access-token-sensitive|response-refresh-token-sensitive|response-workflow-secret-sensitive|response-legacy-webhook-secret-sensitive|response-provider-secret-sensitive|response-ghl-secret-sensitive|response-line-signature-sensitive|response-wh-signature-sensitive|location-state-sensitive|location-client-secret-sensitive|response-content-type-sensitive|response-customer-header-sensitive/
  );
  assert.equal(redactedHeaders.headerCount, 15);
  assert.equal(redactedHeaders.locationPresent, true);
  assert.equal(redactedHeaders.setCookiePresent, true);
  assert.equal(redactedHeaders.authorizationPresent, true);
  assert.equal(redactedHeaders.accessTokenPresent, true);
  assert.equal(redactedHeaders.refreshTokenPresent, true);
  assert.equal(redactedHeaders.webhookSecretPresent, true);
  assert.equal(redactedHeaders.providerSecretPresent, true);
  assert.equal(redactedHeaders.signaturePresent, true);
});

test("direct Location OAuth creates the exact unknown tenant and token without GHL_LOCATION_ID", async () => {
  const store = setupOAuthStore();
  createFetchSequence([authCodeStep(locationPayload("loc_direct"))]);

  const result = await oauthService.exchangeGhlAuthorizationCode("direct-code");

  assert.equal(result.mode, "direct_location");
  assert.equal(result.status, "direct_location");
  assert.equal(result.location_id, "loc_direct");
  assert.equal(store.tenants.get("loc_direct").id, "tenant_loc_direct");
  assert.equal(store.tokens.get("loc_direct").tenant_id, "tenant_loc_direct");
  assert.equal(store.tokens.has("legacy_global_location"), false);
});

test("direct Location OAuth continues parsing snake_case token responses", async () => {
  const store = setupOAuthStore();
  createFetchSequence([authCodeStep({
    access_token: "access_snake",
    refresh_token: "refresh_snake",
    expires_in: 3600,
    location_id: "loc_snake",
    company_id: "company_snake",
    scope: "oauth.readonly oauth.write",
    token_type: "Bearer"
  })]);

  const result = await oauthService.exchangeGhlAuthorizationCode("direct-snake-code");

  assert.equal(result.mode, "direct_location");
  assert.equal(result.location_id, "loc_snake");
  assert.equal(store.tokens.get("loc_snake").tenant_id, "tenant_loc_snake");
  assert.equal(store.tokens.get("loc_snake").company_id, "company_snake");
  assert.deepEqual(store.tokens.get("loc_snake").scopes, ["oauth.readonly", "oauth.write"]);
});

test("Company callback before AppInstall waits, then converts only the newly installed location", async () => {
  const oldA = buildTokenRow("loc_old_A", "access_old_A", "refresh_old_A");
  const oldB = buildTokenRow("loc_old_B", "access_old_B", "refresh_old_B");
  const originalA = clone(oldA);
  const originalB = clone(oldB);
  const store = setupOAuthStore({ initialTokens: [["loc_old_A", oldA], ["loc_old_B", oldB]] });
  const calls = createFetchSequence([
    authCodeStep(companyPayload({ approvedLocations: ["loc_old_A", "loc_old_B"] })),
    locationTokenStep("6xxYwgQMsf0kTFkUfinO", locationPayload("6xxYwgQMsf0kTFkUfinO", "new"))
  ]);

  const callback = await oauthService.exchangeGhlAuthorizationCode("company-code");
  assert.equal(callback.status, "pending_app_install");
  assert.deepEqual(callback.locations, []);

  const install = await oauthService.recordGhlAppInstall({
    appId: "marketplace-app",
    companyId: "company_1",
    locationId: "6xxYwgQMsf0kTFkUfinO",
    deliveryKey: "webhook:new-location"
  });

  assert.equal(install.status, "completed_locations");
  assert.equal(store.tokens.get("6xxYwgQMsf0kTFkUfinO").tenant_id, "tenant_6xxYwgQMsf0kTFkUfinO");
  assert.deepEqual(store.tokens.get("loc_old_A"), originalA);
  assert.deepEqual(store.tokens.get("loc_old_B"), originalB);
  assert.equal(calls.some((call) => call.url.pathname === "/oauth/installed-locations"), false);
});

test("AppInstall before Company callback is durably completed by the callback", async () => {
  const store = setupOAuthStore();
  const pending = await oauthService.recordGhlAppInstall({
    appId: "marketplace-app", companyId: "company_1", locationId: "loc_before", deliveryKey: "webhook:before"
  });
  assert.equal(pending.status, "pending_app_install");

  createFetchSequence([
    authCodeStep(companyPayload()),
    locationTokenStep("loc_before", locationPayload("loc_before"))
  ]);
  const callback = await oauthService.exchangeGhlAuthorizationCode("company-code-after-event");

  assert.equal(callback.status, "completed_locations");
  assert.equal(store.tokens.get("loc_before").tenant_id, "tenant_loc_before");
  assert.equal(store.pending.get(store.pendingKey("marketplace-app", "company_1", "loc_before")).status, "completed");
});

test("duplicate INSTALL delivery is idempotent and does not request a second location token", async () => {
  const store = setupOAuthStore();
  createFetchSequence([
    authCodeStep(companyPayload()),
    locationTokenStep("loc_duplicate", locationPayload("loc_duplicate"))
  ]);
  await oauthService.exchangeGhlAuthorizationCode("company-code");
  const first = await oauthService.recordGhlAppInstall({
    appId: "marketplace-app", companyId: "company_1", locationId: "loc_duplicate", deliveryKey: "webhook:same"
  });
  const tokenAfterFirst = clone(store.tokens.get("loc_duplicate"));
  const second = await oauthService.recordGhlAppInstall({
    appId: "marketplace-app", companyId: "company_1", locationId: "loc_duplicate", deliveryKey: "webhook:same"
  });

  assert.equal(first.status, "completed_locations");
  assert.equal(second.status, "completed_locations");
  assert.deepEqual(store.tokens.get("loc_duplicate"), tokenAfterFirst);
});

test("existing-location reinstall with a new delivery updates only that location token", async () => {
  const oldTarget = buildTokenRow("loc_reinstall", "access_old", "refresh_old");
  const unrelated = buildTokenRow("loc_unrelated", "access_unrelated", "refresh_unrelated");
  const originalUnrelated = clone(unrelated);
  const store = setupOAuthStore({ initialTokens: [["loc_reinstall", oldTarget], ["loc_unrelated", unrelated]] });
  store.pending.set(store.pendingKey("marketplace-app", "company_1", "loc_reinstall"), {
    id: "pending_existing", app_id: "marketplace-app", company_id: "company_1", location_id: "loc_reinstall",
    tenant_id: "tenant_loc_reinstall", delivery_key: "webhook:old", status: "completed",
    processing_started_at: null, completed_at: "2026-07-10T00:00:00.000Z", completed_session_id: "session_old",
    error_code: null, created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z"
  });
  createFetchSequence([
    authCodeStep(companyPayload()),
    locationTokenStep("loc_reinstall", locationPayload("loc_reinstall", "reinstalled"))
  ]);
  await oauthService.exchangeGhlAuthorizationCode("reinstall-code");
  await oauthService.recordGhlAppInstall({
    appId: "marketplace-app", companyId: "company_1", locationId: "loc_reinstall", deliveryKey: "webhook:new"
  });

  assert.equal(store.tokens.get("loc_reinstall").access_token, "access_reinstalled");
  assert.deepEqual(store.tokens.get("loc_unrelated"), originalUnrelated);
});

test("two close AppInstall locations under one company receive isolated location tokens", async () => {
  const store = setupOAuthStore();
  await Promise.all([
    oauthService.recordGhlAppInstall({
      appId: "marketplace-app", companyId: "company_1", locationId: "loc_close_A", deliveryKey: "webhook:close-a"
    }),
    oauthService.recordGhlAppInstall({
      appId: "marketplace-app", companyId: "company_1", locationId: "loc_close_B", deliveryKey: "webhook:close-b"
    })
  ]);
  createFetchSequence([
    authCodeStep(companyPayload()),
    locationTokenStep("loc_close_A", locationPayload("loc_close_A", "close_A")),
    locationTokenStep("loc_close_B", locationPayload("loc_close_B", "close_B"))
  ]);

  const result = await oauthService.exchangeGhlAuthorizationCode("bulk-code");

  assert.equal(result.status, "completed_locations");
  assert.equal(store.tokens.get("loc_close_A").access_token, "access_close_A");
  assert.equal(store.tokens.get("loc_close_B").access_token, "access_close_B");
  assert.notEqual(store.tokens.get("loc_close_A").tenant_id, store.tokens.get("loc_close_B").tenant_id);
});

test("AppInstall appId mismatch fails before tenant or pending creation", async () => {
  const store = setupOAuthStore();
  await assert.rejects(
    () => oauthService.recordGhlAppInstall({
      appId: "other-app", companyId: "company_1", locationId: "loc_wrong_app", deliveryKey: "webhook:wrong-app"
    }),
    /did not match GHL_MARKETPLACE_APP_ID/
  );
  assert.equal(store.tenants.has("loc_wrong_app"), false);
  assert.equal(store.pending.size, 0);
});

test("location-token response mismatch fails closed without modifying unrelated tokens", async () => {
  const unrelated = buildTokenRow("loc_unrelated", "access_unrelated", "refresh_unrelated");
  const original = clone(unrelated);
  const store = setupOAuthStore({ initialTokens: [["loc_unrelated", unrelated]] });
  await oauthService.recordGhlAppInstall({
    appId: "marketplace-app", companyId: "company_1", locationId: "loc_expected", deliveryKey: "webhook:mismatch"
  });
  createFetchSequence([
    authCodeStep(companyPayload()),
    locationTokenStep("loc_expected", locationPayload("loc_other", "wrong"))
  ]);

  const result = await oauthService.exchangeGhlAuthorizationCode("mismatch-code");

  assert.equal(result.status, "failed");
  assert.deepEqual(result.locations, []);
  assert.equal(store.tokens.has("loc_expected"), false);
  assert.equal(store.tokens.has("loc_other"), false);
  assert.deepEqual(store.tokens.get("loc_unrelated"), original);
});

test("location-token response without access token fails closed", async () => {
  const store = setupOAuthStore();
  await oauthService.recordGhlAppInstall({
    appId: "marketplace-app",
    companyId: "company_1",
    locationId: "loc_missing_access",
    deliveryKey: "webhook:missing-access"
  });
  createFetchSequence([
    authCodeStep(companyPayload()),
    locationTokenStep("loc_missing_access", {
      refreshToken: "refresh_missing_access",
      expiresIn: 3600,
      locationId: "loc_missing_access",
      companyId: "company_1",
      scope: "oauth.readonly",
      tokenType: "Bearer"
    })
  ]);

  const result = await oauthService.exchangeGhlAuthorizationCode("missing-access-code");

  assert.equal(result.status, "failed");
  assert.equal(store.tokens.has("loc_missing_access"), false);
});

test("Company OAuth response without companyId fails safely", async () => {
  const store = setupOAuthStore();
  createFetchSequence([authCodeStep(companyPayload({ companyId: undefined }))]);

  await assert.rejects(
    () => oauthService.exchangeGhlAuthorizationCode("missing-company-code"),
    /did not include companyId/
  );
  assert.equal(store.sessions.size, 0);
  assert.equal(store.tokens.size, 0);
});

test("Company OAuth correlation fails safely without GHL_MARKETPLACE_APP_ID", async () => {
  const store = setupOAuthStore();
  config.env.GHL_MARKETPLACE_APP_ID = "";
  createFetchSequence([authCodeStep(companyPayload())]);

  await assert.rejects(
    () => oauthService.exchangeGhlAuthorizationCode("missing-marketplace-app-code"),
    /GHL_MARKETPLACE_APP_ID is required/
  );
  assert.equal(store.sessions.size, 0);
  assert.equal(store.tokens.size, 0);
});

test("missing Company onboarding session leaves exact install pending and stores no token", async () => {
  const store = setupOAuthStore();
  const result = await oauthService.recordGhlAppInstall({
    appId: "marketplace-app", companyId: "company_1", locationId: "loc_no_session", deliveryKey: "webhook:no-session"
  });
  assert.equal(result.status, "pending_app_install");
  assert.equal(store.tokens.has("loc_no_session"), false);
});

test("expired Company onboarding session is invalidated and cannot create a location token", async () => {
  const store = setupOAuthStore();
  store.sessions.set(store.sessionKey("marketplace-app", "company_1"), {
    id: "session_expired", app_id: "marketplace-app", company_id: "company_1", access_token: "expired_access",
    status: "active", expires_at: "2000-01-01T00:00:00.000Z", last_reconciled_at: null, error_code: null,
    created_at: "2000-01-01T00:00:00.000Z", updated_at: "2000-01-01T00:00:00.000Z"
  });

  const result = await oauthService.recordGhlAppInstall({
    appId: "marketplace-app", companyId: "company_1", locationId: "loc_expired", deliveryKey: "webhook:expired"
  });

  assert.equal(result.status, "pending_app_install");
  assert.equal(store.sessions.get(store.sessionKey("marketplace-app", "company_1")).access_token, null);
  assert.equal(store.tokens.has("loc_expired"), false);
});

test("OAuth refresh remains scoped to the stored location and preserves omitted metadata", async () => {
  const locA = buildTokenRow("loc_A", "access_A", "refresh_A", { company_id: "company_A" });
  const locB = buildTokenRow("loc_B", "access_B", "refresh_B", { company_id: "company_B" });
  const originalA = clone(locA);
  const store = setupOAuthStore({ initialTokens: [["loc_A", locA], ["loc_B", locB]] });
  createFetchSequence([{
    payload: { access_token: "access_B_refreshed", refresh_token: "refresh_B_refreshed", expires_in: 3600 },
    assert: (call) => {
      assert.match(call.body, /grant_type=refresh_token/);
      assert.match(call.body, /refresh_token=refresh_B/);
    }
  }]);

  await oauthService.refreshGhlOAuthToken("loc_B");

  assert.deepEqual(store.tokens.get("loc_A"), originalA);
  assert.equal(store.tokens.get("loc_B").tenant_id, "tenant_loc_B");
  assert.equal(store.tokens.get("loc_B").company_id, "company_B");
  assert.deepEqual(store.tokens.get("loc_B").scopes, ["oauth.readonly", "oauth.write"]);
  assert.equal(store.tokens.get("loc_B").token_type, "Bearer");
  assert.equal(store.tokens.get("loc_B").access_token, "access_B_refreshed");
  assert.equal(store.tokens.get("loc_B").refresh_token, "refresh_B_refreshed");
});

test("OAuth refresh stores supplied metadata for the same location only", async () => {
  const locA = buildTokenRow("loc_A", "access_A", "refresh_A", {
    company_id: "company_A",
    scopes: ["oauth.readonly"],
    token_type: "Bearer"
  });
  const locB = buildTokenRow("loc_B", "access_B", "refresh_B", {
    company_id: "company_B",
    scopes: ["oauth.readonly", "oauth.write"],
    token_type: "Bearer"
  });
  const originalA = clone(locA);
  const store = setupOAuthStore({ initialTokens: [["loc_A", locA], ["loc_B", locB]] });
  createFetchSequence([{
    payload: {
      accessToken: "access_B_refreshed_with_metadata",
      refreshToken: "refresh_B_refreshed_with_metadata",
      expiresIn: 3600,
      companyId: "company_B_updated",
      scopes: ["oauth.readonly"],
      tokenType: "BearerV2"
    },
    assert: (call) => {
      assert.match(call.body, /grant_type=refresh_token/);
      assert.match(call.body, /refresh_token=refresh_B/);
    }
  }]);

  await oauthService.refreshGhlOAuthToken("loc_B");

  assert.deepEqual(store.tokens.get("loc_A"), originalA);
  assert.equal(store.tokens.get("loc_B").tenant_id, "tenant_loc_B");
  assert.equal(store.tokens.get("loc_B").company_id, "company_B_updated");
  assert.deepEqual(store.tokens.get("loc_B").scopes, ["oauth.readonly"]);
  assert.equal(store.tokens.get("loc_B").token_type, "BearerV2");
  assert.equal(store.tokens.get("loc_B").access_token, "access_B_refreshed_with_metadata");
  assert.equal(store.tokens.get("loc_B").refresh_token, "refresh_B_refreshed_with_metadata");
});

test("missing OAuth token fails safely without selecting another tenant token", async () => {
  const locA = buildTokenRow("loc_A", "access_A", "refresh_A");
  const originalA = clone(locA);
  const store = setupOAuthStore({ initialTokens: [["loc_A", locA]] });

  await assert.rejects(
    () => oauthService.getGhlAuthContext("loc_missing", { allowPrivateFallback: false }),
    /No HighLevel OAuth token is stored for location loc_missing/
  );

  assert.deepEqual(store.tokens.get("loc_A"), originalA);
  assert.equal(store.tokens.has("loc_missing"), false);
});

test("LINE outbound channel selection remains tenant-isolated and fails closed", async () => {
  const channels = new Map([
    ["line_A", { id: "line_A", tenant_id: "tenant_A", webhook_key: "webhook_A", channel_access_token: "line_token_A", channel_secret: "line_secret_A", is_active: true }],
    ["line_B", { id: "line_B", tenant_id: "tenant_B", webhook_key: "webhook_B", channel_access_token: "line_token_B", channel_secret: "line_secret_B", is_active: true }]
  ]);
  repository.getLineChannelById = async (id) => channels.get(id) ?? null;
  repository.getLineChannelByTenantId = async (tenantId) =>
    [...channels.values()].find((channel) => channel.tenant_id === tenantId) ?? null;

  const profileChannelSelection = await lineOutbound.resolveLineChannelForOutbound("tenant_B", {
    line_channel_id: "line_B"
  });
  assert.equal(profileChannelSelection.channelAccessToken, "line_token_B");
  assert.equal(profileChannelSelection.channelTokenSource, "profile_channel");

  const tenantChannelSelection = await lineOutbound.resolveLineChannelForOutbound("tenant_B", {
    line_channel_id: null
  });
  assert.equal(tenantChannelSelection.channelAccessToken, "line_token_B");
  assert.equal(tenantChannelSelection.channelTokenSource, "tenant_active_channel");

  await assert.rejects(
    () => lineOutbound.resolveLineChannelForOutbound("tenant_missing", { line_channel_id: null }),
    (error) => {
      assert.equal(error.name, "LineChannelNotConnectedError");
      assert.equal(error.channelTokenSource, "tenant_active_channel");
      assert.equal(error.lineChannelId, undefined);
      return true;
    }
  );
});
