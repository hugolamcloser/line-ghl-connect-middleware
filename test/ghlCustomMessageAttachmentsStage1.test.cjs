const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.WEBHOOK_SHARED_SECRET = "stage1-shared-secret-sensitive";
process.env.GHL_LOCATION_ID = "production-location-sensitive";
process.env.GHL_CUSTOM_PROVIDER_ID = "production-provider-sensitive";
process.env.GHL_API_VERSION = "2021-07-28";
process.env.STAGE1_GHL_LOCATION_ID = "stage1-location-sensitive";
process.env.STAGE1_GHL_CONTACT_ID = "stage1-contact-sensitive";
process.env.STAGE1_GHL_PROVIDER_ID = "stage1-provider-sensitive";
delete process.env.STAGE1_GHL_API_VERSION;

const config = require("../dist/config/env");
const loggerModule = require("../dist/config/logger");
const oauthService = require("../dist/services/ghlOAuthService");
const signatureVerifier = require("../dist/middleware/ghlWebhookSignature");
const lineClient = require("../dist/integrations/lineClient");
const productionCallbackService = require("../dist/services/ghlSyncService");
const productionWorkflowService = require("../dist/services/ghlWorkflowActionService");
const stage1Service = require("../dist/services/ghlCustomMessageAttachmentProbeService");
const { createApp } = require("../dist/app");

const stage1Path = "/debug/ghl/custom-message-attachments-stage-1";
const bootstrapPath = `${stage1Path}/bootstrap`;
const providerCheckPath = `${stage1Path}/provider-check`;
const callbackPath = "/webhooks/ghl/stage-1/custom-message-outbound";
const probeRunIds = {
  A: "11111111-1111-4111-8111-111111111111",
  B: "22222222-2222-4222-8222-222222222222",
  C: "33333333-3333-4333-8333-333333333333",
  D: "44444444-4444-4444-8444-444444444444",
  E: "55555555-5555-4555-8555-555555555555",
  F: "66666666-6666-4666-8666-666666666666"
};
const assetUrls = {
  image: "https://assets.example.test/private/image.png?signature=signed-image-sensitive",
  pdf: "https://assets.example.test/private/report.pdf?token=signed-pdf-sensitive",
  mp4: "https://video.example.test/private/movie.mp4?signature=signed-video-sensitive"
};
const originalEnv = { ...config.env };
const originalFetch = global.fetch;
const patchedFunctions = [
  [oauthService, "getGhlAuthContext"],
  [oauthService, "forceRefreshGhlAuthContext"],
  [signatureVerifier, "verifyGhlWebhookSignature"],
  [productionCallbackService, "processGhlOutboundWebhook"],
  [productionWorkflowService, "processGhlWorkflowSendLine"],
  [lineClient, "pushLineTextMessage"],
  [lineClient, "pushLineImageMessage"],
  [lineClient, "pushLineMessages"],
  [loggerModule.logger, "info"]
];
const originals = patchedFunctions.map(([module, key]) => [module, key, module[key]]);

afterEach(() => {
  Object.assign(config.env, originalEnv);
  global.fetch = originalFetch;

  for (const [module, key, value] of originals) {
    module[key] = value;
  }

  stage1Service.resetStage1ProbeStateForTests();
});

function requestApp({ path, method = "POST", body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const rawBody = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method,
          headers: {
            ...(rawBody ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(rawBody)
            } : {}),
            ...headers
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

function stage1Headers(secret = config.env.WEBHOOK_SHARED_SECRET) {
  return { "x-wincrm-webhook-secret": secret };
}

function setupOAuth() {
  const authCalls = [];
  const refreshCalls = [];

  oauthService.getGhlAuthContext = async (locationId, options) => {
    authCalls.push({ locationId, options });
    return { mode: "oauth", accessToken: "stage1-oauth-token-sensitive", locationId };
  };
  oauthService.forceRefreshGhlAuthContext = async (locationId) => {
    refreshCalls.push(locationId);
    return { mode: "oauth", accessToken: "stage1-refreshed-token-sensitive", locationId };
  };

  return { authCalls, refreshCalls };
}

function setupCreateResponses(count = 1) {
  const requests = [];
  let sequence = 0;

  global.fetch = async (url, init) => {
    sequence += 1;
    requests.push({ url, init, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      messageId: `stage1-message-${sequence}`,
      conversationId: `stage1-conversation-${sequence}`,
      ignoredSensitiveBody: "must-not-be-returned"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  return { requests, expectedCount: count };
}

function setupUpstreamResponse(body, status = 400) {
  const requests = [];

  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(body, {
      status,
      headers: typeof body === "string" ? { "Content-Type": "application/json" } : undefined
    });
  };

  return { requests };
}

async function runProbe(body, secret = config.env.WEBHOOK_SHARED_SECRET) {
  return requestApp({ path: stage1Path, body, headers: stage1Headers(secret) });
}

async function runBootstrap(body = {}, secret = config.env.WEBHOOK_SHARED_SECRET) {
  return requestApp({ path: bootstrapPath, body, headers: stage1Headers(secret) });
}

async function runProviderCheck(secret = config.env.WEBHOOK_SHARED_SECRET) {
  return requestApp({
    path: providerCheckPath,
    method: "GET",
    headers: stage1Headers(secret)
  });
}

test("Stage 1 driver rejects missing and invalid x-wincrm-webhook-secret", async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    throw new Error("fetch must not run");
  };

  const missing = await requestApp({
    path: stage1Path,
    body: { probeRunId: probeRunIds.A, case: "A" }
  });
  const invalid = await runProbe({ probeRunId: probeRunIds.A, case: "A" }, "invalid-secret");
  const missingBootstrap = await requestApp({ path: bootstrapPath, body: {} });
  const invalidBootstrap = await runBootstrap({}, "invalid-secret");
  const missingProviderCheck = await requestApp({ path: providerCheckPath, method: "GET" });
  const invalidProviderCheck = await runProviderCheck("invalid-secret");

  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal(missingBootstrap.status, 401);
  assert.equal(invalidBootstrap.status, 401);
  assert.equal(missingProviderCheck.status, 401);
  assert.equal(invalidProviderCheck.status, 401);
  assert.equal(fetchCount, 0);
});

test("Stage 1 shared-secret middleware preserves missing-configuration 503", async () => {
  config.env.WEBHOOK_SHARED_SECRET = "";
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    throw new Error("fetch must not run");
  };

  const response = await requestApp({
    path: stage1Path,
    body: { probeRunId: probeRunIds.A, case: "A" },
    headers: { "x-wincrm-webhook-secret": "unused-sensitive-secret" }
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "WEBHOOK_SHARED_SECRET is not configured");
  assert.equal(fetchCount, 0);
});

test("Stage 1 API version defaults to v3 independently of production GHL_API_VERSION", async () => {
  setupOAuth();
  const { requests } = setupCreateResponses();

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const presence = config.getEnvPresenceReport();

  assert.equal(response.status, 200);
  assert.equal(config.env.GHL_API_VERSION, "2021-07-28");
  assert.equal(config.env.STAGE1_GHL_API_VERSION, "v3");
  assert.equal(requests[0].init.headers.Version, "v3");
  assert.ok(Object.prototype.hasOwnProperty.call(presence.optional, "STAGE1_GHL_API_VERSION"));
});

test("Stage 1 provider check uses exact-location OAuth, Version v3, and returns a sanitized match", async () => {
  config.env.STAGE1_GHL_API_VERSION = "2021-07-28";
  const { authCalls } = setupOAuth();
  const requests = [];
  const logCalls = [];
  let productionCallbackCalls = 0;
  let productionWorkflowCalls = 0;
  let lineCalls = 0;

  loggerModule.logger.info = (...args) => logCalls.push(args);
  productionCallbackService.processGhlOutboundWebhook = async () => {
    productionCallbackCalls += 1;
  };
  productionWorkflowService.processGhlWorkflowSendLine = async () => {
    productionWorkflowCalls += 1;
  };
  for (const key of ["pushLineTextMessage", "pushLineImageMessage", "pushLineMessages"]) {
    lineClient[key] = async () => {
      lineCalls += 1;
    };
  }
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({
      conversationChannel: {
        SMS: [
          {
            conversationProvider: {
              _id: config.env.STAGE1_GHL_PROVIDER_ID,
              name: "Stage 1 SMS",
              type: "SMS",
              default: false
            }
          },
          {
            conversationProvider: {
              _id: "other-provider-sensitive",
              name: "Other SMS",
              type: "SMS",
              default: true
            }
          }
        ]
      },
      ignoredLocationId: config.env.STAGE1_GHL_LOCATION_ID,
      ignoredContactId: config.env.STAGE1_GHL_CONTACT_ID
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const response = await runProviderCheck();

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    highLevelHttpStatus: 200,
    configuredProviderMatched: true,
    configuredProviderExpectedType: "SMS",
    recognizedSmsProviderCount: 2,
    recognizedProviders: [
      {
        name: "Stage 1 SMS",
        type: "SMS",
        default: false,
        matchesConfiguredStage1Provider: true
      },
      {
        name: "Other SMS",
        type: "SMS",
        default: true,
        matchesConfiguredStage1Provider: false
      }
    ]
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `https://services.leadconnectorhq.com/locations/${encodeURIComponent(config.env.STAGE1_GHL_LOCATION_ID)}/conversationChannels/SMS`
  );
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[0].init.headers.Version, "v3");
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].locationId, config.env.STAGE1_GHL_LOCATION_ID);
  assert.deepEqual(authCalls[0].options, { allowPrivateFallback: false });
  assert.equal(productionCallbackCalls, 0);
  assert.equal(productionWorkflowCalls, 0);
  assert.equal(lineCalls, 0);

  const exposed = JSON.stringify({ response: response.body, logs: logCalls });
  assert.doesNotMatch(
    exposed,
    /stage1-location-sensitive|stage1-contact-sensitive|stage1-provider-sensitive|other-provider-sensitive|stage1-shared-secret-sensitive|stage1-oauth-token-sensitive/
  );
  assert.match(exposed, /Stage 1 SMS|Other SMS|recognizedSmsProviderCount|configuredProviderMatched/);
});

test("Stage 1 provider check reports a sanitized non-match", async () => {
  setupOAuth();
  global.fetch = async () => new Response(JSON.stringify({
    conversationChannel: {
      SMS: [
        {
          conversationProvider: {
            _id: "different-provider-sensitive",
            name: "Different SMS",
            type: "SMS",
            default: false
          }
        }
      ]
    }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  const response = await runProviderCheck();

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.configuredProviderMatched, false);
  assert.equal(response.body.recognizedSmsProviderCount, 1);
  assert.deepEqual(response.body.recognizedProviders, [
    {
      name: "Different SMS",
      type: "SMS",
      default: false,
      matchesConfiguredStage1Provider: false
    }
  ]);
  assert.doesNotMatch(JSON.stringify(response.body), /different-provider-sensitive|stage1-provider-sensitive/);
});

test("Stage 1 provider check refreshes exact-location OAuth once after a 401", async () => {
  const { authCalls, refreshCalls } = setupOAuth();
  const requests = [];

  global.fetch = async (url, init) => {
    requests.push({ url, init });

    if (requests.length === 1) {
      return new Response(JSON.stringify({ message: "expired token-sensitive response" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      conversationChannel: {
        SMS: [
          {
            conversationProvider: {
              _id: config.env.STAGE1_GHL_PROVIDER_ID,
              name: "Stage 1 SMS",
              type: "SMS",
              default: false
            }
          }
        ]
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const response = await runProviderCheck();

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.configuredProviderMatched, true);
  assert.equal(requests.length, 2);
  assert.equal(authCalls.length, 1);
  assert.deepEqual(refreshCalls, [config.env.STAGE1_GHL_LOCATION_ID]);
  assert.match(requests[0].init.headers.Authorization, /stage1-oauth-token-sensitive/);
  assert.match(requests[1].init.headers.Authorization, /stage1-refreshed-token-sensitive/);
});

test("Stage 1 provider check sanitizes 400, final 401, and 500 responses", async () => {
  for (const status of [400, 401, 500]) {
    const { refreshCalls } = setupOAuth();
    const logCalls = [];
    let requestCount = 0;
    loggerModule.logger.info = (...args) => logCalls.push(args);
    global.fetch = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        status: "Rejected",
        error: "Provider lookup failed",
        message: `Location ${config.env.STAGE1_GHL_LOCATION_ID} provider ${config.env.STAGE1_GHL_PROVIDER_ID} ${assetUrls.image}`,
        code: `LOOKUP_${status}`,
        validationErrors: [
          {
            field: "conversationProviderId",
            message: `Invalid ${config.env.STAGE1_GHL_PROVIDER_ID}`,
            code: "invalid_provider"
          }
        ],
        authorization: "Bearer upstream-token-sensitive",
        unknown: "must-not-be-returned"
      }), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    };

    const response = await runProviderCheck();
    const exposed = JSON.stringify({ response: response.body, logs: logCalls });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.highLevelHttpStatus, status);
    assert.equal(response.body.configuredProviderMatched, false);
    assert.equal(response.body.recognizedSmsProviderCount, 0);
    assert.deepEqual(response.body.recognizedProviders, []);
    assert.equal(response.body.upstreamError.statusCode, status);
    assert.equal(response.body.upstreamError.code, `LOOKUP_${status}`);
    assert.equal(response.body.upstreamError.responseParsed, true);
    assert.equal(response.body.upstreamError.responseTruncated, false);
    assert.deepEqual(response.body.upstreamError.rejectedFields, [
      {
        field: "conversationProviderId",
        message: "Invalid [redacted]",
        code: "invalid_provider"
      }
    ]);
    assert.equal(requestCount, status === 401 ? 2 : 1);
    assert.equal(refreshCalls.length, status === 401 ? 1 : 0);
    assert.doesNotMatch(
      exposed,
      /stage1-location-sensitive|stage1-contact-sensitive|stage1-provider-sensitive|signed-image-sensitive|upstream-token-sensitive|stage1-shared-secret-sensitive|stage1-oauth-token-sensitive|https:\/\//
    );
    assert.doesNotMatch(JSON.stringify(logCalls), /Provider lookup failed|Location |Invalid \[redacted\]|Rejected/);
    assert.match(JSON.stringify(logCalls), new RegExp(`LOOKUP_${status}|upstream_error|validation_error`));
  }
});

test("Stage 1 bootstrap creates the exact isolated inbound SMS payload without production or LINE calls", async () => {
  const { authCalls } = setupOAuth();
  const requests = [];
  const logCalls = [];
  let productionCallbackCalls = 0;
  let productionWorkflowCalls = 0;
  let lineCalls = 0;

  loggerModule.logger.info = (...args) => logCalls.push(args);
  productionCallbackService.processGhlOutboundWebhook = async () => {
    productionCallbackCalls += 1;
  };
  productionWorkflowService.processGhlWorkflowSendLine = async () => {
    productionWorkflowCalls += 1;
  };
  for (const key of ["pushLineTextMessage", "pushLineImageMessage", "pushLineMessages"]) {
    lineClient[key] = async () => {
      lineCalls += 1;
    };
  }
  global.fetch = async (url, init) => {
    requests.push({ url, init, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      messageId: "bootstrap-message-sensitive",
      conversationId: "bootstrap-conversation-sensitive"
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  };

  const response = await runBootstrap();

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    highLevelHttpStatus: 201,
    messageIdPresent: true,
    conversationIdPresent: true
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://services.leadconnectorhq.com/conversations/messages/inbound"
  );
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Version, "v3");
  assert.deepEqual(requests[0].payload, {
    locationId: config.env.STAGE1_GHL_LOCATION_ID,
    contactId: config.env.STAGE1_GHL_CONTACT_ID,
    conversationProviderId: config.env.STAGE1_GHL_PROVIDER_ID,
    externalConversationId: "stage1-provider-contact-bootstrap",
    externalMessageId: "stage1-provider-contact-bootstrap",
    type: "SMS",
    message: "Stage 1 provider-contact bootstrap"
  });
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].locationId, config.env.STAGE1_GHL_LOCATION_ID);
  assert.deepEqual(authCalls[0].options, { allowPrivateFallback: false });
  assert.equal(productionCallbackCalls, 0);
  assert.equal(productionWorkflowCalls, 0);
  assert.equal(lineCalls, 0);
  const exposed = JSON.stringify({ response: response.body, logs: logCalls });
  assert.doesNotMatch(
    exposed,
    /stage1-location-sensitive|stage1-contact-sensitive|stage1-provider-sensitive|stage1-shared-secret-sensitive|stage1-oauth-token-sensitive|bootstrap-message-sensitive|bootstrap-conversation-sensitive|Stage 1 provider-contact bootstrap/
  );
  assert.match(exposed, /messageIdPresent|conversationIdPresent|lineDeliveryAttempted/);
});

test("Stage 1 bootstrap rejects attempts to override server-controlled values", async () => {
  let oauthCalls = 0;
  let fetchCalls = 0;
  oauthService.getGhlAuthContext = async () => {
    oauthCalls += 1;
    throw new Error("OAuth must not run");
  };
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("HighLevel request must not run");
  };

  const response = await runBootstrap({
    locationId: "override-location-sensitive",
    contactId: "override-contact-sensitive",
    providerId: "override-provider-sensitive",
    conversationProviderId: "override-conversation-provider-sensitive",
    oauthToken: "override-token-sensitive",
    message: "override-message-sensitive"
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "validation_error");
  assert.equal(oauthCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("Stage 1 bootstrap refreshes exact-location OAuth once after a 401", async () => {
  const { authCalls, refreshCalls } = setupOAuth();
  const requests = [];

  global.fetch = async (url, init) => {
    requests.push({ url, init, payload: JSON.parse(init.body) });

    if (requests.length === 1) {
      return new Response(JSON.stringify({
        message: "expired token response-sensitive-body",
        token: "response-token-sensitive"
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ messageId: "bootstrap-message-refreshed" }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  };

  const response = await runBootstrap();

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].payload, requests[1].payload);
  assert.equal(authCalls.length, 1);
  assert.deepEqual(refreshCalls, [config.env.STAGE1_GHL_LOCATION_ID]);
  assert.match(requests[0].init.headers.Authorization, /stage1-oauth-token-sensitive/);
  assert.match(requests[1].init.headers.Authorization, /stage1-refreshed-token-sensitive/);
  assert.doesNotMatch(JSON.stringify(response.body), /response-sensitive-body|response-token-sensitive/);
});

test("Stage 1 bootstrap returns sanitized 400 diagnostics and logs no IDs or secrets", async () => {
  setupOAuth();
  const logCalls = [];
  loggerModule.logger.info = (...args) => logCalls.push(args);
  setupUpstreamResponse(JSON.stringify({
    status: "Bad Request",
    error: "Validation failed",
    message: `Provider ${config.env.STAGE1_GHL_PROVIDER_ID} rejected ${config.env.STAGE1_GHL_CONTACT_ID} at ${assetUrls.image}`,
    code: "PROVIDER_CONTACT_UNSUPPORTED",
    validationErrors: [
      {
        field: "conversationProviderId",
        message: `Invalid ${config.env.STAGE1_GHL_PROVIDER_ID}`,
        code: "unsupported"
      }
    ],
    locationId: config.env.STAGE1_GHL_LOCATION_ID,
    authorization: "Bearer upstream-token-sensitive"
  }));

  const response = await runBootstrap();
  const diagnostic = response.body.upstreamError;

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.highLevelHttpStatus, 400);
  assert.equal(response.body.messageIdPresent, false);
  assert.equal(response.body.conversationIdPresent, false);
  assert.equal(diagnostic.statusCode, 400);
  assert.equal(diagnostic.code, "PROVIDER_CONTACT_UNSUPPORTED");
  assert.deepEqual(diagnostic.rejectedFields, [
    {
      field: "conversationProviderId",
      message: "Invalid [redacted]",
      code: "unsupported"
    }
  ]);
  assert.match(diagnostic.message, /\[redacted\]/);
  const exposed = JSON.stringify({ response: response.body, logs: logCalls });
  assert.doesNotMatch(
    exposed,
    /stage1-location-sensitive|stage1-contact-sensitive|stage1-provider-sensitive|signed-image-sensitive|upstream-token-sensitive|stage1-shared-secret-sensitive|stage1-oauth-token-sensitive|https:\/\//
  );
  assert.doesNotMatch(JSON.stringify(logCalls), /Provider |Invalid \[redacted\]|Bad Request|Validation failed/);
  assert.match(JSON.stringify(logCalls), /PROVIDER_CONTACT_UNSUPPORTED|conversationProviderId|validation_error/);
});

test("Stage 1 routes fail closed when dedicated configuration is incomplete", async () => {
  config.env.STAGE1_GHL_PROVIDER_ID = "";
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    throw new Error("fetch must not run");
  };

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const bootstrapResponse = await runBootstrap();
  const providerCheckResponse = await runProviderCheck();

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "Stage 1 HighLevel probe configuration is incomplete");
  assert.equal(bootstrapResponse.status, 503);
  assert.equal(bootstrapResponse.body.error, "Stage 1 HighLevel probe configuration is incomplete");
  assert.equal(providerCheckResponse.status, 503);
  assert.equal(providerCheckResponse.body.error, "Stage 1 HighLevel probe configuration is incomplete");
  assert.equal(fetchCount, 0);
});

test("Stage 1 refuses the configured production location or provider", async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    throw new Error("fetch must not run");
  };
  config.env.STAGE1_GHL_PROVIDER_ID = config.env.GHL_CUSTOM_PROVIDER_ID;

  const providerResponse = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  assert.equal(providerResponse.status, 503);
  assert.match(providerResponse.body.error, /provider must be isolated/);

  config.env.STAGE1_GHL_PROVIDER_ID = originalEnv.STAGE1_GHL_PROVIDER_ID;
  config.env.STAGE1_GHL_LOCATION_ID = config.env.GHL_LOCATION_ID;
  const locationResponse = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  assert.equal(locationResponse.status, 503);
  assert.match(locationResponse.body.error, /location must be isolated/);
  assert.equal(fetchCount, 0);
});

test("invalid probeRunId is rejected before OAuth or HighLevel access", async () => {
  let oauthCount = 0;
  oauthService.getGhlAuthContext = async () => {
    oauthCount += 1;
    throw new Error("OAuth must not run");
  };

  const response = await runProbe({ probeRunId: "not-a-uuid", case: "A" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "probeRunId must be a UUID");
  assert.equal(oauthCount, 0);
});

test("arbitrary location, contact, and provider identifiers are rejected", async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    throw new Error("fetch must not run");
  };

  const response = await runProbe({
    probeRunId: probeRunIds.A,
    case: "A",
    locationId: "arbitrary-location-sensitive",
    contactId: "arbitrary-contact-sensitive",
    providerId: "arbitrary-provider-sensitive"
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "validation_error");
  assert.equal(fetchCount, 0);
});

for (const fixture of [
  { case: "A", expected: { message: `Stage 1 A ${probeRunIds.A}` } },
  { case: "B", assetUrl: assetUrls.image, expected: { attachments: [assetUrls.image] } },
  {
    case: "C",
    assetUrl: assetUrls.image,
    expected: { message: `Stage 1 C ${probeRunIds.C}`, attachments: [assetUrls.image] }
  },
  { case: "D", assetUrl: assetUrls.pdf, expected: { attachments: [assetUrls.pdf] } },
  { case: "E", assetUrl: assetUrls.mp4, expected: { attachments: [assetUrls.mp4] } }
]) {
  test(`Stage 1 case ${fixture.case} creates the exact Custom payload`, async () => {
    const { authCalls } = setupOAuth();
    const { requests } = setupCreateResponses();
    const response = await runProbe({
      probeRunId: probeRunIds[fixture.case],
      case: fixture.case,
      ...(fixture.assetUrl ? { assetUrl: fixture.assetUrl } : {})
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.initialStatus, "pending");
    assert.equal(response.body.createRequestCount, 1);
    assert.deepEqual(requests[0].payload, {
      type: "Custom",
      contactId: config.env.STAGE1_GHL_CONTACT_ID,
      conversationProviderId: config.env.STAGE1_GHL_PROVIDER_ID,
      status: "pending",
      ...fixture.expected
    });
    assert.equal(requests[0].payload.type, "Custom");
    assert.notEqual(requests[0].payload.type, "InternalComment");
    assert.equal(authCalls[0].locationId, config.env.STAGE1_GHL_LOCATION_ID);
    assert.deepEqual(authCalls[0].options, { allowPrivateFallback: false });
    assert.equal(requests[0].init.headers.Version, "v3");
    assert.equal(response.body.results[0].messageId, "stage1-message-1");
    assert.equal(response.body.results[0].conversationId, "stage1-conversation-1");
    assert.equal(JSON.stringify(response.body).includes("must-not-be-returned"), false);
  });
}

test("signed attachment URL is preserved byte-for-byte and delivered control is supported", async () => {
  setupOAuth();
  const { requests } = setupCreateResponses();

  const response = await runProbe({
    probeRunId: probeRunIds.B,
    case: "B",
    initialStatus: "delivered",
    assetUrl: assetUrls.image
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.initialStatus, "delivered");
  assert.equal(response.body.statusUpdateRequired, false);
  assert.equal(requests[0].payload.attachments[0], assetUrls.image);
});

test("asset URL validation rejects unsafe values before OAuth", async () => {
  let oauthCount = 0;
  oauthService.getGhlAuthContext = async () => {
    oauthCount += 1;
    throw new Error("OAuth must not run");
  };

  for (const assetUrl of [
    "http://assets.example.test/image.png",
    "https://localhost/image.png",
    "https://127.0.0.1/image.png",
    "https://[::1]/image.png",
    "https://user:password@assets.example.test/image.png",
    "https://assets.example.test/unencoded image.png"
  ]) {
    const response = await runProbe({ probeRunId: probeRunIds.B, case: "B", assetUrl });
    assert.equal(response.status, 400);
  }

  assert.equal(oauthCount, 0);
});

test("assetUrl is required for attachment cases but not case A", async () => {
  let oauthCount = 0;
  oauthService.getGhlAuthContext = async () => {
    oauthCount += 1;
    throw new Error("OAuth must not run for missing attachment URL");
  };

  const response = await runProbe({ probeRunId: probeRunIds.B, case: "B" });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "assetUrl is required for this Stage 1 probe case");
  assert.equal(oauthCount, 0);
});

test("asset URL length is bounded before OAuth", async () => {
  let oauthCount = 0;
  oauthService.getGhlAuthContext = async () => {
    oauthCount += 1;
    throw new Error("OAuth must not run");
  };
  const oversizedUrl = `https://assets.example.test/${"a".repeat(2_000)}`;

  const response = await runProbe({
    probeRunId: probeRunIds.B,
    case: "B",
    assetUrl: oversizedUrl
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /2000 characters or fewer/);
  assert.equal(oauthCount, 0);
});

test("Stage 1 create refreshes exact-location OAuth once after a 401", async () => {
  const { authCalls, refreshCalls } = setupOAuth();
  const requests = [];

  global.fetch = async (url, init) => {
    requests.push({ url, init });

    if (requests.length === 1) {
      return new Response("unauthorized-sensitive-body", { status: 401 });
    }

    return new Response(JSON.stringify({ messageId: "stage1-message-refreshed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(authCalls.length, 1);
  assert.deepEqual(refreshCalls, [config.env.STAGE1_GHL_LOCATION_ID]);
  assert.match(requests[0].init.headers.Authorization, /stage1-oauth-token-sensitive/);
  assert.match(requests[1].init.headers.Authorization, /stage1-refreshed-token-sensitive/);
  assert.doesNotMatch(JSON.stringify(response.body), /unauthorized-sensitive-body/);
});

test("standard JSON 400 returns only allowlisted sanitized error and message fields", async () => {
  setupOAuth();
  const logCalls = [];
  loggerModule.logger.info = (...args) => logCalls.push(args);
  setupUpstreamResponse(JSON.stringify({
    statusCode: 999,
    status: "Bad Request",
    error: "Validation failed",
    message: ["conversationProviderId is required"],
    code: "VALIDATION_ERROR",
    unknownField: "unknown-upstream-value-sensitive",
    authorization: "Bearer upstream-authorization-sensitive"
  }));

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, false);
  assert.deepEqual(response.body.results[0].upstreamError, {
    statusCode: 400,
    status: "Bad Request",
    error: "Validation failed",
    message: "conversationProviderId is required",
    code: "VALIDATION_ERROR",
    rejectedFields: [],
    responseParsed: true,
    responseTruncated: false
  });
  const exposed = JSON.stringify({ response: response.body, logs: logCalls });
  assert.doesNotMatch(exposed, /unknown-upstream-value-sensitive|upstream-authorization-sensitive/);
  assert.match(exposed, /VALIDATION_ERROR/);
  assert.match(exposed, /upstream_error/);
  assert.doesNotMatch(JSON.stringify(logCalls), /conversationProviderId is required|Validation failed|Bad Request/);
});

test("validation error arrays retain only bounded field, message, and code metadata", async () => {
  setupOAuth();
  setupUpstreamResponse(JSON.stringify({
    error: "Bad Request",
    validationErrors: [
      { field: "conversationProviderId", message: "must be a valid provider", code: "invalid_provider" },
      { property: "contactId", message: "must identify a contact", errorCode: "required" }
    ]
  }));

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const diagnostic = response.body.results[0].upstreamError;

  assert.equal(response.status, 200);
  assert.deepEqual(diagnostic.rejectedFields, [
    { field: "conversationProviderId", message: "must be a valid provider", code: "invalid_provider" },
    { field: "contactId", message: "must identify a contact", code: "required" }
  ]);
  assert.equal(diagnostic.responseParsed, true);
  assert.equal(diagnostic.responseTruncated, false);
});

test("nested validation errors and constraints are reduced to rejected field metadata", async () => {
  setupOAuth();
  setupUpstreamResponse(JSON.stringify({
    response: { code: "INVALID_INPUT" },
    details: {
      errors: {
        body: {
          children: [
            {
              property: "conversationProviderId",
              constraints: {
                isNotEmpty: "conversationProviderId must not be empty"
              }
            }
          ]
        }
      }
    }
  }));

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const diagnostic = response.body.results[0].upstreamError;

  assert.equal(diagnostic.code, "INVALID_INPUT");
  assert.deepEqual(diagnostic.rejectedFields, [
    {
      field: "conversationProviderId",
      message: "conversationProviderId must not be empty",
      code: "isNotEmpty"
    }
  ]);
});

test("malformed and empty upstream error bodies expose no raw body", async () => {
  setupOAuth();
  setupUpstreamResponse("{malformed-json-sensitive");

  const malformed = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  assert.deepEqual(malformed.body.results[0].upstreamError, {
    statusCode: 400,
    rejectedFields: [],
    responseParsed: false,
    responseTruncated: false
  });
  assert.doesNotMatch(JSON.stringify(malformed.body), /malformed-json-sensitive/);

  stage1Service.resetStage1ProbeStateForTests();
  setupUpstreamResponse(null);
  const empty = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  assert.deepEqual(empty.body.results[0].upstreamError, {
    statusCode: 400,
    rejectedFields: [],
    responseParsed: false,
    responseTruncated: false
  });
});

test("oversized upstream response is capped, marked truncated, and never returned", async () => {
  setupOAuth();
  const oversizedSensitiveValue = `oversized-sensitive-prefix-${"x".repeat(40_000)}`;
  setupUpstreamResponse(JSON.stringify({ message: oversizedSensitiveValue }));

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const diagnostic = response.body.results[0].upstreamError;

  assert.equal(diagnostic.statusCode, 400);
  assert.equal(diagnostic.responseParsed, false);
  assert.equal(diagnostic.responseTruncated, true);
  assert.deepEqual(diagnostic.rejectedFields, []);
  assert.doesNotMatch(JSON.stringify(response.body), /oversized-sensitive-prefix/);
});

test("unknown upstream fields and nested arbitrary messages are discarded", async () => {
  setupOAuth();
  setupUpstreamResponse(JSON.stringify({
    status: "invalid",
    unknownField: "unknown-sensitive-value",
    arbitraryWrapper: {
      message: "nested-arbitrary-message-sensitive",
      token: "nested-token-sensitive"
    },
    anotherUnknown: ["private-array-value"]
  }));

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const exposed = JSON.stringify(response.body);

  assert.equal(response.body.results[0].upstreamError.status, "invalid");
  assert.equal(response.body.results[0].upstreamError.message, undefined);
  assert.doesNotMatch(
    exposed,
    /unknown-sensitive-value|nested-arbitrary-message-sensitive|nested-token-sensitive|private-array-value|arbitraryWrapper/
  );
});

test("identifiers, URLs, secrets, and complete upstream messages are removed from responses and logs", async () => {
  setupOAuth();
  const logCalls = [];
  loggerModule.logger.info = (...args) => logCalls.push(args);
  const upstreamMessage = [
    "Rejected",
    config.env.STAGE1_GHL_LOCATION_ID,
    config.env.STAGE1_GHL_CONTACT_ID,
    config.env.STAGE1_GHL_PROVIDER_ID,
    assetUrls.image,
    "private-customer-file.png",
    config.env.WEBHOOK_SHARED_SECRET,
    "stage1-oauth-token-sensitive"
  ].join(" ");
  setupUpstreamResponse(JSON.stringify({
    message: upstreamMessage,
    code: "INVALID_INPUT",
    errors: [
      {
        field: "contactId",
        message: upstreamMessage,
        code: "required"
      }
    ],
    headers: { authorization: "Bearer response-token-sensitive" }
  }));

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const exposed = JSON.stringify({ response: response.body, logs: logCalls });

  assert.equal(response.body.results[0].upstreamError.code, "INVALID_INPUT");
  assert.equal(response.body.results[0].upstreamError.rejectedFields[0].field, "contactId");
  assert.match(response.body.results[0].upstreamError.message, /\[redacted\]/);
  assert.doesNotMatch(
    exposed,
    /stage1-location-sensitive|stage1-contact-sensitive|stage1-provider-sensitive|signed-image-sensitive|private-customer-file\.png|stage1-shared-secret-sensitive|stage1-oauth-token-sensitive|response-token-sensitive|https:\/\//
  );
  assert.doesNotMatch(JSON.stringify(logCalls), /Rejected|\[redacted\]/);
  assert.match(JSON.stringify(logCalls), /INVALID_INPUT|validation_error|contactId/);
});

test("successful 2xx create parsing remains unchanged and has no upstreamError", async () => {
  setupOAuth();
  setupCreateResponses();

  const response = await runProbe({ probeRunId: probeRunIds.A, case: "A" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results[0], {
    highLevelHttpStatus: 200,
    messageIdPresent: true,
    messageId: "stage1-message-1",
    conversationIdPresent: true,
    conversationId: "stage1-conversation-1"
  });
});

test("case F performs exactly two identical HighLevel creates and returns both IDs", async () => {
  setupOAuth();
  const { requests } = setupCreateResponses(2);

  const response = await runProbe({
    probeRunId: probeRunIds.F,
    case: "F",
    assetUrl: assetUrls.image
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.createRequestCount, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].payload, requests[1].payload);
  assert.deepEqual(response.body.results.map((result) => result.messageId), [
    "stage1-message-1",
    "stage1-message-2"
  ]);
});

test("protected status endpoint sends only the allowed status with exact-location OAuth", async () => {
  const { authCalls } = setupOAuth();
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(null, { status: 200 });
  };

  const response = await requestApp({
    path: `${stage1Path}/messages/stage1-message-status/status`,
    method: "PUT",
    headers: stage1Headers(),
    body: { status: "delivered" }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(request.init.body), { status: "delivered" });
  assert.match(request.url, /\/conversations\/messages\/stage1-message-status\/status$/);
  assert.deepEqual(authCalls[0].options, { allowPrivateFallback: false });
});

test("invalid callback signature is rejected before JSON parsing or interception", async () => {
  let productionCalls = 0;
  let lineCalls = 0;
  signatureVerifier.verifyGhlWebhookSignature = ({ rawBody, ghlSignature }) => {
    assert.ok(Buffer.isBuffer(rawBody));
    assert.equal(ghlSignature, "invalid-signature-sensitive");
    return false;
  };
  productionCallbackService.processGhlOutboundWebhook = async () => {
    productionCalls += 1;
  };
  lineClient.pushLineMessages = async () => {
    lineCalls += 1;
  };

  const response = await requestApp({
    path: callbackPath,
    body: "not-json-sensitive-content",
    headers: { "x-ghl-signature": "invalid-signature-sensitive" }
  });

  assert.equal(response.status, 401);
  assert.equal(productionCalls, 0);
  assert.equal(lineCalls, 0);
});

test("missing callback signature is rejected", async () => {
  signatureVerifier.verifyGhlWebhookSignature = ({ rawBody, ghlSignature }) => {
    assert.ok(Buffer.isBuffer(rawBody));
    assert.equal(ghlSignature, undefined);
    return false;
  };

  const response = await requestApp({
    path: callbackPath,
    body: { type: "Custom", messageId: "stage1-message-unsigned" }
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, "Invalid HighLevel callback signature");
});

test("valid signed callback is structurally recorded and never reaches production or LINE", async () => {
  setupOAuth();
  setupCreateResponses();
  const logCalls = [];
  const sensitiveMessage = "private Stage 1 customer message sensitive";
  const sensitiveFilename = "private-customer-file.png";
  const callbackBody = JSON.stringify({
    type: "Custom",
    locationId: config.env.STAGE1_GHL_LOCATION_ID,
    contactId: config.env.STAGE1_GHL_CONTACT_ID,
    messageId: "stage1-message-1",
    conversationId: "stage1-conversation-1",
    message: sensitiveMessage,
    attachments: [{ url: assetUrls.image, name: sensitiveFilename }],
    nested: { providerToken: "provider-token-sensitive" }
  });
  let productionCalls = 0;
  let lineCalls = 0;
  let verifiedRawBody;

  loggerModule.logger.info = (...args) => logCalls.push(args);
  productionCallbackService.processGhlOutboundWebhook = async () => {
    productionCalls += 1;
    throw new Error("production callback must not run");
  };
  for (const key of ["pushLineTextMessage", "pushLineImageMessage", "pushLineMessages"]) {
    lineClient[key] = async () => {
      lineCalls += 1;
      throw new Error("LINE must not run");
    };
  }
  signatureVerifier.verifyGhlWebhookSignature = ({ rawBody, ghlSignature, legacySignature }) => {
    verifiedRawBody = rawBody;
    assert.equal(ghlSignature, "valid-signature-sensitive");
    assert.equal(legacySignature, undefined);
    return true;
  };

  await runProbe({ probeRunId: probeRunIds.B, case: "B", assetUrl: assetUrls.image });
  const callbackResponse = await requestApp({
    path: callbackPath,
    body: callbackBody,
    headers: { "x-ghl-signature": "valid-signature-sensitive" }
  });
  const observations = await requestApp({
    path: `${stage1Path}/${probeRunIds.B}/observations`,
    method: "GET",
    headers: stage1Headers()
  });

  assert.equal(verifiedRawBody.toString("utf8"), callbackBody);
  assert.equal(callbackResponse.status, 200);
  assert.deepEqual(callbackResponse.body, { ok: true, intercepted: true, callbackReceived: true });
  assert.equal(productionCalls, 0);
  assert.equal(lineCalls, 0);
  assert.equal(observations.status, 200);
  assert.equal(observations.body.providerCallbackCount, 1);
  assert.equal(observations.body.genericOutboundObservationConfigured, false);
  assert.equal(observations.body.genericOutboundCallbackCount, null);
  assert.equal(observations.body.genericOutboundObservationStatus, "not_observed");
  assert.equal(observations.body.unmatchedCallbackCount, 0);
  assert.equal(observations.body.observations[0].correlationStatus, "matched_by_message_id");
  assert.equal(observations.body.observations[0].messagePresent, true);
  assert.equal(observations.body.observations[0].messageLength, sensitiveMessage.length);
  assert.equal(observations.body.observations[0].attachmentArrayLength, 1);
  assert.deepEqual(observations.body.observations[0].attachmentElementTypes, ["object"]);
  assert.deepEqual(observations.body.observations[0].attachmentUrlHostnames, ["assets.example.test"]);
  assert.equal(observations.body.observations[0].timingRelativeToCreateResponse, "after");
  const exposed = JSON.stringify({ response: callbackResponse.body, observations: observations.body, logs: logCalls });
  assert.doesNotMatch(
    exposed,
    /private Stage 1 customer message sensitive|private-customer-file\.png|signed-image-sensitive|provider-token-sensitive|stage1-location-sensitive|stage1-contact-sensitive|stage1-provider-sensitive|stage1-shared-secret-sensitive|valid-signature-sensitive|stage1-oauth-token-sensitive/
  );
  assert.doesNotMatch(exposed, /https:\/\/assets\.example\.test\/private/);
  assert.match(exposed, /assets\.example\.test/);
  assert.match(exposed, /dispatchStatus/);
  assert.match(exposed, /lineDeliveryAttempted/);
});

test("valid callback without messageId is retained by single active run fallback", async () => {
  setupOAuth();
  setupCreateResponses();
  signatureVerifier.verifyGhlWebhookSignature = ({ rawBody }) => Buffer.isBuffer(rawBody);

  await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  const callbackResponse = await requestApp({
    path: callbackPath,
    body: {
      type: "Custom",
      message: "sensitive callback content that must not be retained",
      attachments: [assetUrls.image]
    },
    headers: { "x-ghl-signature": "valid-signature-sensitive" }
  });
  const observations = await requestApp({
    path: `${stage1Path}/${probeRunIds.A}/observations`,
    method: "GET",
    headers: stage1Headers()
  });

  assert.equal(callbackResponse.status, 200);
  assert.equal(observations.status, 200);
  assert.equal(observations.body.providerCallbackCount, 1);
  assert.equal(observations.body.unmatchedCallbackCount, 0);
  assert.equal(observations.body.observations[0].messageIdPresent, false);
  assert.equal(observations.body.observations[0].correlationStatus, "single_active_run_fallback");
  const exposed = JSON.stringify(observations.body);
  assert.doesNotMatch(exposed, /sensitive callback content|signed-image-sensitive|https:\/\//);
  assert.match(exposed, /assets\.example\.test/);
});

test("ambiguous messageId-less callbacks remain sanitized and bounded as unmatched", async () => {
  setupOAuth();
  setupCreateResponses();
  signatureVerifier.verifyGhlWebhookSignature = ({ rawBody }) => Buffer.isBuffer(rawBody);

  await runProbe({ probeRunId: probeRunIds.A, case: "A" });
  await runProbe({ probeRunId: probeRunIds.B, case: "B", assetUrl: assetUrls.image });

  for (let index = 0; index < 25; index += 1) {
    const response = await requestApp({
      path: callbackPath,
      body: {
        type: "OutboundMessage",
        message: `sensitive unmatched content ${index}`,
        attachments: [{ url: assetUrls.image, name: `private-${index}.png` }]
      },
      headers: { "x-ghl-signature": "valid-signature-sensitive" }
    });
    assert.equal(response.status, 200);
  }

  const observations = await requestApp({
    path: `${stage1Path}/${probeRunIds.A}/observations`,
    method: "GET",
    headers: stage1Headers()
  });

  assert.equal(observations.status, 200);
  assert.equal(observations.body.genericOutboundObservationConfigured, false);
  assert.equal(observations.body.genericOutboundCallbackCount, null);
  assert.equal(observations.body.unmatchedCallbackCount, 20);
  assert.equal(observations.body.unmatchedObservations.length, 20);
  assert.ok(observations.body.unmatchedObservations.every(
    (item) => item.correlationStatus === "unmatched" && item.callbackKind === "provider"
  ));
  const exposed = JSON.stringify(observations.body);
  assert.doesNotMatch(exposed, /sensitive unmatched content|private-\d+\.png|signed-image-sensitive|https:\/\//);
  assert.match(exposed, /assets\.example\.test/);
});
