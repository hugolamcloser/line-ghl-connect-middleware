const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "";

const config = require("../dist/config/env");
const loggerModule = require("../dist/config/logger");
const repository = require("../dist/services/repository");
const outboundClient = require("../dist/integrations/ghlWorkflowOutboundMirrorClient");
const lineClient = require("../dist/integrations/lineClient");
const channelService = require("../dist/services/lineOutboundChannelService");
const workflowService = require("../dist/services/ghlWorkflowActionService");
const syncService = require("../dist/services/ghlSyncService");

const patchedExports = [
  [repository, "getTenantIdsByLocationId"],
  [repository, "findLineProfileByGhlIdsForTenantIds"],
  [repository, "getTenantById"],
  [repository, "findWorkflowOutboundMirrorMessageEventForTenantIds"],
  [repository, "findWorkflowProviderDispatchMessageEvent"],
  [repository, "claimGhlOutboundProviderDelivery"],
  [repository, "finalizeGhlOutboundProviderDelivery"],
  [repository, "saveMessageEvent"],
  [outboundClient, "mirrorWorkflowOutboundMessageToGhl"],
  [outboundClient, "createWorkflowProviderMessage"],
  [outboundClient, "updateWorkflowProviderMessageStatus"],
  [lineClient, "pushLineTextMessage"],
  [lineClient, "pushLineMessages"],
  [channelService, "resolveLineChannelForOutbound"],
  [loggerModule.logger, "info"],
  [loggerModule.logger, "warn"],
  [loggerModule.logger, "error"]
];
const originals = patchedExports.map(([module, key]) => [module, key, module[key]]);
const originalMode = config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE;
const originalAllowlist = config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST;

afterEach(() => {
  for (const [module, key, value] of originals) {
    module[key] = value;
  }
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = originalMode;
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = originalAllowlist;
});

function textPayload(overrides = {}) {
  return {
    locationId: "location-canary",
    contactId: "contact-canary",
    workflowId: "workflow-canary",
    message: "safe canary text",
    ...overrides
  };
}

function attachmentPayload(overrides = {}) {
  return textPayload({
    message: "",
    imageAttachment: [
      {
        url: "https://assets.example.test/media/canary.png",
        name: "canary.png",
        size: 1000
      }
    ],
    ...overrides
  });
}

function setupWorkflowHarness() {
  const calls = {
    tenantLookups: [],
    profileLookups: [],
    legacyCreates: [],
    v3Creates: [],
    textPushes: [],
    linePlans: [],
    channelSelections: [],
    events: [],
    logs: []
  };

  repository.getTenantIdsByLocationId = async () => ["tenant-canary"];
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds, ids) => {
    calls.profileLookups.push({ tenantIds, ids });
    return {
      id: "profile-canary",
      tenant_id: "tenant-canary",
      line_user_id: "line-user-canary",
      line_channel_id: "line-channel-canary",
      ghl_contact_id: "contact-canary",
      ghl_conversation_id: "conversation-canary"
    };
  };
  repository.getTenantById = async (tenantId) => {
    calls.tenantLookups.push(tenantId);
    return {
      id: tenantId,
      location_id: "location-canary",
      ghl_provider_id: "provider-canary"
    };
  };
  repository.saveMessageEvent = async (input) => calls.events.push(input);
  channelService.resolveLineChannelForOutbound = async (tenantId) => {
    calls.channelSelections.push(tenantId);
    return {
      channelAccessToken: "line-token-canary",
      lineChannelId: "line-channel-canary",
      channelTokenSource: "profile_channel"
    };
  };
  outboundClient.mirrorWorkflowOutboundMessageToGhl = async (input) => {
    calls.legacyCreates.push(input);
    return {
      ok: true,
      endpoint: "/conversations/messages",
      method: "POST",
      authMode: "oauth",
      statusCode: 201,
      requestBody: { type: "Custom", status: "delivered" },
      ghlMessageId: "legacy-message-canary",
      ghlConversationId: "conversation-canary"
    };
  };
  outboundClient.createWorkflowProviderMessage = async (input) => {
    calls.v3Creates.push(input);
    return {
      ok: true,
      endpoint: "/conversations/messages",
      method: "POST",
      authMode: "oauth",
      statusCode: 201,
      requestBody: { type: "Custom", status: "pending" },
      ghlMessageId: "v3-message-canary",
      ghlConversationId: "conversation-canary"
    };
  };
  lineClient.pushLineTextMessage = async (...args) => {
    calls.textPushes.push(args);
    return { messageId: "line-text-canary", statusCode: 200 };
  };
  lineClient.pushLineMessages = async (...args) => {
    calls.linePlans.push(args);
    return { messageId: "line-plan-canary", statusCode: 200 };
  };
  for (const level of ["info", "warn", "error"]) {
    loggerModule.logger[level] = (...args) => calls.logs.push({ level, args });
  }

  return calls;
}

for (const [name, allowlist] of [
  ["missing allowlist", ""],
  ["empty allowlist", "  , , "],
  ["different tenant", "tenant-other"],
  ["case-mismatched tenant", "TENANT-CANARY"],
  ["unsupported wildcard", "*"]
]) {
  test(`provider_first text with ${name} uses the pre-PR58 provider path`, async () => {
    config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
    config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = allowlist;
    const calls = setupWorkflowHarness();

    const result = await workflowService.processGhlWorkflowSendLine(textPayload());

    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.status, "sent");
    assert.equal(calls.legacyCreates.length, 1);
    assert.equal(calls.v3Creates.length, 0);
    assert.equal(calls.textPushes.length, 0);
    assert.equal(calls.linePlans.length, 0);
    assert.equal(calls.events[0].requestPayload.lifecycle, "provider_first_legacy");
  });
}

test("the exact resolved tenant enables the v3 text lifecycle", async () => {
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST =
    " tenant-other, tenant-canary, ,tenant-canary ";
  const calls = setupWorkflowHarness();

  const result = await workflowService.processGhlWorkflowSendLine(textPayload());

  assert.equal(result.body.status, "sent");
  assert.equal(calls.v3Creates.length, 1);
  assert.equal(calls.legacyCreates.length, 0);
  assert.equal(calls.v3Creates[0].message, "safe canary text");
  assert.deepEqual(calls.v3Creates[0].attachments, []);
  const serializedLogs = JSON.stringify(calls.logs);
  assert.doesNotMatch(serializedLogs, /tenant-canary/);
  assert.doesNotMatch(serializedLogs, /tenant-other/);
  assert.match(serializedLogs, /allowlistConfigured/);
  assert.match(serializedLogs, /tenantAllowlistMatch/);
  assert.match(serializedLogs, /provider_first_v3/);
});

test("allowlisted attachments use v3 while non-allowlisted attachments preserve direct Phase 2 delivery", async () => {
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant-canary";
  const allowlistedCalls = setupWorkflowHarness();
  const allowlistedResult = await workflowService.processGhlWorkflowSendLine(attachmentPayload());

  assert.equal(allowlistedResult.body.status, "sent");
  assert.equal(allowlistedCalls.v3Creates.length, 1);
  assert.equal(allowlistedCalls.linePlans.length, 0);
  assert.equal(allowlistedCalls.v3Creates[0].attachments.length, 1);

  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant-other";
  const legacyCalls = setupWorkflowHarness();
  const legacyResult = await workflowService.processGhlWorkflowSendLine(attachmentPayload());

  assert.equal(legacyResult.body.status, "sent");
  assert.equal(legacyCalls.v3Creates.length, 0);
  assert.equal(legacyCalls.legacyCreates.length, 0);
  assert.equal(legacyCalls.linePlans.length, 1);
  assert.equal(legacyCalls.linePlans[0][1].length, 1);
});

test("direct_legacy remains direct regardless of an exact canary match", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "direct_legacy";
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant-canary";
  const calls = setupWorkflowHarness();

  const result = await workflowService.processGhlWorkflowSendLine(textPayload());

  assert.equal(result.body.status, "sent");
  assert.equal(calls.textPushes.length, 1);
  assert.equal(calls.legacyCreates.length, 0);
  assert.equal(calls.v3Creates.length, 0);
});

test("an allowlisted mapping whose tenant belongs to another location fails closed", async () => {
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant-canary";
  const calls = setupWorkflowHarness();
  repository.getTenantById = async () => ({
    id: "tenant-canary",
    location_id: "location-other",
    ghl_provider_id: "provider-canary"
  });

  const result = await workflowService.processGhlWorkflowSendLine(textPayload());

  assert.equal(result.body.status, "failed");
  assert.match(result.body.error, /does not belong/);
  assert.equal(calls.v3Creates.length, 0);
  assert.equal(calls.legacyCreates.length, 0);
  assert.equal(calls.channelSelections.length, 0);
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.linePlans.length, 0);
});

test("empty text and attachments reject before mapping or outbound calls", async () => {
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant-canary";
  const calls = setupWorkflowHarness();

  const result = await workflowService.processGhlWorkflowSendLine(
    textPayload({ message: "  ", imageAttachment: "" })
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.status, "failed");
  assert.equal(calls.profileLookups.length, 0);
  assert.equal(calls.legacyCreates.length, 0);
  assert.equal(calls.v3Creates.length, 0);
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.linePlans.length, 0);
});

test("a non-allowlisted provider callback retains the pre-PR58 text lifecycle", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant-other";
  const calls = { textPushes: 0, linePlans: 0, updates: 0, claims: 0, finalizations: 0 };

  repository.getTenantIdsByLocationId = async () => ["tenant-canary"];
  repository.findWorkflowOutboundMirrorMessageEventForTenantIds = async () => null;
  repository.findLineProfileByGhlIdsForTenantIds = async () => ({
    id: "profile-canary",
    tenant_id: "tenant-canary",
    line_user_id: "line-user-canary",
    line_channel_id: "line-channel-canary",
    ghl_contact_id: "contact-canary",
    ghl_conversation_id: "conversation-canary"
  });
  channelService.resolveLineChannelForOutbound = async () => ({
    channelAccessToken: "line-token-canary",
    lineChannelId: "line-channel-canary",
    channelTokenSource: "profile_channel"
  });
  repository.claimGhlOutboundProviderDelivery = async (input) => {
    calls.claims += 1;
    return {
      claimed: true,
      eventId: "legacy-claim-canary",
      externalMessageId: `claim:${input.ghlMessageId}`
    };
  };
  repository.finalizeGhlOutboundProviderDelivery = async () => {
    calls.finalizations += 1;
  };
  lineClient.pushLineTextMessage = async () => {
    calls.textPushes += 1;
    return { messageId: "legacy-line-message", statusCode: 200 };
  };
  lineClient.pushLineMessages = async () => {
    calls.linePlans += 1;
    return { messageId: "unexpected-line-plan", statusCode: 200 };
  };
  outboundClient.updateWorkflowProviderMessageStatus = async () => {
    calls.updates += 1;
    return { ok: true, statusCode: 200, authMode: "oauth" };
  };

  const result = await syncService.processGhlOutboundWebhook({
    locationId: "location-canary",
    contactId: "contact-canary",
    conversationId: "conversation-canary",
    messageId: "legacy-message-canary",
    message: "safe legacy callback text"
  });

  assert.deepEqual(result, { status: "processed" });
  assert.equal(calls.claims, 1);
  assert.equal(calls.textPushes, 1);
  assert.equal(calls.linePlans, 0);
  assert.equal(calls.finalizations, 1);
  assert.equal(calls.updates, 0);
});

test("allowlisted concurrent callbacks retain one atomic claim and one LINE delivery", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  config.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant-canary";
  const claims = new Set();
  const calls = { claims: 0, pushes: 0, finalizations: 0, updates: 0 };

  repository.getTenantIdsByLocationId = async () => ["tenant-canary"];
  repository.findWorkflowOutboundMirrorMessageEventForTenantIds = async () => null;
  repository.findWorkflowProviderDispatchMessageEvent = async () => null;
  repository.findLineProfileByGhlIdsForTenantIds = async () => ({
    id: "profile-canary",
    tenant_id: "tenant-canary",
    line_user_id: "line-user-canary",
    line_channel_id: "line-channel-canary",
    ghl_contact_id: "contact-canary",
    ghl_conversation_id: "conversation-canary"
  });
  repository.getTenantById = async () => ({
    id: "tenant-canary",
    location_id: "location-canary",
    ghl_provider_id: "provider-canary"
  });
  repository.claimGhlOutboundProviderDelivery = async (input) => {
    calls.claims += 1;
    if (claims.has(input.ghlMessageId)) {
      return { claimed: false, externalMessageId: `claim:${input.ghlMessageId}` };
    }
    claims.add(input.ghlMessageId);
    return {
      claimed: true,
      eventId: "claim-event-canary",
      externalMessageId: `claim:${input.ghlMessageId}`
    };
  };
  repository.finalizeGhlOutboundProviderDelivery = async () => {
    calls.finalizations += 1;
  };
  channelService.resolveLineChannelForOutbound = async () => ({
    channelAccessToken: "line-token-canary",
    lineChannelId: "line-channel-canary",
    channelTokenSource: "profile_channel"
  });
  lineClient.pushLineMessages = async () => {
    calls.pushes += 1;
    return { messageId: "line-message-canary", statusCode: 200 };
  };
  outboundClient.updateWorkflowProviderMessageStatus = async () => {
    calls.updates += 1;
    return { ok: true, statusCode: 200, authMode: "oauth" };
  };

  const callback = {
    locationId: "location-canary",
    contactId: "contact-canary",
    conversationId: "conversation-canary",
    messageId: "message-canary",
    conversationProviderId: "provider-canary",
    message: "safe callback text"
  };
  const results = await Promise.all([
    syncService.processGhlOutboundWebhook(callback),
    syncService.processGhlOutboundWebhook(callback)
  ]);

  assert.equal(calls.claims, 2);
  assert.equal(calls.pushes, 1);
  assert.equal(calls.finalizations, 1);
  assert.equal(calls.updates, 1);
  assert.equal(results.filter((result) => result.status === "processed").length, 1);
  assert.equal(results.filter((result) => result.reason === "Already claimed").length, 1);
});
