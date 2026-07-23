const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST =
  "tenant-provider-sensitive,tenant-callback-sensitive";
process.env.GHL_CUSTOM_PROVIDER_SECRET = "";

const config = require("../dist/config/env");
const loggerModule = require("../dist/config/logger");
const repository = require("../dist/services/repository");
const oauthService = require("../dist/services/ghlOAuthService");
const signatureVerifier = require("../dist/middleware/ghlWebhookSignature");
const outboundClient = require("../dist/integrations/ghlWorkflowOutboundMirrorClient");
const lineClient = require("../dist/integrations/lineClient");
const channelService = require("../dist/services/lineOutboundChannelService");
const workflowService = require("../dist/services/ghlWorkflowActionService");
const syncService = require("../dist/services/ghlSyncService");
const { createApp } = require("../dist/app");

const originalFetch = global.fetch;
const originalDeliveryMode = config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE;
const patchedExports = [
  [repository, "getTenantIdsByLocationId"],
  [repository, "findLineProfileByGhlIdsForTenantIds"],
  [repository, "getTenantById"],
  [repository, "findWorkflowProviderDispatchMessageEvent"],
  [repository, "findWorkflowOutboundMirrorMessageEventForTenantIds"],
  [repository, "claimGhlOutboundProviderDelivery"],
  [repository, "finalizeGhlOutboundProviderDelivery"],
  [repository, "saveMessageEvent"],
  [oauthService, "getGhlAuthContext"],
  [oauthService, "forceRefreshGhlAuthContext"],
  [signatureVerifier, "verifyGhlWebhookSignature"],
  [outboundClient, "mirrorWorkflowOutboundMessageToGhl"],
  [outboundClient, "createWorkflowProviderMessage"],
  [outboundClient, "updateWorkflowProviderMessageStatus"],
  [lineClient, "pushLineMessages"],
  [lineClient, "pushLineTextMessage"],
  [channelService, "resolveLineChannelForOutbound"],
  [syncService, "processGhlOutboundWebhook"],
  [loggerModule.logger, "info"],
  [loggerModule.logger, "warn"],
  [loggerModule.logger, "error"]
];
const originals = patchedExports.map(([module, key]) => [module, key, module[key]]);

afterEach(() => {
  for (const [module, key, value] of originals) {
    module[key] = value;
  }

  global.fetch = originalFetch;
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = originalDeliveryMode;
});

function workflowPayload(overrides = {}) {
  return {
    locationId: "location-provider-sensitive",
    contactId: "contact-provider-sensitive",
    workflowId: "workflow-provider-sensitive",
    message: "",
    ...overrides
  };
}

function setupWorkflowHarness() {
  let eventError;
  const calls = {
    tenantIds: [],
    profiles: [],
    tenants: [],
    channels: [],
    providerCreates: [],
    textCreates: [],
    lineBatches: [],
    events: [],
    logs: [],
    setEventError(error) {
      eventError = error;
    }
  };

  repository.getTenantIdsByLocationId = async (locationId) => {
    calls.tenantIds.push(locationId);
    return ["tenant-provider-sensitive"];
  };
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds, ids) => {
    calls.profiles.push({ tenantIds, ids });
    return {
      id: "profile-provider-sensitive",
      tenant_id: "tenant-provider-sensitive",
      line_user_id: "line-user-provider-sensitive",
      line_channel_id: "line-channel-provider-sensitive",
      ghl_contact_id: "contact-provider-sensitive",
      ghl_conversation_id: "conversation-provider-sensitive"
    };
  };
  repository.getTenantById = async (tenantId) => {
    calls.tenants.push(tenantId);
    return {
      id: tenantId,
      location_id: "location-provider-sensitive",
      ghl_provider_id: "provider-tenant-sensitive"
    };
  };
  repository.saveMessageEvent = async (input) => {
    calls.events.push(input);
    if (eventError) {
      throw eventError;
    }
  };
  channelService.resolveLineChannelForOutbound = async (tenantId, mapping) => {
    calls.channels.push({ tenantId, mapping });
    return {
      channelAccessToken: "line-token-sensitive",
      lineChannelId: "line-channel-provider-sensitive",
      channelTokenSource: "profile_channel"
    };
  };
  outboundClient.createWorkflowProviderMessage = async (input) => {
    calls.providerCreates.push(input);
    return {
      ok: true,
      endpoint: "/conversations/messages",
      method: "POST",
      authMode: "oauth",
      statusCode: 201,
      requestBody: {
        type: "Custom",
        status: "pending",
        messagePresent: Boolean(input.message),
        attachmentCount: input.attachments?.length ?? 0
      },
      ghlMessageId: "ghl-created-message-sensitive",
      ghlConversationId: "conversation-provider-sensitive"
    };
  };
  outboundClient.mirrorWorkflowOutboundMessageToGhl = async (input) => {
    calls.textCreates.push(input);
    return {
      ok: true,
      endpoint: "/conversations/messages",
      method: "POST",
      authMode: "oauth",
      statusCode: 201,
      requestBody: { type: "Custom", status: "delivered" },
      ghlMessageId: "ghl-text-message-sensitive"
    };
  };
  lineClient.pushLineMessages = async (...args) => {
    calls.lineBatches.push(args);
    return { messageId: "unexpected-line-message", statusCode: 200 };
  };
  for (const level of ["info", "warn", "error"]) {
    loggerModule.logger[level] = (...args) => calls.logs.push({ level, args });
  }

  return calls;
}

function callbackPayload(overrides = {}) {
  return {
    locationId: "location-callback-sensitive",
    contactId: "contact-callback-sensitive",
    conversationId: "conversation-callback-sensitive",
    messageId: "message-callback-sensitive",
    conversationProviderId: "provider-callback-sensitive",
    attachments: ["https://assets.example.test/media/image.png?signature=signed-sensitive"],
    ...overrides
  };
}

function setupCallbackHarness() {
  const calls = {
    claims: [],
    finalizations: [],
    lineBatches: [],
    textPushes: [],
    statusUpdates: [],
    events: [],
    providerDispatchLookups: [],
    tenants: [],
    channels: [],
    logs: []
  };
  const claimedIds = new Set();
  let lineError;
  let statusUpdateOk = true;
  let channelError;
  let configuredProviderId = "provider-callback-sensitive";
  let configuredTenantLocationId = "location-callback-sensitive";
  let mappingFound = true;
  let providerDispatchEvent = null;

  repository.getTenantIdsByLocationId = async (locationId) =>
    locationId === "location-callback-sensitive" ? ["tenant-callback-sensitive"] : [];
  repository.findWorkflowOutboundMirrorMessageEventForTenantIds = async () => null;
  repository.findWorkflowProviderDispatchMessageEvent = async (input) => {
    calls.providerDispatchLookups.push(input);
    return providerDispatchEvent;
  };
  repository.getTenantById = async (tenantId) => {
    calls.tenants.push(tenantId);
    return {
      id: tenantId,
      location_id: configuredTenantLocationId,
      ghl_provider_id: configuredProviderId
    };
  };
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds, ids) => {
    assert.deepEqual(tenantIds, ["tenant-callback-sensitive"]);
    assert.equal(ids.contactId, "contact-callback-sensitive");
    if (!mappingFound) {
      return null;
    }
    return {
      id: "profile-callback-sensitive",
      tenant_id: "tenant-callback-sensitive",
      line_user_id: "line-user-callback-sensitive",
      line_channel_id: "line-channel-callback-sensitive",
      ghl_contact_id: "contact-callback-sensitive",
      ghl_conversation_id: "conversation-callback-sensitive"
    };
  };
  channelService.resolveLineChannelForOutbound = async (tenantId) => {
    calls.channels.push(tenantId);
    assert.equal(tenantId, "tenant-callback-sensitive");
    if (channelError) {
      throw channelError;
    }
    return {
      channelAccessToken: "line-token-callback-sensitive",
      lineChannelId: "line-channel-callback-sensitive",
      channelTokenSource: "profile_channel"
    };
  };
  repository.claimGhlOutboundProviderDelivery = async (input) => {
    calls.claims.push(input);
    const externalMessageId = `ghl-provider-delivery:${input.ghlMessageId}`;
    if (claimedIds.has(input.ghlMessageId)) {
      return { claimed: false, externalMessageId };
    }
    claimedIds.add(input.ghlMessageId);
    return { claimed: true, eventId: `claim-${input.ghlMessageId}`, externalMessageId };
  };
  repository.finalizeGhlOutboundProviderDelivery = async (input) => {
    calls.finalizations.push(input);
  };
  repository.saveMessageEvent = async (input) => calls.events.push(input);
  lineClient.pushLineMessages = async (...args) => {
    calls.lineBatches.push(args);
    if (lineError) {
      throw lineError;
    }
    return { messageId: "line-result-sensitive", statusCode: 200 };
  };
  lineClient.pushLineTextMessage = async (...args) => {
    calls.textPushes.push(args);
    return { messageId: "line-text-sensitive", statusCode: 200 };
  };
  outboundClient.updateWorkflowProviderMessageStatus = async (input) => {
    calls.statusUpdates.push(input);
    return {
      ok: statusUpdateOk,
      authMode: "oauth",
      statusCode: statusUpdateOk ? 200 : 500,
      ...(statusUpdateOk ? {} : { errorCategory: "upstream_rejected" })
    };
  };
  for (const level of ["info", "warn", "error"]) {
    loggerModule.logger[level] = (...args) => calls.logs.push({ level, args });
  }

  return {
    calls,
    controls: {
      setLineError(error) {
        lineError = error;
      },
      setStatusUpdateOk(value) {
        statusUpdateOk = value;
      },
      setChannelError(error) {
        channelError = error;
      },
      setConfiguredProviderId(value) {
        configuredProviderId = value;
      },
      setConfiguredTenantLocationId(value) {
        configuredTenantLocationId = value;
      },
      setMappingFound(value) {
        mappingFound = value;
      },
      setProviderDispatchEvent(value) {
        providerDispatchEvent = value;
      }
    }
  };
}

function setupOAuth() {
  const authCalls = [];
  const refreshCalls = [];
  oauthService.getGhlAuthContext = async (locationId, options) => {
    authCalls.push({ locationId, options });
    return { mode: "oauth", accessToken: "oauth-token-sensitive", locationId };
  };
  oauthService.forceRefreshGhlAuthContext = async (locationId) => {
    refreshCalls.push(locationId);
    return { mode: "oauth", accessToken: "refreshed-token-sensitive", locationId };
  };
  return { authCalls, refreshCalls };
}

function requestApp(input) {
  return new Promise((resolve, reject) => {
    const app = createApp();
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const rawBody = JSON.stringify(input.body);
      const request = http.request({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/webhooks/ghl/line/outbound",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(rawBody),
          ...(input.headers ?? {})
        }
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          server.close(() => resolve({ status: response.statusCode, body }));
        });
      });
      request.on("error", (error) => server.close(() => reject(error)));
      request.end(rawBody);
    });
    server.on("error", reject);
  });
}

test("provider message client creates the exact pending Custom attachment payload with exact-location OAuth", async () => {
  const { authCalls } = setupOAuth();
  const requests = [];
  const signedUrl = "https://assets.example.test/private/image.png?signature=preserved-sensitive";
  global.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      messageId: "created-message-sensitive",
      conversationId: "created-conversation-sensitive"
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };

  const result = await outboundClient.createWorkflowProviderMessage({
    locationId: "location-create-sensitive",
    contactId: "contact-create-sensitive",
    conversationProviderId: "provider-create-sensitive",
    message: "private workflow text",
    attachments: [signedUrl]
  });

  assert.equal(result.ok, true);
  assert.equal(requests[0].url, "https://services.leadconnectorhq.com/conversations/messages");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Version, "v3");
  assert.deepEqual(requests[0].body, {
    type: "Custom",
    contactId: "contact-create-sensitive",
    status: "pending",
    conversationProviderId: "provider-create-sensitive",
    message: "private workflow text",
    attachments: [signedUrl]
  });
  assert.deepEqual(authCalls, [{
    locationId: "location-create-sensitive",
    options: { allowPrivateFallback: false }
  }]);
  assert.doesNotMatch(JSON.stringify(result.requestBody), /private workflow text|https:\/\/|preserved-sensitive/);
});

test("provider message client creates v3 pending Custom text without phone or attachments", async () => {
  const { authCalls } = setupOAuth();
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      messageId: "created-text-message-sensitive",
      conversationId: "created-text-conversation-sensitive"
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  };

  const result = await outboundClient.createWorkflowProviderMessage({
    locationId: "location-create-text-sensitive",
    contactId: "contact-create-text-sensitive",
    conversationProviderId: "provider-create-text-sensitive",
    message: "private provider-first text"
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://services.leadconnectorhq.com/conversations/messages");
  assert.equal(requests[0].init.headers.Version, "v3");
  assert.deepEqual(requests[0].body, {
    type: "Custom",
    contactId: "contact-create-text-sensitive",
    status: "pending",
    conversationProviderId: "provider-create-text-sensitive",
    message: "private provider-first text"
  });
  assert.equal("attachments" in requests[0].body, false);
  assert.equal("phone" in requests[0].body, false);
  assert.deepEqual(authCalls, [{
    locationId: "location-create-text-sensitive",
    options: { allowPrivateFallback: false }
  }]);
  assert.doesNotMatch(JSON.stringify(result.requestBody), /private provider-first text/);
});

test("provider message client rejects empty text and attachments before OAuth or HTTP", async () => {
  const { authCalls } = setupOAuth();
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected HTTP request");
  };

  await assert.rejects(
    () => outboundClient.createWorkflowProviderMessage({
      locationId: "location-empty-sensitive",
      contactId: "contact-empty-sensitive",
      conversationProviderId: "provider-empty-sensitive",
      attachments: []
    }),
    /requires text or at least one attachment/
  );
  assert.equal(authCalls.length, 0);
  assert.equal(fetchCalls, 0);
});

test("provider_first image-only and text-plus-image create one HighLevel message and no direct LINE push", async () => {
  const calls = setupWorkflowHarness();
  const signedUrl = "https://assets.example.test/private/image.png?signature=unchanged-sensitive";

  const imageOnly = await workflowService.processGhlWorkflowSendLine(workflowPayload({
    attachments: [{ url: signedUrl, name: "image.png", size: 100 }]
  }));
  const textAndImage = await workflowService.processGhlWorkflowSendLine(workflowPayload({
    message: "text before image",
    attachments: [{ url: signedUrl, name: "image.png", size: 100 }]
  }));

  assert.equal(imageOnly.body.status, "sent");
  assert.equal(textAndImage.body.status, "sent");
  assert.equal(calls.providerCreates.length, 2);
  assert.equal(calls.providerCreates[0].message, undefined);
  assert.equal(calls.providerCreates[1].message, "text before image");
  assert.deepEqual(calls.providerCreates[0].attachments, [signedUrl]);
  assert.equal(calls.providerCreates[0].conversationProviderId, "provider-tenant-sensitive");
  assert.equal(calls.lineBatches.length, 0);
  assert.deepEqual(calls.tenants, ["tenant-provider-sensitive", "tenant-provider-sensitive"]);
  assert.equal(calls.channels.length, 2);
});

test("successful HighLevel attachment creation remains sent when audit persistence fails", async () => {
  const calls = setupWorkflowHarness();
  calls.setEventError(new Error("audit storage unavailable"));

  const result = await workflowService.processGhlWorkflowSendLine(workflowPayload({
    attachments: [{
      url: "https://assets.example.test/private/image.png?signature=audit-sensitive",
      name: "image.png",
      size: 100
    }]
  }));

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, "sent");
  assert.equal(calls.providerCreates.length, 1);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.lineBatches.length, 0);
  const auditLogs = calls.logs.filter(({ args }) =>
    String(args.at(-1)).includes("audit persistence")
  );
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].args[0].auditPersistenceStatus, "failed");
  assert.doesNotMatch(JSON.stringify(auditLogs), /audit storage unavailable/);
});

test("provider_first video, audio, and document URLs are preserved for the HighLevel callback", async () => {
  const calls = setupWorkflowHarness();
  const urls = [
    "https://assets.example.test/private/movie.mp4?signature=video-sensitive",
    "https://assets.example.test/private/audio.mp3?signature=audio-sensitive",
    "https://assets.example.test/private/report.pdf?signature=document-sensitive"
  ];

  await workflowService.processGhlWorkflowSendLine(workflowPayload({
    attachments: [
      { url: urls[0], name: "movie.mp4", size: 10 },
      { url: urls[1], name: "audio.mp3", size: 10 },
      { url: urls[2], name: "report.pdf", size: 10 }
    ]
  }));

  assert.deepEqual(calls.providerCreates[0].attachments, urls);
  assert.equal(calls.lineBatches.length, 0);
});

test("provider_first text-only uses the pending provider message path and no direct LINE push", async () => {
  const calls = setupWorkflowHarness();
  const result = await workflowService.processGhlWorkflowSendLine(workflowPayload({
    message: "existing provider-first text"
  }));

  assert.equal(result.body.status, "sent");
  assert.equal(calls.textCreates.length, 0);
  assert.equal(calls.providerCreates.length, 1);
  assert.equal(calls.providerCreates[0].message, "existing provider-first text");
  assert.deepEqual(calls.providerCreates[0].attachments, []);
  assert.equal(calls.providerCreates[0].conversationProviderId, "provider-tenant-sensitive");
  assert.equal(calls.lineBatches.length, 0);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].tenantId, "tenant-provider-sensitive");
  assert.equal(calls.events[0].ghlMessageId, "ghl-created-message-sensitive");
  assert.equal(calls.events[0].lineUserId, "line-user-provider-sensitive");
  assert.equal(calls.events[0].ghlConversationId, "conversation-provider-sensitive");
  assert.equal(calls.events[0].requestPayload.source, "ghl_workflow_provider_dispatch");
  assert.equal(calls.events[0].requestPayload.contactId, "contact-provider-sensitive");
});

test("direct_legacy retains the current direct attachment rollback path", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "direct_legacy";
  const calls = setupWorkflowHarness();

  const result = await workflowService.processGhlWorkflowSendLine(workflowPayload({
    attachments: [{
      url: "https://assets.example.test/private/image.png?signature=rollback-sensitive",
      name: "image.png",
      size: 100
    }]
  }));

  assert.equal(result.body.status, "sent");
  assert.equal(calls.providerCreates.length, 0);
  assert.equal(calls.lineBatches.length, 1);
});

test("attachment callback accepts image only and text plus image with text first", async () => {
  const { calls } = setupCallbackHarness();
  const signedUrl = "https://assets.example.test/private/image.png?signature=callback-sensitive";

  const imageOnly = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-image-only",
    attachments: [signedUrl]
  }));
  const textAndImage = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-text-image",
    message: "private callback text",
    attachments: [signedUrl]
  }));

  assert.equal(imageOnly.status, "processed");
  assert.equal(textAndImage.status, "processed");
  assert.deepEqual(calls.lineBatches[0][1], [{
    type: "image",
    originalContentUrl: signedUrl,
    previewImageUrl: signedUrl
  }]);
  assert.deepEqual(calls.lineBatches[1][1][0], { type: "text", text: "private callback text" });
  assert.equal(calls.lineBatches[1][1][1].originalContentUrl, signedUrl);
  assert.deepEqual(calls.statusUpdates.map((item) => item.status), ["delivered", "delivered"]);
});

test("attachment callback parses and requires the exact tenant conversation provider", async () => {
  const correct = setupCallbackHarness();
  const correctResult = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-provider-correct"
  }));
  assert.equal(correctResult.status, "processed");
  assert.equal(correct.calls.claims.length, 1);
  assert.equal(correct.calls.lineBatches.length, 1);

  const nested = setupCallbackHarness();
  const nestedResult = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-provider-nested",
    conversationProviderId: undefined,
    conversationProvider: { id: "provider-callback-sensitive" }
  }));
  assert.equal(nestedResult.status, "processed");
  assert.equal(nested.calls.claims.length, 1);
  assert.equal(nested.calls.lineBatches.length, 1);

  for (const [label, payloadOverrides, configure] of [
    ["missing", { conversationProviderId: undefined }, () => undefined],
    ["mismatched", { conversationProviderId: "provider-wrong-sensitive" }, () => undefined],
    ["other-tenant", {}, (harness) => harness.controls.setConfiguredProviderId("provider-other-tenant-sensitive")]
  ]) {
    const harness = setupCallbackHarness();
    configure(harness);
    const result = await syncService.processGhlOutboundWebhook(callbackPayload({
      messageId: `message-provider-${label}`,
      ...payloadOverrides
    }));

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "Conversation provider validation failed");
    assert.equal(harness.calls.claims.length, 0);
    assert.equal(harness.calls.channels.length, 0);
    assert.equal(harness.calls.lineBatches.length, 0);
    assert.equal(harness.calls.statusUpdates.length, 0);
    assert.equal(harness.calls.events.length, 0);
  }
});

test("attachment callback accepts message and conversation nested provider IDs without exposing them", async () => {
  for (const [label, nestedProvider] of [
    ["message", { message: { conversationProviderId: "provider-callback-sensitive" } }],
    ["conversation", { conversation: { conversationProviderId: "provider-callback-sensitive" } }]
  ]) {
    const { calls } = setupCallbackHarness();
    const result = await syncService.processGhlOutboundWebhook(callbackPayload({
      messageId: `message-provider-${label}-nested`,
      conversationProviderId: undefined,
      ...nestedProvider
    }));

    assert.equal(result.status, "processed");
    assert.equal(calls.claims.length, 1);
    assert.equal(calls.lineBatches.length, 1);
    assert.equal(calls.statusUpdates.length, 1);
    assert.equal(calls.statusUpdates[0].status, "delivered");

    const observableMetadata = JSON.stringify({
      logs: calls.logs,
      claims: calls.claims.map(({ payload, requestPayload }) => ({ payload, requestPayload })),
      finalizations: calls.finalizations.map(({ requestPayload }) => ({ requestPayload }))
    });
    assert.doesNotMatch(observableMetadata, /provider-callback-sensitive/);
    assert.match(observableMetadata, /conversationProviderIdPresent|providerValidationPassed/);
  }
});

test("attachment callback rejects a mapped tenant from another location before claim or channel work", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setConfiguredTenantLocationId("location-other-tenant-sensitive");

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-location-mismatch"
  }));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "Conversation provider validation failed");
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.channels.length, 0);
  assert.equal(calls.lineBatches.length, 0);
  assert.equal(calls.statusUpdates.length, 0);
  assert.equal(calls.events.length, 0);

  const serializedLogs = JSON.stringify(calls.logs);
  assert.doesNotMatch(
    serializedLogs,
    /location-callback-sensitive|location-other-tenant-sensitive|contact-callback-sensitive|conversation-callback-sensitive|message-location-mismatch|tenant-callback-sensitive|provider-callback-sensitive|line-user-callback-sensitive|line-channel-callback-sensitive/
  );
  assert.match(
    serializedLogs,
    /locationIdPresent|locationRef|contactIdPresent|contactRef|tenantRef|providerRef|tenantLocationMatches|providerValidationPassed/
  );
});

test("text callback with an explicit wrong provider fails even when an exact dispatch record exists", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setProviderDispatchEvent({
    id: "dispatch-event-sensitive",
    tenant_id: "tenant-callback-sensitive",
    line_user_id: "line-user-callback-sensitive",
    ghl_message_id: "message-text-wrong-provider",
    ghl_conversation_id: "conversation-callback-sensitive",
    request_payload: { source: "ghl_workflow_provider_dispatch" },
    created_at: "2026-01-01T00:00:00.000Z"
  });

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-text-wrong-provider",
    message: "private wrong-provider text",
    attachments: [],
    conversationProviderId: "provider-wrong-sensitive"
  }));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "Conversation provider validation failed");
  assert.equal(calls.providerDispatchLookups.length, 0);
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.channels.length, 0);
  assert.equal(calls.lineBatches.length, 0);
  assert.equal(calls.statusUpdates.length, 0);
});

test("text callback without provider ID requires its exact same-tenant provider dispatch", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setProviderDispatchEvent({
    id: "dispatch-event-sensitive",
    tenant_id: "tenant-callback-sensitive",
    line_user_id: "line-user-callback-sensitive",
    ghl_message_id: "message-text-dispatch-match",
    ghl_conversation_id: "conversation-callback-sensitive",
    request_payload: { source: "ghl_workflow_provider_dispatch" },
    created_at: "2026-01-01T00:00:00.000Z"
  });

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-text-dispatch-match",
    message: "private dispatch-matched text",
    attachments: [],
    conversationProviderId: undefined
  }));

  assert.equal(result.status, "processed");
  assert.equal(calls.providerDispatchLookups.length, 1);
  assert.deepEqual(calls.providerDispatchLookups[0], {
    tenantId: "tenant-callback-sensitive",
    ghlMessageId: "message-text-dispatch-match",
    lineUserId: "line-user-callback-sensitive",
    ghlContactId: "contact-callback-sensitive",
    ghlConversationId: "conversation-callback-sensitive"
  });
  assert.equal(calls.claims.length, 1);
  assert.equal(calls.lineBatches.length, 1);
  assert.equal(calls.statusUpdates[0].status, "delivered");
  assert.equal(calls.claims[0].payload.providerValidationMode, "exact_provider_dispatch");
  assert.equal(calls.claims[0].payload.callbackProviderPresent, false);
  assert.equal(calls.claims[0].payload.providerDispatchEventPresent, true);
  assert.equal(calls.claims[0].payload.providerValidationPassed, true);
  const observableMetadata = JSON.stringify({
    logs: calls.logs,
    claims: calls.claims.map(({ payload, requestPayload }) => ({ payload, requestPayload })),
    finalizations: calls.finalizations.map(({ requestPayload }) => ({ requestPayload }))
  });
  assert.doesNotMatch(
    observableMetadata,
    /private dispatch-matched text|dispatch-event-sensitive|location-callback-sensitive|contact-callback-sensitive|conversation-callback-sensitive|message-text-dispatch-match|tenant-callback-sensitive|provider-callback-sensitive|line-user-callback-sensitive|line-channel-callback-sensitive/
  );
  assert.match(
    observableMetadata,
    /exact_provider_dispatch|callbackProviderPresent|providerDispatchEventPresent|providerValidationPassed/
  );
});

test("text callback without provider ID and without an exact dispatch fails before claim", async () => {
  const { calls } = setupCallbackHarness();

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-text-no-dispatch",
    message: "private unproven text",
    attachments: [],
    conversationProviderId: undefined
  }));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "Conversation provider validation failed");
  assert.equal(calls.providerDispatchLookups.length, 1);
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.channels.length, 0);
  assert.equal(calls.lineBatches.length, 0);
});

test("text callback cannot use another tenant's provider dispatch", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setProviderDispatchEvent({
    id: "dispatch-event-other-tenant-sensitive",
    tenant_id: "tenant-other-sensitive",
    line_user_id: "line-user-callback-sensitive",
    ghl_message_id: "message-text-other-tenant",
    ghl_conversation_id: "conversation-callback-sensitive",
    request_payload: { source: "ghl_workflow_provider_dispatch" },
    created_at: "2026-01-01T00:00:00.000Z"
  });

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-text-other-tenant",
    message: "private cross-tenant text",
    attachments: [],
    conversationProviderId: undefined
  }));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "Conversation provider validation failed");
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.channels.length, 0);
  assert.equal(calls.lineBatches.length, 0);
});

test("attachment callback cannot substitute provider-dispatch evidence for an exact provider ID", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setProviderDispatchEvent({
    id: "dispatch-event-attachment-sensitive",
    tenant_id: "tenant-callback-sensitive",
    line_user_id: "line-user-callback-sensitive",
    ghl_message_id: "message-attachment-no-provider",
    ghl_conversation_id: "conversation-callback-sensitive",
    request_payload: { source: "ghl_workflow_provider_dispatch" },
    created_at: "2026-01-01T00:00:00.000Z"
  });

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-attachment-no-provider",
    conversationProviderId: undefined
  }));

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "Conversation provider validation failed");
  assert.equal(calls.providerDispatchLookups.length, 0);
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.lineBatches.length, 0);
});

test("callback maps document, video, audio, and unknown attachments to ordered clickable links", async () => {
  const { calls } = setupCallbackHarness();
  const urls = [
    "https://assets.example.test/private/report.pdf?signature=pdf-sensitive",
    "https://assets.example.test/private/movie.mp4?signature=video-sensitive",
    "https://assets.example.test/private/audio.mp3?signature=audio-sensitive",
    "https://assets.example.test/private/archive.bin?signature=unknown-sensitive"
  ];

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-link-types",
    attachments: urls
  }));

  assert.equal(result.status, "processed");
  assert.equal(calls.lineBatches[0][1].length, 4);
  assert.deepEqual(
    calls.lineBatches[0][1].map((message) => message.text.split("\n").at(-1)),
    urls
  );
  assert.equal(calls.finalizations[0].status, "sent");
  assert.equal(calls.statusUpdates[0].status, "delivered");
});

test("callback enforces the five-message limit after optional text and fails deterministically", async () => {
  const { calls } = setupCallbackHarness();
  const attachments = Array.from({ length: 5 }, (_, index) =>
    `https://assets.example.test/private/file-${index}.pdf?signature=limit-${index}`
  );

  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-over-limit",
    message: "leading text",
    attachments
  }));

  assert.equal(result.status, "processed");
  assert.match(result.reason, /Invalid outbound provider content/);
  assert.equal(calls.claims.length, 1);
  assert.equal(calls.lineBatches.length, 0);
  assert.equal(calls.finalizations[0].status, "failed");
  assert.equal(calls.statusUpdates[0].status, "failed");
});

test("invalid provider attachment URLs are claimed, failed, and handled without LINE", async () => {
  for (const [index, url] of [
    "http://assets.example.test/file.pdf",
    "https://user:password@assets.example.test/file.pdf",
    "https://localhost/file.pdf",
    "https://127.0.0.1/file.pdf",
    "not-a-url"
  ].entries()) {
    const { calls } = setupCallbackHarness();
    const result = await syncService.processGhlOutboundWebhook(callbackPayload({
      messageId: `message-invalid-${index}`,
      attachments: [url]
    }));

    assert.equal(result.status, "processed");
    assert.equal(calls.claims.length, 1);
    assert.equal(calls.lineBatches.length, 0);
    assert.equal(calls.finalizations[0].status, "failed");
    assert.equal(calls.statusUpdates[0].status, "failed");
  }
});

test("concurrent and repeated attachment callbacks make one atomic claim and one LINE push", async () => {
  const { calls } = setupCallbackHarness();
  const payload = callbackPayload({ messageId: "message-concurrent" });

  const [first, second] = await Promise.all([
    syncService.processGhlOutboundWebhook(payload),
    syncService.processGhlOutboundWebhook(payload)
  ]);
  const third = await syncService.processGhlOutboundWebhook(payload);

  assert.equal([first, second].filter((result) => result.status === "processed").length, 1);
  assert.equal([first, second].filter((result) => result.reason === "Already claimed").length, 1);
  assert.equal(third.reason, "Already claimed");
  assert.equal(calls.claims.length, 3);
  assert.equal(calls.lineBatches.length, 1);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.statusUpdates.length, 1);
});

test("disconnected attachment callback claims once, fails safely, and skips its repeat", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setChannelError(new channelService.LineChannelNotConnectedError({
    lineChannelId: "line-channel-callback-sensitive",
    channelTokenSource: "profile_channel"
  }));
  const payload = callbackPayload({ messageId: "message-channel-disconnected" });

  const first = await syncService.processGhlOutboundWebhook(payload);
  const second = await syncService.processGhlOutboundWebhook(payload);

  assert.equal(first.status, "processed");
  assert.equal(first.reason, "LINE channel resolution failed");
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "Already claimed");
  assert.equal(calls.claims.length, 2);
  assert.equal(calls.lineBatches.length, 0);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.finalizations[0].status, "failed");
  assert.equal(calls.statusUpdates.length, 1);
  assert.equal(calls.statusUpdates[0].status, "failed");
});

test("LINE failure finalizes failed and updates HighLevel failed", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setLineError(new Error("provider body and URL must not leak"));

  await assert.rejects(
    () => syncService.processGhlOutboundWebhook(callbackPayload({ messageId: "message-line-failed" })),
    (error) => error.statusCode === 502
  );

  assert.equal(calls.lineBatches.length, 1);
  assert.equal(calls.finalizations[0].status, "failed");
  assert.equal(calls.statusUpdates[0].status, "failed");
});

test("status-update failure cannot resend LINE on a repeated callback", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setStatusUpdateOk(false);
  const payload = callbackPayload({ messageId: "message-status-failed" });

  const first = await syncService.processGhlOutboundWebhook(payload);
  const second = await syncService.processGhlOutboundWebhook(payload);

  assert.equal(first.status, "processed");
  assert.equal(second.reason, "Already claimed");
  assert.equal(calls.lineBatches.length, 1);
  assert.equal(calls.statusUpdates.length, 1);
});

test("text-only callback uses one atomic claim, one LINE text plan, and delivered status", async () => {
  const { calls } = setupCallbackHarness();
  const result = await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-text-only",
    message: "existing callback text",
    attachments: []
  }));

  assert.equal(result.status, "processed");
  assert.equal(calls.claims.length, 1);
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.lineBatches.length, 1);
  assert.deepEqual(calls.lineBatches[0][1], [{ type: "text", text: "existing callback text" }]);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.finalizations[0].status, "sent");
  assert.equal(calls.statusUpdates.length, 1);
  assert.equal(calls.statusUpdates[0].status, "delivered");
  assert.equal(calls.claims[0].payload.providerValidationMode, "exact_provider_id");
  assert.equal(calls.claims[0].payload.callbackProviderPresent, true);
  assert.equal(calls.claims[0].payload.providerDispatchEventPresent, false);
});

test("text-only LINE failure finalizes failed and updates HighLevel failed", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setLineError(new Error("private failure detail"));

  await assert.rejects(
    () => syncService.processGhlOutboundWebhook(callbackPayload({
      messageId: "message-text-line-failed",
      message: "private failed text",
      attachments: []
    })),
    (error) => error.statusCode === 502
  );

  assert.equal(calls.claims.length, 1);
  assert.equal(calls.lineBatches.length, 1);
  assert.equal(calls.finalizations[0].status, "failed");
  assert.equal(calls.statusUpdates[0].status, "failed");
});

test("text-only status-update failure cannot duplicate LINE on repeated callback", async () => {
  const { calls, controls } = setupCallbackHarness();
  controls.setStatusUpdateOk(false);
  const payload = callbackPayload({
    messageId: "message-text-status-failed",
    message: "private status text",
    attachments: []
  });

  const first = await syncService.processGhlOutboundWebhook(payload);
  const second = await syncService.processGhlOutboundWebhook(payload);

  assert.equal(first.status, "processed");
  assert.equal(second.reason, "Already claimed");
  assert.equal(calls.lineBatches.length, 1);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.statusUpdates.length, 1);
});

test("concurrent and repeated text-only callbacks make one LINE push", async () => {
  const { calls } = setupCallbackHarness();
  const payload = callbackPayload({
    messageId: "message-text-concurrent",
    message: "private concurrent text",
    attachments: []
  });

  const [first, second] = await Promise.all([
    syncService.processGhlOutboundWebhook(payload),
    syncService.processGhlOutboundWebhook(payload)
  ]);
  const third = await syncService.processGhlOutboundWebhook(payload);

  assert.equal([first, second].filter((result) => result.status === "processed").length, 1);
  assert.equal([first, second].filter((result) => result.reason === "Already claimed").length, 1);
  assert.equal(third.reason, "Already claimed");
  assert.equal(calls.claims.length, 3);
  assert.equal(calls.lineBatches.length, 1);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.statusUpdates.length, 1);
});

test("text-only callback logs and claim storage contain metadata without private content", async () => {
  const { calls } = setupCallbackHarness();
  await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-text-privacy-sensitive",
    message: "private text callback content",
    attachments: []
  }));

  const observableMetadata = JSON.stringify({
    logs: calls.logs,
    claims: calls.claims.map(({ payload, requestPayload }) => ({ payload, requestPayload })),
    finalizations: calls.finalizations.map(({ requestPayload }) => ({ requestPayload }))
  });
  assert.doesNotMatch(
    observableMetadata,
    /private text callback content|message-text-privacy-sensitive|location-callback-sensitive|contact-callback-sensitive|conversation-callback-sensitive|tenant-callback-sensitive|provider-callback-sensitive|line-user-callback-sensitive|line-channel-callback-sensitive|line-token-callback-sensitive/
  );
  assert.match(observableMetadata, /messagePresent|messageLength|attachmentCount|deliveryState/);
});

test("status updater uses v3 exact-location OAuth and refreshes once after 401", async () => {
  const { authCalls, refreshCalls } = setupOAuth();
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response("", { status: requests.length === 1 ? 401 : 200 });
  };

  const result = await outboundClient.updateWorkflowProviderMessageStatus({
    locationId: "location-status-sensitive",
    messageId: "message-status-sensitive",
    status: "delivered"
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    "https://services.leadconnectorhq.com/conversations/messages/message-status-sensitive/status"
  );
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(requests[0].init.headers.Version, "v3");
  assert.deepEqual(requests[0].body, { status: "delivered" });
  assert.deepEqual(authCalls, [{
    locationId: "location-status-sensitive",
    options: { allowPrivateFallback: false }
  }]);
  assert.deepEqual(refreshCalls, ["location-status-sensitive"]);
});

test("production provider callback route requires valid raw-body Ed25519 verification", async () => {
  let callbackCalls = 0;
  let verifiedRawBody;
  signatureVerifier.verifyGhlWebhookSignature = ({ rawBody, ghlSignature }) => {
    verifiedRawBody = rawBody.toString("utf8");
    return ghlSignature === "valid-signature";
  };
  syncService.processGhlOutboundWebhook = async () => {
    callbackCalls += 1;
    return { status: "processed" };
  };

  const missing = await requestApp({ body: callbackPayload() });
  const invalid = await requestApp({
    headers: { "x-ghl-signature": "invalid-signature" },
    body: callbackPayload()
  });
  const valid = await requestApp({
    headers: { "x-ghl-signature": "valid-signature" },
    body: callbackPayload()
  });

  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.equal(valid.status, 200);
  assert.equal(callbackCalls, 1);
  assert.match(verifiedRawBody, /message-callback-sensitive/);
});

test("attachment callback logs contain metadata but no raw text, signed URL, token, or complete identifiers", async () => {
  const { calls } = setupCallbackHarness();
  await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-log-sensitive",
    message: "private-log-message-sensitive",
    attachments: ["https://assets.example.test/private/report.pdf?token=signed-log-sensitive"]
  }));

  const serialized = JSON.stringify(calls.logs);
  assert.doesNotMatch(
    serialized,
    /private-log-message-sensitive|https:\/\/|signed-log-sensitive|line-token-callback-sensitive|location-callback-sensitive|contact-callback-sensitive|conversation-callback-sensitive|message-log-sensitive|tenant-callback-sensitive|provider-callback-sensitive|line-user-callback-sensitive|line-channel-callback-sensitive/
  );
  assert.match(serialized, /attachmentCount|lineResultStatus|statusUpdateStatus/);
});

test("attachment callback persistence retains structural metadata without callback content or identifiers", async () => {
  const sensitivePattern = /private-persistence-message|https:\/\/|signed-persistence-token|location-callback-sensitive|contact-callback-sensitive|conversation-callback-sensitive|message-persistence|tenant-callback-sensitive|provider-callback-sensitive|line-user-callback-sensitive|line-channel-callback-sensitive/;

  const normal = setupCallbackHarness();
  await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-persistence-normal",
    message: "private-persistence-message",
    attachments: ["https://assets.example.test/private/report.pdf?token=signed-persistence-token"]
  }));
  const normalStoredMetadata = JSON.stringify({
    claims: normal.calls.claims.map(({ payload, requestPayload }) => ({ payload, requestPayload })),
    finalizations: normal.calls.finalizations.map(({ requestPayload }) => ({ requestPayload }))
  });
  assert.doesNotMatch(normalStoredMetadata, sensitivePattern);
  assert.match(normalStoredMetadata, /messagePresent|messageLength|attachmentCount|deliveryState/);

  const invalid = setupCallbackHarness();
  await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-persistence-invalid",
    attachments: ["http://assets.example.test/private.pdf?token=signed-persistence-token"]
  }));
  const invalidStoredMetadata = JSON.stringify({
    claims: invalid.calls.claims.map(({ payload, requestPayload }) => ({ payload, requestPayload })),
    finalizations: invalid.calls.finalizations.map(({ requestPayload }) => ({ requestPayload }))
  });
  assert.doesNotMatch(invalidStoredMetadata, sensitivePattern);
  assert.match(invalidStoredMetadata, /invalid_content|attachmentCount/);

  const disconnected = setupCallbackHarness();
  disconnected.controls.setChannelError(new channelService.LineChannelNotConnectedError({
    lineChannelId: "line-channel-callback-sensitive",
    channelTokenSource: "profile_channel"
  }));
  await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-persistence-channel"
  }));
  const channelStoredMetadata = JSON.stringify({
    claims: disconnected.calls.claims.map(({ payload, requestPayload }) => ({ payload, requestPayload })),
    finalizations: disconnected.calls.finalizations.map(({ requestPayload }) => ({ requestPayload }))
  });
  assert.doesNotMatch(channelStoredMetadata, sensitivePattern);
  assert.match(channelStoredMetadata, /channel_resolution|channelConnected/);

  const unmapped = setupCallbackHarness();
  unmapped.controls.setMappingFound(false);
  await syncService.processGhlOutboundWebhook(callbackPayload({
    messageId: "message-persistence-unmapped",
    message: "private-persistence-message",
    attachments: ["https://assets.example.test/private/report.pdf?token=signed-persistence-token"]
  }));
  const unmappedStoredMetadata = JSON.stringify(
    unmapped.calls.events.map(({ payload, requestPayload }) => ({ payload, requestPayload }))
  );
  assert.doesNotMatch(unmappedStoredMetadata, sensitivePattern);
  assert.match(unmappedStoredMetadata, /messagePresent|attachmentCount/);
});
