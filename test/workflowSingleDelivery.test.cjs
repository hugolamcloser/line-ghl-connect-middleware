const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.GHL_CUSTOM_PROVIDER_ID = "global_provider_must_not_be_used";
process.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST = "tenant_exact";

const config = require("../dist/config/env");
const supabaseConfig = require("../dist/config/supabase");
const repository = require("../dist/services/repository");
const workflowOutboundClient = require("../dist/integrations/ghlWorkflowOutboundMirrorClient");
const lineClient = require("../dist/integrations/lineClient");
const lineOutboundChannelService = require("../dist/services/lineOutboundChannelService");
const ghlWorkflowActionService = require("../dist/services/ghlWorkflowActionService");
const ghlSyncService = require("../dist/services/ghlSyncService");

const patchedExports = [
  [supabaseConfig, "getSupabase"],
  [repository, "getTenantIdsByLocationId"],
  [repository, "findLineProfileByGhlIdsForTenantIds"],
  [repository, "getTenantById"],
  [repository, "findWorkflowOutboundMirrorMessageEventForTenantIds"],
  [repository, "claimGhlOutboundProviderDelivery"],
  [repository, "finalizeGhlOutboundProviderDelivery"],
  [repository, "saveMessageEvent"],
  [workflowOutboundClient, "mirrorWorkflowOutboundMessageToGhl"],
  [workflowOutboundClient, "createWorkflowProviderMessage"],
  [workflowOutboundClient, "updateWorkflowProviderMessageStatus"],
  [lineOutboundChannelService, "resolveLineChannelForOutbound"],
  [lineClient, "pushLineTextMessage"],
  [lineClient, "pushLineMessages"]
];
const originals = patchedExports.map(([module, key]) => [module, key, module[key]]);
const originalDeliveryMode = config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE;
const originalMirrorEnabled = config.env.GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED;

afterEach(() => {
  for (const [module, key, value] of originals) {
    module[key] = value;
  }

  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = originalDeliveryMode;
  config.env.GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED = originalMirrorEnabled;
});

function workflowPayload(overrides = {}) {
  return {
    data: { message: "one workflow reply" },
    extras: {
      locationId: "location_exact",
      contactId: "contact_exact",
      workflowId: "workflow_exact"
    },
    meta: { key: "send-line", version: "1" },
    ...overrides
  };
}

function setupWorkflowHarness() {
  const calls = {
    tenantLocations: [],
    profileLookups: [],
    tenantLookups: [],
    channelSelections: [],
    providerDispatches: [],
    linePushes: []
  };
  const messageEvents = [];

  repository.getTenantIdsByLocationId = async (locationId) => {
    calls.tenantLocations.push(locationId);
    return ["tenant_exact"];
  };
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds, ids) => {
    calls.profileLookups.push({ tenantIds, ids });
    return {
      id: "profile_exact",
      tenant_id: "tenant_exact",
      line_user_id: "line_user_exact",
      line_channel_id: "line_channel_exact",
      ghl_contact_id: "contact_exact",
      ghl_conversation_id: "conversation_exact"
    };
  };
  repository.getTenantById = async (tenantId) => {
    calls.tenantLookups.push(tenantId);
    return {
      id: "tenant_exact",
      location_id: "location_exact",
      ghl_provider_id: "provider_exact"
    };
  };
  repository.saveMessageEvent = async (input) => {
    messageEvents.push(input);
  };
  lineOutboundChannelService.resolveLineChannelForOutbound = async (tenantId, mapping) => {
    calls.channelSelections.push({ tenantId, mapping });
    return {
      channelAccessToken: "line_token_exact",
      lineChannelId: "line_channel_exact",
      channelTokenSource: "profile_channel"
    };
  };
  workflowOutboundClient.createWorkflowProviderMessage = async (input) => {
    calls.providerDispatches.push(input);
    return {
      ok: true,
      endpoint: "/conversations/messages",
      method: "POST",
      authMode: "oauth",
      statusCode: 201,
      requestBody: {
        type: "Custom",
        contactId: input.contactId,
        message: input.message,
        status: "pending",
        conversationProviderId: input.conversationProviderId
      },
      ghlMessageId: "ghl_message_exact",
      ghlConversationId: "conversation_exact"
    };
  };
  lineClient.pushLineTextMessage = async (...args) => {
    calls.linePushes.push(args);
    return { messageId: "line_message_unexpected" };
  };

  return { calls, messageEvents };
}

test("provider_first workflow dispatch uses the exact tenant provider and never pushes LINE directly", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  const { calls, messageEvents } = setupWorkflowHarness();

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(workflowPayload());

  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.body, {
    ok: true,
    status: "sent",
    provider: "line",
    lineMessageId: null,
    error: ""
  });
  assert.deepEqual(calls.tenantLocations, ["location_exact"]);
  assert.deepEqual(calls.profileLookups, [{
    tenantIds: ["tenant_exact"],
    ids: { contactId: "contact_exact" }
  }]);
  assert.deepEqual(calls.tenantLookups, ["tenant_exact"]);
  assert.equal(calls.channelSelections.length, 1);
  assert.equal(calls.providerDispatches.length, 1);
  assert.equal(calls.providerDispatches[0].locationId, "location_exact");
  assert.equal(calls.providerDispatches[0].contactId, "contact_exact");
  assert.equal(calls.providerDispatches[0].conversationProviderId, "provider_exact");
  assert.equal(calls.linePushes.length, 0);
  assert.equal(messageEvents.length, 1);
  assert.equal(messageEvents[0].tenantId, "tenant_exact");
  assert.equal(messageEvents[0].ghlMessageId, "ghl_message_exact");
  assert.equal(messageEvents[0].status, "success");
  assert.equal(messageEvents[0].requestPayload.source, "ghl_workflow_provider_dispatch");
  assert.notEqual(messageEvents[0].requestPayload.source, "ghl_workflow_outbound_mirror");
});

test("provider_first fails closed when the mapped tenant does not belong to the exact location", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  const { calls, messageEvents } = setupWorkflowHarness();
  repository.getTenantById = async () => ({
    id: "tenant_exact",
    location_id: "location_other",
    ghl_provider_id: "provider_other"
  });

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(workflowPayload());

  assert.equal(result.body.ok, false);
  assert.equal(result.body.status, "failed");
  assert.match(result.body.error, /does not belong/);
  assert.equal(calls.channelSelections.length, 0);
  assert.equal(calls.providerDispatches.length, 0);
  assert.equal(calls.linePushes.length, 0);
  assert.equal(messageEvents.length, 0);
});

test("provider_first missing locationId performs no tenant, profile, channel, provider, or LINE operation", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  const { calls } = setupWorkflowHarness();
  const payload = workflowPayload();
  delete payload.extras.locationId;

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(payload);

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.ok, false);
  assert.deepEqual(calls.tenantLocations, []);
  assert.deepEqual(calls.profileLookups, []);
  assert.deepEqual(calls.channelSelections, []);
  assert.deepEqual(calls.providerDispatches, []);
  assert.deepEqual(calls.linePushes, []);
});

test("provider_first disconnected channel fails before HighLevel dispatch", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  const { calls, messageEvents } = setupWorkflowHarness();
  lineOutboundChannelService.resolveLineChannelForOutbound = async () => {
    throw new lineOutboundChannelService.LineChannelNotConnectedError({
      lineChannelId: "line_channel_exact",
      channelTokenSource: "profile_channel"
    });
  };

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(workflowPayload());

  assert.equal(result.httpStatus, 409);
  assert.equal(result.body.ok, false);
  assert.equal(calls.providerDispatches.length, 0);
  assert.equal(calls.linePushes.length, 0);
  assert.equal(messageEvents.length, 0);
});

test("safe direct_legacy rollback disables outbound mirroring and retains one direct LINE push", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "direct_legacy";
  config.env.GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED = false;
  const { calls, messageEvents } = setupWorkflowHarness();

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(workflowPayload());

  assert.equal(result.body.ok, true);
  assert.equal(result.body.lineMessageId, "line_message_unexpected");
  assert.equal(calls.linePushes.length, 1);
  assert.equal(calls.providerDispatches.length, 0);
  assert.equal(messageEvents.at(-1).provider, "line");
  assert.equal(messageEvents.at(-1).status, "sent");
});

test("repository atomic claim distinguishes success, unique conflict, and database failure", async () => {
  const inserts = [];
  const responses = [
    { data: { id: "claim_db_exact" }, error: null },
    { data: null, error: { code: "23505", message: "duplicate key" } },
    { data: null, error: { code: "XX000", message: "database unavailable" } }
  ];
  supabaseConfig.getSupabase = () => ({
    from(table) {
      assert.equal(table, "message_events");
      return {
        insert(payload) {
          inserts.push(payload);
          return {
            select(columns) {
              assert.equal(columns, "id");
              return {
                single: async () => responses.shift()
              };
            }
          };
        }
      };
    }
  });
  const input = {
    tenantId: "tenant_exact",
    lineUserId: "line_user_exact",
    ghlMessageId: "ghl_claim_exact",
    ghlConversationId: "conversation_exact",
    payload: { message: "claim test" },
    requestPayload: { source: "ghl_outbound_provider", deliveryState: "claimed" }
  };

  const claimed = await repository.claimGhlOutboundProviderDelivery(input);
  const duplicate = await repository.claimGhlOutboundProviderDelivery(input);

  assert.deepEqual(claimed, {
    claimed: true,
    eventId: "claim_db_exact",
    externalMessageId: "ghl-provider-delivery:ghl_claim_exact"
  });
  assert.deepEqual(duplicate, {
    claimed: false,
    externalMessageId: "ghl-provider-delivery:ghl_claim_exact"
  });
  await assert.rejects(
    () => repository.claimGhlOutboundProviderDelivery(input),
    /database unavailable/
  );
  assert.equal(inserts[0].status, "received");
  assert.equal(inserts[0].tenant_id, "tenant_exact");
  assert.equal(inserts[0].external_message_id, "ghl-provider-delivery:ghl_claim_exact");
  assert.equal(inserts[0].request_payload.deliveryState, "claimed");
});

test("repository finalization updates the exact claimed message event row", async () => {
  const updates = [];
  const filters = [];
  supabaseConfig.getSupabase = () => ({
    from(table) {
      assert.equal(table, "message_events");
      const chain = {
        update(payload) {
          updates.push(payload);
          return chain;
        },
        eq(column, value) {
          filters.push([column, value]);
          return chain;
        },
        select(columns) {
          assert.equal(columns, "id");
          return chain;
        },
        maybeSingle: async () => ({ data: { id: "claim_db_exact" }, error: null })
      };
      return chain;
    }
  });

  await repository.finalizeGhlOutboundProviderDelivery({
    eventId: "claim_db_exact",
    tenantId: "tenant_exact",
    status: "sent",
    lineUserId: "line_user_exact",
    ghlMessageId: "ghl_claim_exact",
    ghlConversationId: "conversation_exact",
    requestPayload: { source: "ghl_outbound_provider", deliveryState: "sent" }
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "sent");
  assert.equal(updates[0].request_payload.deliveryState, "sent");
  assert.deepEqual(filters, [
    ["id", "claim_db_exact"],
    ["tenant_id", "tenant_exact"],
    ["provider", "ghl"],
    ["direction", "outbound"],
    ["ghl_message_id", "ghl_claim_exact"],
    ["status", "received"]
  ]);
});

test("repository provider-dispatch lookup requires exact tenant, message, mapping, and dispatch source", async () => {
  const filters = [];
  const containsFilters = [];
  const record = {
    id: "dispatch_event_exact",
    tenant_id: "tenant_exact",
    line_user_id: "line_user_exact",
    ghl_message_id: "ghl_message_exact",
    ghl_conversation_id: "conversation_exact",
    request_payload: {
      source: "ghl_workflow_provider_dispatch",
      contactId: "contact_exact"
    },
    created_at: "2026-01-01T00:00:00.000Z"
  };
  supabaseConfig.getSupabase = () => ({
    from(table) {
      assert.equal(table, "message_events");
      const chain = {
        select() {
          return chain;
        },
        eq(column, value) {
          filters.push([column, value]);
          return chain;
        },
        contains(column, value) {
          containsFilters.push([column, value]);
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        maybeSingle: async () => ({ data: record, error: null })
      };
      return chain;
    }
  });

  const result = await repository.findWorkflowProviderDispatchMessageEvent({
    tenantId: "tenant_exact",
    ghlMessageId: "ghl_message_exact",
    lineUserId: "line_user_exact",
    ghlContactId: "contact_exact",
    ghlConversationId: "conversation_exact"
  });

  assert.equal(result?.id, "dispatch_event_exact");
  assert.deepEqual(filters, [
    ["tenant_id", "tenant_exact"],
    ["provider", "ghl"],
    ["direction", "outbound"],
    ["status", "success"],
    ["ghl_message_id", "ghl_message_exact"],
    ["line_user_id", "line_user_exact"],
    ["ghl_conversation_id", "conversation_exact"]
  ]);
  assert.deepEqual(containsFilters, [[
    "request_payload",
    { source: "ghl_workflow_provider_dispatch", contactId: "contact_exact" }
  ]]);
  assert.notEqual(
    containsFilters[0][1].source,
    "ghl_workflow_outbound_mirror"
  );
});

test("repository rejects an ambiguous contact fallback within the exact location tenants", async () => {
  const filters = [];
  const matches = [
    { id: "profile_a", tenant_id: "tenant_exact", ghl_contact_id: "contact_exact" },
    { id: "profile_b", tenant_id: "tenant_exact", ghl_contact_id: "contact_exact" }
  ];
  supabaseConfig.getSupabase = () => ({
    from(table) {
      assert.equal(table, "line_profiles");
      const chain = {
        select() {
          return chain;
        },
        in(column, values) {
          filters.push([column, values]);
          return chain;
        },
        order() {
          return chain;
        },
        eq(column, value) {
          filters.push([column, value]);
          return chain;
        },
        limit: async (count) => {
          assert.equal(count, 2);
          return { data: matches, error: null };
        }
      };
      return chain;
    }
  });

  const mapping = await repository.findLineProfileByGhlIdsForTenantIds(
    ["tenant_exact"],
    { contactId: "contact_exact" }
  );

  assert.equal(mapping, null);
  assert.deepEqual(filters, [
    ["tenant_id", ["tenant_exact"]],
    ["ghl_contact_id", "contact_exact"]
  ]);
});

function setupProviderCallbackHarness() {
  const calls = {
    tenantLocations: [],
    mirrorGuards: [],
    profileLookups: [],
    channelSelections: [],
    claimAttempts: [],
    finalizations: [],
    linePushes: [],
    statusUpdates: []
  };
  const messageEvents = [];
  const claims = new Map();
  let channelConnected = true;
  let claimError = null;
  let pushError = null;

  repository.getTenantIdsByLocationId = async (locationId) => {
    calls.tenantLocations.push(locationId);
    return ["tenant_exact"];
  };
  repository.findWorkflowOutboundMirrorMessageEventForTenantIds = async (input) => {
    calls.mirrorGuards.push(input);
    return null;
  };
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds, ids) => {
    calls.profileLookups.push({ tenantIds, ids });
    return {
      id: "profile_exact",
      tenant_id: "tenant_exact",
      line_user_id: "line_user_exact",
      line_channel_id: "line_channel_exact",
      ghl_contact_id: "contact_exact",
      ghl_conversation_id: "conversation_exact"
    };
  };
  repository.getTenantById = async () => ({
    id: "tenant_exact",
    location_id: "location_exact",
    ghl_provider_id: "provider_exact"
  });
  repository.claimGhlOutboundProviderDelivery = async (input) => {
    calls.claimAttempts.push(input);

    if (claimError) {
      throw claimError;
    }

    const externalMessageId = `ghl-provider-delivery:${input.ghlMessageId}`;
    const key = `${input.tenantId}:${externalMessageId}`;

    if (claims.has(key)) {
      return { claimed: false, externalMessageId };
    }

    const eventId = `claim_${claims.size + 1}`;
    claims.set(key, {
      eventId,
      status: "received",
      input
    });

    return { claimed: true, eventId, externalMessageId };
  };
  repository.finalizeGhlOutboundProviderDelivery = async (input) => {
    calls.finalizations.push(input);
    const claim = [...claims.values()].find((candidate) => candidate.eventId === input.eventId);

    if (!claim) {
      throw new Error("claim not found");
    }

    claim.status = input.status;
    claim.finalization = input;
  };
  repository.saveMessageEvent = async (input) => {
    messageEvents.push(input);
  };
  lineOutboundChannelService.resolveLineChannelForOutbound = async (tenantId, mapping) => {
    calls.channelSelections.push({ tenantId, mapping });

    if (!channelConnected) {
      throw new lineOutboundChannelService.LineChannelNotConnectedError({
        lineChannelId: "line_channel_exact",
        channelTokenSource: "profile_channel"
      });
    }

    return {
      channelAccessToken: "line_token_exact",
      lineChannelId: "line_channel_exact",
      channelTokenSource: "profile_channel"
    };
  };
  lineClient.pushLineMessages = async (lineUserId, messages, channelAccessToken) => {
    calls.linePushes.push({ lineUserId, messages, channelAccessToken });
    await new Promise((resolve) => setImmediate(resolve));

    if (pushError) {
      throw pushError;
    }

    return { messageId: "line_message_exact", statusCode: 200 };
  };
  workflowOutboundClient.updateWorkflowProviderMessageStatus = async (input) => {
    calls.statusUpdates.push(input);
    return { ok: true, authMode: "oauth", statusCode: 200 };
  };

  return {
    calls,
    messageEvents,
    claims,
    controls: {
      setChannelConnected(value) {
        channelConnected = value;
      },
      setClaimError(error) {
        claimError = error;
      },
      setPushError(error) {
        pushError = error;
      }
    }
  };
}

function providerCallbackPayload(messageId = "ghl_message_exact") {
  return {
    locationId: "location_exact",
    contactId: "contact_exact",
    conversationId: "conversation_exact",
    messageId,
    conversationProviderId: "provider_exact",
    message: "provider callback reply"
  };
}

test("provider callback sends once to the exact LINE user with the exact tenant channel token", async () => {
  const { calls, claims } = setupProviderCallbackHarness();

  const result = await ghlSyncService.processGhlOutboundWebhook(providerCallbackPayload());

  assert.deepEqual(result, { status: "processed" });
  assert.deepEqual(calls.tenantLocations, ["location_exact"]);
  assert.deepEqual(calls.profileLookups[0].tenantIds, ["tenant_exact"]);
  assert.deepEqual(calls.profileLookups[0].ids, {
    contactId: "contact_exact",
    conversationId: "conversation_exact"
  });
  assert.equal(calls.claimAttempts.length, 1);
  assert.equal(calls.claimAttempts[0].tenantId, "tenant_exact");
  assert.equal(calls.claimAttempts[0].ghlMessageId, "ghl_message_exact");
  assert.equal(calls.claimAttempts[0].requestPayload.deliveryState, "claimed");
  assert.deepEqual(calls.linePushes, [{
    lineUserId: "line_user_exact",
    messages: [{ type: "text", text: "provider callback reply" }],
    channelAccessToken: "line_token_exact"
  }]);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.finalizations[0].status, "sent");
  assert.equal(calls.finalizations[0].requestPayload.deliveryState, "sent");
  assert.equal([...claims.values()][0].status, "sent");
  assert.equal(calls.statusUpdates.length, 1);
  assert.equal(calls.statusUpdates[0].status, "delivered");
});

test("two concurrent provider callbacks atomically claim one physical LINE delivery", async () => {
  const { calls, claims } = setupProviderCallbackHarness();
  const payload = providerCallbackPayload("ghl_message_concurrent");

  const results = await Promise.all([
    ghlSyncService.processGhlOutboundWebhook(payload),
    ghlSyncService.processGhlOutboundWebhook(payload)
  ]);

  assert.equal(results.filter((result) => result.status === "processed").length, 1);
  assert.equal(results.filter((result) => result.reason === "Already claimed").length, 1);
  assert.equal(calls.linePushes.length, 1);
  assert.equal(calls.claimAttempts.length, 2);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.finalizations[0].status, "sent");
  assert.equal(claims.size, 1);
  assert.equal([...claims.values()][0].status, "sent");
});

test("three repeated provider callbacks keep the physical LINE push total at one", async () => {
  const { calls, claims } = setupProviderCallbackHarness();
  const payload = providerCallbackPayload("ghl_message_three_retries");

  const first = await ghlSyncService.processGhlOutboundWebhook(payload);
  const second = await ghlSyncService.processGhlOutboundWebhook(payload);
  const third = await ghlSyncService.processGhlOutboundWebhook(payload);

  assert.deepEqual(first, { status: "processed" });
  assert.deepEqual(second, { status: "skipped", reason: "Already claimed" });
  assert.deepEqual(third, { status: "skipped", reason: "Already claimed" });
  assert.equal(calls.linePushes.length, 1);
  assert.equal(calls.claimAttempts.length, 3);
  assert.equal(calls.finalizations.length, 1);
  assert.equal([...claims.values()][0].status, "sent");
});

test("disconnected channel finalizes one claim as failed and skips a later callback", async () => {
  const { calls, claims, controls, messageEvents } = setupProviderCallbackHarness();
  const payload = providerCallbackPayload("ghl_disconnected_message");
  controls.setChannelConnected(false);

  const first = await ghlSyncService.processGhlOutboundWebhook(payload);

  assert.deepEqual(first, { status: "processed", reason: "LINE channel resolution failed" });
  assert.equal(calls.claimAttempts.length, 1);
  assert.equal(calls.linePushes.length, 0);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.finalizations[0].status, "failed");
  assert.equal(calls.statusUpdates.length, 1);
  assert.equal(calls.statusUpdates[0].status, "failed");
  assert.equal(messageEvents.length, 0);
  assert.equal(claims.size, 1);

  controls.setChannelConnected(true);
  const retry = await ghlSyncService.processGhlOutboundWebhook(payload);

  assert.deepEqual(retry, { status: "skipped", reason: "Already claimed" });
  assert.equal(calls.claimAttempts.length, 2);
  assert.equal(calls.linePushes.length, 0);
  assert.equal([...claims.values()][0].status, "failed");
});

test("claim database failure fails closed without a LINE push", async () => {
  const { calls, controls } = setupProviderCallbackHarness();
  controls.setClaimError(new Error("Supabase claim failed"));

  await assert.rejects(
    () => ghlSyncService.processGhlOutboundWebhook(providerCallbackPayload("ghl_claim_failure")),
    (error) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, "Unable to claim outbound provider delivery");
      return true;
    }
  );

  assert.equal(calls.claimAttempts.length, 1);
  assert.equal(calls.linePushes.length, 0);
  assert.equal(calls.finalizations.length, 0);
});

test("LINE push failure finalizes the claim as failed and later callbacks do not retry", async () => {
  const { calls, claims, controls } = setupProviderCallbackHarness();
  const payload = providerCallbackPayload("ghl_push_failure");
  controls.setPushError(new Error("Ambiguous LINE API failure"));

  await assert.rejects(
    () => ghlSyncService.processGhlOutboundWebhook(payload),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.message, "LINE delivery failed after outbound provider claim");
      return true;
    }
  );

  controls.setPushError(null);
  const retry = await ghlSyncService.processGhlOutboundWebhook(payload);

  assert.deepEqual(retry, { status: "skipped", reason: "Already claimed" });
  assert.equal(calls.linePushes.length, 1);
  assert.equal(calls.finalizations.length, 1);
  assert.equal(calls.finalizations[0].status, "failed");
  assert.equal([...claims.values()][0].status, "failed");
});

test("stale conversation mapping falls back only to one exact-location contact profile", async () => {
  const { calls } = setupProviderCallbackHarness();
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds, ids) => {
    calls.profileLookups.push({ tenantIds, ids });

    if (ids.conversationId) {
      return null;
    }

    return {
      id: "profile_older",
      tenant_id: "tenant_exact",
      line_user_id: "line_user_exact",
      line_channel_id: "line_channel_exact",
      ghl_contact_id: "contact_exact",
      ghl_conversation_id: null
    };
  };

  const result = await ghlSyncService.processGhlOutboundWebhook(
    providerCallbackPayload("ghl_stale_conversation")
  );

  assert.deepEqual(result, { status: "processed" });
  assert.deepEqual(calls.profileLookups, [
    {
      tenantIds: ["tenant_exact"],
      ids: { contactId: "contact_exact", conversationId: "conversation_exact" }
    },
    {
      tenantIds: ["tenant_exact"],
      ids: { contactId: "contact_exact" }
    }
  ]);
  assert.equal(calls.claimAttempts.length, 1);
  assert.equal(calls.linePushes.length, 1);
});

test("manual HighLevel Conversations outbound messages remain compatible and send exactly once", async () => {
  const { calls } = setupProviderCallbackHarness();

  const result = await ghlSyncService.processGhlOutboundWebhook(
    providerCallbackPayload("ghl_manual_message")
  );

  assert.deepEqual(result, { status: "processed" });
  assert.equal(calls.linePushes.length, 1);
  assert.equal(calls.linePushes[0].lineUserId, "line_user_exact");
  assert.equal(calls.linePushes[0].channelAccessToken, "line_token_exact");
});
