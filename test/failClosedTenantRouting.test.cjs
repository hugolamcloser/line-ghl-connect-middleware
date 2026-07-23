const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.GHL_LOCATION_ID = "global_location_must_not_be_used";
process.env.GHL_CUSTOM_PROVIDER_ID = "global_provider_must_not_be_used";
process.env.GHL_LOCATION_API_AUTH_MODE = "private_integration";
process.env.GHL_PRIVATE_INTEGRATION_TOKEN = "test-private-token";
process.env.GHL_INBOUND_MESSAGE_TYPE = "Custom";
process.env.GHL_SEND_CONVERSATION_PROVIDER_ID = "true";
process.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant_exact";

const repository = require("../dist/services/repository");
const ghlLocationClient = require("../dist/integrations/ghlLocationClient");
const ghlInboundMessageClient = require("../dist/integrations/ghlInboundMessageClient");
const workflowOutboundClient = require("../dist/integrations/ghlWorkflowOutboundMirrorClient");
const lineClient = require("../dist/integrations/lineClient");
const lineOutboundChannelService = require("../dist/services/lineOutboundChannelService");
const lineSyncService = require("../dist/services/lineSyncService");
const ghlSyncService = require("../dist/services/ghlSyncService");

const patchedExports = [
  [repository, "ensureDefaultTenant"],
  [repository, "getTenantById"],
  [repository, "saveWebhookEvent"],
  [repository, "markWebhookEventProcessed"],
  [repository, "saveMessageEvent"],
  [repository, "upsertLineProfile"],
  [repository, "linkGhlMapping"],
  [repository, "getTenantIdsByLocationId"],
  [repository, "findWorkflowOutboundMirrorMessageEventForTenantIds"],
  [repository, "claimGhlOutboundProviderDelivery"],
  [repository, "finalizeGhlOutboundProviderDelivery"],
  [repository, "findLineProfileByGhlIdsForTenantIds"],
  [ghlLocationClient, "createGhlContact"],
  [ghlLocationClient, "ensureGhlContactLineMetadata"],
  [ghlInboundMessageClient, "sendInboundMessageToGhl"],
  [workflowOutboundClient, "updateWorkflowProviderMessageStatus"],
  [lineClient, "getLineProfile"],
  [lineClient, "pushLineTextMessage"],
  [lineClient, "pushLineMessages"],
  [lineOutboundChannelService, "resolveLineChannelForOutbound"]
];
const originals = patchedExports.map(([module, key]) => [module, key, module[key]]);

afterEach(() => {
  for (const [module, key, value] of originals) {
    module[key] = value;
  }
});

function buildLineEvent(messageId = "line_message_1") {
  return {
    type: "message",
    webhookEventId: `webhook_${messageId}`,
    source: {
      type: "user",
      userId: "line_user_1"
    },
    message: {
      id: messageId,
      type: "text",
      text: "tenant routing test"
    }
  };
}

function setupLineInboundHarness(getTenantById) {
  const messageEvents = [];
  const calls = {
    createContact: 0,
    updateContactMetadata: 0,
    sendInboundMessage: 0,
    getLineProfile: 0,
    upsertLineProfile: 0,
    markedWebhookProcessed: 0
  };

  repository.getTenantById = getTenantById;
  repository.ensureDefaultTenant = async () => {
    throw new Error("ensureDefaultTenant must not be called for a tenant-scoped event");
  };
  repository.saveWebhookEvent = async () => ({ id: "webhook_event_1" });
  repository.markWebhookEventProcessed = async () => {
    calls.markedWebhookProcessed += 1;
  };
  repository.saveMessageEvent = async (input) => {
    messageEvents.push(input);
  };
  repository.upsertLineProfile = async () => {
    calls.upsertLineProfile += 1;
    return {
      id: "profile_1",
      tenant_id: "tenant_exact",
      line_user_id: "line_user_1",
      line_source_type: "user",
      line_source_id: "line_user_1",
      display_name: "LINE User",
      picture_url: null,
      ghl_contact_id: "contact_exact",
      ghl_conversation_id: null,
      line_channel_id: "line_channel_exact",
      created_at: "2026-07-12T00:00:00.000Z",
      updated_at: "2026-07-12T00:00:00.000Z"
    };
  };
  repository.linkGhlMapping = async () => {
    throw new Error("linkGhlMapping is not expected in this test");
  };
  lineClient.getLineProfile = async () => {
    calls.getLineProfile += 1;
    return { displayName: "LINE User" };
  };
  ghlLocationClient.createGhlContact = async () => {
    calls.createContact += 1;
    return { id: "unexpected_contact" };
  };
  ghlLocationClient.ensureGhlContactLineMetadata = async () => {
    calls.updateContactMetadata += 1;
  };
  ghlInboundMessageClient.sendInboundMessageToGhl = async () => {
    calls.sendInboundMessage += 1;
    return {
      response: { messageId: "ghl_message_1" },
      diagnostics: {
        actual_auth_mode_used: "oauth",
        statusCode: 201
      }
    };
  };

  return { calls, messageEvents };
}

async function assertTenantConfigFailsClosed(getTenantById, expectedMessage) {
  const { calls, messageEvents } = setupLineInboundHarness(getTenantById);
  const result = await lineSyncService.processLineWebhookEvent(buildLineEvent(), {
    tenantId: "tenant_exact",
    lineChannelId: "line_channel_exact",
    webhookKey: "webhook_key_exact",
    channelAccessToken: "line_channel_token_exact"
  });

  assert.equal(result.status, "failed");
  assert.match(result.reason, expectedMessage);
  assert.equal(calls.createContact, 0);
  assert.equal(calls.updateContactMetadata, 0);
  assert.equal(calls.sendInboundMessage, 0);
  assert.equal(calls.getLineProfile, 0);
  assert.equal(calls.upsertLineProfile, 0);
  assert.equal(calls.markedWebhookProcessed, 1);
  assert.equal(messageEvents.length, 1);
  assert.equal(messageEvents[0].tenantId, "tenant_exact");
  assert.equal(messageEvents[0].status, "failed");
  assert.equal(messageEvents[0].requestPayload.configSource, "tenant");
  assert.doesNotMatch(
    JSON.stringify({ result, messageEvents }),
    /global_location_must_not_be_used|global_provider_must_not_be_used/
  );
}

test("tenant lookup database failure cannot fall back to global GHL configuration", async () => {
  await assertTenantConfigFailsClosed(
    async () => {
      throw new Error("Supabase tenant lookup failed");
    },
    /Supabase tenant lookup failed/
  );
});

test("missing tenant row cannot fall back to global GHL configuration", async () => {
  await assertTenantConfigFailsClosed(async () => null, /Tenant tenant_exact was not found/);
});

test("tenant missing location_id fails closed", async () => {
  await assertTenantConfigFailsClosed(
    async () => ({
      id: "tenant_exact",
      location_id: "   ",
      ghl_provider_id: "provider_exact"
    }),
    /has no location_id/
  );
});

test("tenant missing ghl_provider_id fails closed", async () => {
  await assertTenantConfigFailsClosed(
    async () => ({
      id: "tenant_exact",
      location_id: "location_exact",
      ghl_provider_id: "   "
    }),
    /has no ghl_provider_id/
  );
});

test("valid tenant uses its exact location_id and ghl_provider_id", async () => {
  const { calls, messageEvents } = setupLineInboundHarness(async (tenantId) => ({
    id: tenantId,
    location_id: "location_exact",
    ghl_provider_id: "provider_exact"
  }));
  let inboundInput;
  ghlInboundMessageClient.sendInboundMessageToGhl = async (input) => {
    calls.sendInboundMessage += 1;
    inboundInput = input;
    return {
      response: { messageId: "ghl_message_exact" },
      diagnostics: {
        actual_auth_mode_used: "oauth",
        statusCode: 201
      }
    };
  };

  const result = await lineSyncService.processLineWebhookEvent(buildLineEvent("line_message_exact"), {
    tenantId: "tenant_exact",
    lineChannelId: "line_channel_exact",
    webhookKey: "webhook_key_exact",
    channelAccessToken: "line_channel_token_exact"
  });

  assert.equal(result.status, "processed");
  assert.equal(inboundInput.tenantId, "tenant_exact");
  assert.equal(inboundInput.locationId, "location_exact");
  assert.equal(inboundInput.conversationProviderId, "provider_exact");
  assert.equal(calls.createContact, 0);
  assert.equal(calls.updateContactMetadata, 1);
  assert.equal(calls.sendInboundMessage, 1);
  assert.equal(messageEvents.at(-1).status, "success");
});

function setupGhlOutboundHarness() {
  const calls = {
    ensureDefaultTenant: 0,
    locationLookups: [],
    mirrorGuardTenantIds: [],
    claimTenantIds: [],
    finalizations: [],
    profileLookupTenantIds: [],
    channelSelection: 0,
    linePush: 0
  };
  const messageEvents = [];

  repository.ensureDefaultTenant = async () => {
    calls.ensureDefaultTenant += 1;
    return "tenant_global";
  };
  repository.getTenantIdsByLocationId = async (locationId) => {
    calls.locationLookups.push(locationId);
    return ["tenant_exact"];
  };
  repository.findWorkflowOutboundMirrorMessageEventForTenantIds = async (input) => {
    calls.mirrorGuardTenantIds.push(input.tenantIds);
    return null;
  };
  repository.getTenantById = async () => ({
    id: "tenant_exact",
    location_id: "location_exact",
    ghl_provider_id: "provider_exact"
  });
  repository.claimGhlOutboundProviderDelivery = async (input) => {
    calls.claimTenantIds.push(input.tenantId);
    return {
      claimed: true,
      eventId: "claim_exact",
      externalMessageId: `ghl-provider-delivery:${input.ghlMessageId}`
    };
  };
  repository.finalizeGhlOutboundProviderDelivery = async (input) => {
    calls.finalizations.push(input);
  };
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds) => {
    calls.profileLookupTenantIds.push(tenantIds);
    return {
      id: "profile_exact",
      tenant_id: "tenant_exact",
      line_user_id: "line_user_exact",
      line_channel_id: "line_channel_exact",
      ghl_contact_id: "contact_exact",
      ghl_conversation_id: "conversation_exact"
    };
  };
  repository.saveMessageEvent = async (input) => {
    messageEvents.push(input);
  };
  lineOutboundChannelService.resolveLineChannelForOutbound = async (tenantId) => {
    calls.channelSelection += 1;
    assert.equal(tenantId, "tenant_exact");
    return {
      channelAccessToken: "line_token_exact",
      lineChannelId: "line_channel_exact",
      channelTokenSource: "tenant_active_channel"
    };
  };
  lineClient.pushLineMessages = async (_lineUserId, _messages, channelAccessToken) => {
    calls.linePush += 1;
    assert.equal(channelAccessToken, "line_token_exact");
    return { messageId: "line_message_exact", statusCode: 200 };
  };
  workflowOutboundClient.updateWorkflowProviderMessageStatus = async () => ({
    ok: true,
    authMode: "oauth",
    statusCode: 200
  });

  return { calls, messageEvents };
}

test("GHL outbound payload without locationId sends no LINE message or tenant lookup", async () => {
  const { calls } = setupGhlOutboundHarness();

  const result = await ghlSyncService.processGhlOutboundWebhook({
    message: "missing location test",
    contactId: "contact_global_collision",
    conversationId: "conversation_global_collision",
    messageId: "ghl_message_missing_location"
  });

  assert.deepEqual(result, { status: "skipped", reason: "Missing locationId" });
  assert.equal(calls.ensureDefaultTenant, 0);
  assert.deepEqual(calls.locationLookups, []);
  assert.deepEqual(calls.mirrorGuardTenantIds, []);
  assert.deepEqual(calls.claimTenantIds, []);
  assert.deepEqual(calls.profileLookupTenantIds, []);
  assert.equal(calls.channelSelection, 0);
  assert.equal(calls.linePush, 0);
});

test("GHL outbound payload with locationId selects only the exact tenant", async () => {
  const { calls, messageEvents } = setupGhlOutboundHarness();

  const result = await ghlSyncService.processGhlOutboundWebhook({
    message: "exact tenant test",
    locationId: "location_exact",
    contactId: "contact_exact",
    conversationId: "conversation_exact",
    messageId: "ghl_message_exact",
    conversationProviderId: "provider_exact"
  });

  assert.equal(result.status, "processed");
  assert.equal(calls.ensureDefaultTenant, 0);
  assert.deepEqual(calls.locationLookups, ["location_exact"]);
  assert.deepEqual(calls.mirrorGuardTenantIds, [["tenant_exact"]]);
  assert.deepEqual(calls.claimTenantIds, ["tenant_exact"]);
  assert.deepEqual(calls.profileLookupTenantIds, [["tenant_exact"]]);
  assert.equal(calls.channelSelection, 1);
  assert.equal(calls.linePush, 1);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.finalizations[0].tenantId, "tenant_exact");
  assert.equal(calls.finalizations[0].status, "sent");
});

test("workflow mirror duplicate protection remains unchanged for exact tenant", async () => {
  const { calls, messageEvents } = setupGhlOutboundHarness();
  repository.findWorkflowOutboundMirrorMessageEventForTenantIds = async (input) => {
    calls.mirrorGuardTenantIds.push(input.tenantIds);
    return {
      id: "mirror_event_exact",
      tenant_id: "tenant_exact",
      ghl_message_id: "ghl_mirror_message"
    };
  };

  const result = await ghlSyncService.processGhlOutboundWebhook({
    message: "mirror echo",
    locationId: "location_exact",
    contactId: "contact_exact",
    conversationId: "conversation_exact",
    messageId: "ghl_mirror_message"
  });

  assert.deepEqual(result, { status: "skipped", reason: "Workflow outbound mirror echo" });
  assert.deepEqual(calls.locationLookups, ["location_exact"]);
  assert.deepEqual(calls.mirrorGuardTenantIds, [["tenant_exact"]]);
  assert.deepEqual(calls.claimTenantIds, []);
  assert.deepEqual(calls.profileLookupTenantIds, []);
  assert.equal(calls.channelSelection, 0);
  assert.equal(calls.linePush, 0);
  assert.equal(messageEvents.length, 1);
  assert.equal(messageEvents[0].requestPayload.skipReason, "workflow_outbound_mirror_echo");
});
