const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const pino = require("pino");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";

const config = require("../dist/config/env");
const loggerModule = require("../dist/config/logger");
const ghlOAuthService = require("../dist/services/ghlOAuthService");
const repository = require("../dist/services/repository");
const workflowOutboundClient = require("../dist/integrations/ghlWorkflowOutboundMirrorClient");
const lineClient = require("../dist/integrations/lineClient");
const lineOutboundChannelService = require("../dist/services/lineOutboundChannelService");
const ghlWorkflowActionService = require("../dist/services/ghlWorkflowActionService");
const { normalizeWorkflowRequestId } = require("../dist/routes/ghlWebhook");

const patchedExports = [
  [repository, "getTenantIdsByLocationId"],
  [repository, "findLineProfileByGhlIdsForTenantIds"],
  [repository, "getTenantById"],
  [repository, "saveMessageEvent"],
  [workflowOutboundClient, "mirrorWorkflowOutboundMessageToGhl"],
  [ghlOAuthService, "getGhlAuthContext"],
  [ghlOAuthService, "forceRefreshGhlAuthContext"],
  [lineOutboundChannelService, "resolveLineChannelForOutbound"],
  [lineClient, "pushLineTextMessage"],
  [lineClient, "pushLineImageMessage"],
  [loggerModule.logger, "info"],
  [loggerModule.logger, "warn"],
  [loggerModule.logger, "error"]
];
const originals = patchedExports.map(([module, key]) => [module, key, module[key]]);
const originalFetch = global.fetch;
const originalDeliveryMode = config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE;
const originalMirrorEnabled = config.env.GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED;

afterEach(() => {
  for (const [module, key, value] of originals) {
    module[key] = value;
  }

  global.fetch = originalFetch;
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = originalDeliveryMode;
  config.env.GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED = originalMirrorEnabled;
});

function textPayload(data = { message: "one workflow reply" }) {
  return {
    data,
    extras: {
      locationId: "location_exact",
      contactId: "contact_exact",
      workflowId: "workflow_exact"
    },
    meta: { key: "send-line", version: "1" }
  };
}

function imagePayload(overrides = {}) {
  return {
    messageType: "image",
    originalImageUrl: "https://media.example.com/original.png?signature=private-value",
    previewImageUrl: "https://media.example.com/preview.png?signature=other-private-value",
    locationId: "location_exact",
    contactId: "contact_exact",
    workflowId: "workflow_exact",
    ...overrides
  };
}

function setupHarness() {
  const calls = {
    tenantLocations: [],
    profileLookups: [],
    tenantLookups: [],
    channelSelections: [],
    providerDispatches: [],
    textPushes: [],
    imagePushes: [],
    messageEvents: [],
    logs: []
  };

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
    calls.messageEvents.push(input);
  };
  lineOutboundChannelService.resolveLineChannelForOutbound = async (tenantId, mapping) => {
    calls.channelSelections.push({ tenantId, mapping });
    return {
      channelAccessToken: "tenant_channel_token",
      lineChannelId: "line_channel_exact",
      channelTokenSource: "profile_channel"
    };
  };
  workflowOutboundClient.mirrorWorkflowOutboundMessageToGhl = async (input) => {
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
        status: "delivered",
        conversationProviderId: input.conversationProviderId
      },
      ghlMessageId: "ghl_message_exact",
      ghlConversationId: "conversation_exact"
    };
  };
  lineClient.pushLineTextMessage = async (...args) => {
    calls.textPushes.push(args);
    return { messageId: "line_text_exact", statusCode: 200, lineRequestId: "line_request_text" };
  };
  lineClient.pushLineImageMessage = async (...args) => {
    calls.imagePushes.push(args);
    return { messageId: "line_image_exact", statusCode: 200, lineRequestId: "line_request_image" };
  };
  for (const level of ["info", "warn", "error"]) {
    loggerModule.logger[level] = (...args) => calls.logs.push({ level, args });
  }

  return calls;
}

function assertNoDeliveryOrRepositoryCalls(calls) {
  assert.equal(calls.tenantLocations.length, 0);
  assert.equal(calls.profileLookups.length, 0);
  assert.equal(calls.tenantLookups.length, 0);
  assert.equal(calls.channelSelections.length, 0);
  assert.equal(calls.providerDispatches.length, 0);
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.imagePushes.length, 0);
  assert.equal(calls.messageEvents.length, 0);
}

async function assertInvalidImage(overrides, expectedError) {
  const calls = setupHarness();
  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(imagePayload(overrides));

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, expectedError);
  assertNoDeliveryOrRepositoryCalls(calls);
}

test("legacy text request without messageType retains the provider-first text flow", async () => {
  const calls = setupHarness();
  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(textPayload());

  assert.deepEqual(result.body, {
    ok: true,
    status: "sent",
    provider: "line",
    lineMessageId: null,
    error: ""
  });
  assert.equal(calls.providerDispatches.length, 1);
  assert.equal(calls.providerDispatches[0].message, "one workflow reply");
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.imagePushes.length, 0);
  assert.equal(calls.messageEvents[0].requestPayload.source, "ghl_workflow_provider_dispatch");
});

test("explicit text request retains the exact existing outbound message", async () => {
  const calls = setupHarness();
  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    textPayload({ messageType: "text", message: "explicit workflow reply" })
  );

  assert.equal(result.body.ok, true);
  assert.equal(calls.providerDispatches.length, 1);
  assert.deepEqual(calls.providerDispatches[0], {
    locationId: "location_exact",
    contactId: "contact_exact",
    message: "explicit workflow reply",
    conversationProviderId: "provider_exact",
    workflowId: "workflow_exact",
    lineMessageId: null,
    existingGhlConversationId: "conversation_exact"
  });
  assert.equal(calls.imagePushes.length, 0);
});

test("provider-first text structured logs contain metadata but no message or customer identifiers", async () => {
  const calls = setupHarness();
  const sensitiveText = "private outbound customer message";
  const payload = textPayload({ messageType: "text", message: sensitiveText });

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    payload,
    { requestId: "safe_request_correlation" }
  );
  const serializedLogs = JSON.stringify(calls.logs);

  assert.equal(result.body.status, "sent");
  assert.doesNotMatch(
    serializedLogs,
    /private outbound customer message|location_exact|contact_exact|tenant_exact|line_user_exact|line_channel_exact|conversation_exact|workflow_exact/
  );
  assert.equal(
    calls.logs.some(({ args }) =>
      args[0]?.selectedMessageType === "text" &&
      args[0]?.messagePresent === true &&
      args[0]?.messageLength === sensitiveText.length &&
      args[0]?.providerDispatchStatus === "success"
    ),
    true
  );
});

test("HighLevel mirror client logs no request text, OAuth token, or complete identifiers", async () => {
  const calls = setupHarness();
  const originalMirror = originals.find(
    ([module, key]) => module === workflowOutboundClient && key === "mirrorWorkflowOutboundMessageToGhl"
  )[2];
  ghlOAuthService.getGhlAuthContext = async () => ({
    mode: "oauth",
    accessToken: "oauth_token_sensitive",
    locationId: "location_sensitive"
  });
  global.fetch = async () => new Response(JSON.stringify({
    messageId: "ghl_message_sensitive",
    conversationId: "conversation_sensitive",
    message: "private provider response content"
  }), {
    status: 201,
    headers: { "Content-Type": "application/json" }
  });

  await originalMirror({
    requestId: "safe_request_correlation",
    locationId: "location_sensitive",
    contactId: "contact_sensitive",
    message: "private outbound customer message",
    conversationProviderId: "provider_sensitive",
    workflowId: "workflow_sensitive",
    lineMessageId: "line_message_sensitive",
    existingGhlConversationId: "conversation_existing_sensitive"
  });
  const serializedLogs = JSON.stringify(calls.logs);

  assert.doesNotMatch(
    serializedLogs,
    /oauth_token_sensitive|private outbound customer message|private provider response content|location_sensitive|contact_sensitive|provider_sensitive|workflow_sensitive|line_message_sensitive|conversation_sensitive|conversation_existing_sensitive|ghl_message_sensitive/
  );
  assert.equal(
    calls.logs.some(({ args }) =>
      args[0]?.messagePresent === true &&
      args[0]?.messageLength === "private outbound customer message".length &&
      args[0]?.providerDispatchStatus === "success" &&
      args[0]?.ghlMessageIdPresent === true
    ),
    true
  );
});

test("workflow route preserves string and numeric request correlation IDs safely", () => {
  assert.equal(normalizeWorkflowRequestId("request-string-exact"), "request-string-exact");
  assert.equal(normalizeWorkflowRequestId(42), "42");
  assert.equal(normalizeWorkflowRequestId(undefined), undefined);
  assert.equal(normalizeWorkflowRequestId(null), undefined);
  assert.equal(normalizeWorkflowRequestId(true), undefined);
  assert.equal(normalizeWorkflowRequestId({ id: "unsupported" }), undefined);
  assert.equal(normalizeWorkflowRequestId(["unsupported"]), undefined);
});

test("logger redaction safety net censors project headers, nested bodies, identifiers, and messages", () => {
  let output = "";
  const privacyLogger = pino({
    redact: {
      paths: [...loggerModule.logRedactionPaths],
      censor: "[redacted]"
    }
  }, {
    write(chunk) {
      output += chunk;
    }
  });

  privacyLogger.info({
    requestId: normalizeWorkflowRequestId(42),
    req: {
      headers: {
        authorization: "Bearer request-authorization-sensitive",
        "x-wincrm-webhook-secret": "request-workflow-secret-sensitive",
        "x-webhook-secret": "request-legacy-webhook-secret-sensitive",
        "x-provider-secret": "request-provider-secret-sensitive",
        "x-ghl-secret": "request-ghl-secret-sensitive",
        "x-line-signature": "request-line-signature-sensitive",
        "x-ghl-signature": "request-ghl-signature-sensitive",
        "x-wh-signature": "request-wh-signature-sensitive"
      }
    },
    response: {
      headers: {
        "set-cookie": "response-cookie-sensitive",
        "proxy-authorization": "response-proxy-authorization-sensitive",
        "x-access-token": "response-access-token-sensitive",
        "x-refresh-token": "response-refresh-token-sensitive"
      }
    },
    contactId: "contact_sensitive",
    conversationId: "conversation_sensitive",
    tenantId: "tenant_sensitive",
    lineUserId: "line_user_sensitive",
    lineChannelId: "line_channel_sensitive",
    ghlMessageId: "ghl_message_sensitive",
    requestBody: { message: "private outbound customer message" },
    responseBody: { message: "private provider response content" },
    payload: {
      requestBody: { message: "private nested request content" },
      responseBody: { text: "private nested response content" }
    },
    originalImageUrl: "https://media.example.com/private/original.png?signature=private-value",
    errorMessage: "Provider rejected https://media.example.com/private/error.png?signature=error-private-value",
    providerDispatchStatus: "success",
    statusCode: 201,
    locationIdPresent: true
  });

  assert.doesNotMatch(
    output,
    /request-authorization-sensitive|request-workflow-secret-sensitive|request-legacy-webhook-secret-sensitive|request-provider-secret-sensitive|request-ghl-secret-sensitive|request-line-signature-sensitive|request-wh-signature-sensitive|response-cookie-sensitive|response-proxy-authorization-sensitive|response-access-token-sensitive|response-refresh-token-sensitive|contact_sensitive|conversation_sensitive|tenant_sensitive|line_user_sensitive|line_channel_sensitive|ghl_message_sensitive|private outbound customer message|private provider response content|private nested request content|private nested response content|media\.example\.com|original\.png|error\.png|private-value/
  );
  assert.match(output, /\[redacted\]/);
  assert.match(output, /providerDispatchStatus/);
  assert.match(output, /success/);
  assert.match(output, /"requestId":"42"/);
  assert.match(output, /"statusCode":201/);
  assert.match(output, /"locationIdPresent":true/);
});

test("the existing LINE text client request body remains unchanged", async () => {
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ sentMessages: [{ id: "line_text_exact" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await originals.find(([module, key]) => module === lineClient && key === "pushLineTextMessage")[2](
    "line_user_exact",
    "unchanged text",
    "tenant_channel_token"
  );

  assert.equal(result.messageId, "line_text_exact");
  assert.equal(result.statusCode, 200);
  assert.equal(request.url, "https://api.line.me/v2/bot/message/push");
  assert.equal(request.init.headers["X-Line-Retry-Key"], undefined);
  assert.deepEqual(JSON.parse(request.init.body), {
    to: "line_user_exact",
    messages: [{ type: "text", text: "unchanged text" }]
  });
});

test("valid top-level image request selects the tenant channel and sends one exact LINE image", async () => {
  const calls = setupHarness();
  const payload = imagePayload();
  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(payload, { requestId: "request_exact" });

  assert.deepEqual(result.body, {
    ok: true,
    status: "sent",
    provider: "line",
    lineMessageId: "line_image_exact",
    error: ""
  });
  assert.deepEqual(calls.tenantLocations, ["location_exact"]);
  assert.deepEqual(calls.profileLookups, [{
    tenantIds: ["tenant_exact"],
    ids: { contactId: "contact_exact" }
  }]);
  assert.equal(calls.channelSelections.length, 1);
  assert.equal(calls.channelSelections[0].tenantId, "tenant_exact");
  assert.equal(calls.channelSelections[0].mapping.line_channel_id, "line_channel_exact");
  assert.deepEqual(calls.imagePushes, [[
    "line_user_exact",
    payload.originalImageUrl,
    payload.previewImageUrl,
    "tenant_channel_token"
  ]]);
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.providerDispatches.length, 0);
  assert.equal(calls.tenantLookups.length, 0);
  assert.equal(calls.messageEvents.length, 1);
  assert.equal(calls.messageEvents[0].externalMessageId, "line:line_image_exact");
  assert.equal(calls.messageEvents[0].requestPayload.lineHttpStatusCode, 200);
  assert.equal(calls.messageEvents[0].requestPayload.mirrorResultStatus, "unsupported");
  assert.equal(
    calls.logs.some(({ args }) => args[0]?.lineResultStatus === "sent" && args[0]?.lineHttpStatusCode === 200),
    true
  );
});

test("the LINE image client emits the official image message shape", async () => {
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ sentMessages: [{ id: "line_image_exact" }] }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Line-Request-Id": "line_request_exact"
      }
    });
  };
  const originalImagePush = originals.find(
    ([module, key]) => module === lineClient && key === "pushLineImageMessage"
  )[2];

  const result = await originalImagePush(
    "line_user_exact",
    "https://media.example.com/original.png",
    "https://media.example.com/preview.png",
    "tenant_channel_token"
  );

  assert.equal(result.messageId, "line_image_exact");
  assert.equal(result.statusCode, 200);
  assert.equal(result.lineRequestId, "line_request_exact");
  assert.equal(request.init.headers["X-Line-Retry-Key"], undefined);
  assert.deepEqual(JSON.parse(request.init.body), {
    to: "line_user_exact",
    messages: [{
      type: "image",
      originalContentUrl: "https://media.example.com/original.png",
      previewImageUrl: "https://media.example.com/preview.png"
    }]
  });
});

test("LINE image client includes a valid retry key only when supplied", async () => {
  const retryKey = "7ac0e4c4-8f04-4c19-b33a-7b3b9b425df0";
  let request;
  global.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ sentMessages: [{ id: "line_retry_exact" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const originalImagePush = originals.find(
    ([module, key]) => module === lineClient && key === "pushLineImageMessage"
  )[2];

  await originalImagePush(
    "line_user_exact",
    "https://media.example.com/original.png",
    "https://media.example.com/preview.png",
    "tenant_channel_token",
    retryKey
  );

  assert.equal(request.init.headers["X-Line-Retry-Key"], retryKey);
});

test("LINE image client rejects a non-UUID retry key before making a request", async () => {
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    throw new Error("fetch must not run");
  };
  const originalImagePush = originals.find(
    ([module, key]) => module === lineClient && key === "pushLineImageMessage"
  )[2];

  await assert.rejects(
    () => originalImagePush(
      "line_user_exact",
      "https://media.example.com/original.png",
      "https://media.example.com/preview.png",
      "tenant_channel_token",
      "not-a-uuid"
    ),
    (error) => error instanceof lineClient.LineApiError && error.category === "invalid_retry_key"
  );
  assert.equal(fetchCount, 0);
});

test("LINE 409 accepted retry is treated as an already accepted success without a second push", async () => {
  const retryKey = "7ac0e4c4-8f04-4c19-b33a-7b3b9b425df0";
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({
      message: "already accepted",
      sentMessages: [{ id: "line_original_message", quoteToken: "quote_token_exact" }]
    }), {
      status: 409,
      headers: {
        "Content-Type": "application/json",
        "X-Line-Request-Id": "line_conflict_request",
        "X-Line-Accepted-Request-Id": "line_original_request"
      }
    });
  };
  const originalImagePush = originals.find(
    ([module, key]) => module === lineClient && key === "pushLineImageMessage"
  )[2];

  const result = await originalImagePush(
    "line_user_exact",
    "https://media.example.com/original.png",
    "https://media.example.com/preview.png",
    "tenant_channel_token",
    retryKey
  );

  assert.equal(fetchCount, 1);
  assert.equal(result.statusCode, 409);
  assert.equal(result.messageId, "line_original_message");
  assert.equal(result.lineRequestId, "line_conflict_request");
  assert.equal(result.acceptedRequestId, "line_original_request");
  assert.equal(result.acceptedByRetryKey, true);
});

test("LINE HTTP failures expose only typed safe status metadata", async () => {
  global.fetch = async () => new Response(
    JSON.stringify({ message: "Rejected https://media.example.com/private.png?signature=private-value" }),
    {
      status: 422,
      headers: {
        "Content-Type": "application/json",
        "X-Line-Request-Id": "line_failure_request"
      }
    }
  );
  const originalImagePush = originals.find(
    ([module, key]) => module === lineClient && key === "pushLineImageMessage"
  )[2];

  await assert.rejects(
    () => originalImagePush(
      "line_user_exact",
      "https://media.example.com/original.png",
      "https://media.example.com/preview.png",
      "tenant_channel_token"
    ),
    (error) => {
      assert.equal(error instanceof lineClient.LineApiError, true);
      assert.equal(error.statusCode, 422);
      assert.equal(error.lineRequestId, "line_failure_request");
      assert.equal(error.category, "invalid_request");
      assert.doesNotMatch(error.message, /media\.example\.com|signature|private-value/);
      return true;
    }
  );
});

test("getLineProfile still maps a typed LINE 404 response to null", async () => {
  global.fetch = async () => new Response(
    JSON.stringify({ message: "profile not found" }),
    {
      status: 404,
      headers: { "X-Line-Request-Id": "line_profile_missing" }
    }
  );

  const result = await lineClient.getLineProfile("line_user_missing", "tenant_channel_token");

  assert.equal(result, null);
});

test("missing originalImageUrl is rejected before any side effect", async () => {
  await assertInvalidImage({ originalImageUrl: undefined }, /originalImageUrl is required/);
});

test("missing previewImageUrl is rejected before any side effect", async () => {
  await assertInvalidImage({ previewImageUrl: undefined }, /previewImageUrl is required/);
});

test("HTTP originalImageUrl is rejected", async () => {
  await assertInvalidImage({ originalImageUrl: "http://media.example.com/original.png" }, /must use HTTPS/);
});

test("HTTP previewImageUrl is rejected", async () => {
  await assertInvalidImage({ previewImageUrl: "http://media.example.com/preview.png" }, /must use HTTPS/);
});

test("invalid image URL syntax is rejected", async () => {
  await assertInvalidImage({ originalImageUrl: "not-a-url" }, /valid absolute URL/);
});

test("localhost image URL is rejected", async () => {
  await assertInvalidImage({ originalImageUrl: "https://localhost/original.png" }, /must not use localhost/);
});

test("private-network literal image URL is rejected", async () => {
  await assertInvalidImage(
    { previewImageUrl: "https://192.168.10.2/preview.png" },
    /loopback or private-network IP address/
  );
});

test("unencoded space in originalImageUrl is rejected before any side effect", async () => {
  await assertInvalidImage(
    { originalImageUrl: "https://media.example.com/unencoded space/original.png" },
    /must be percent-encoded and must not contain whitespace/
  );
});

test("control character in previewImageUrl is rejected before any side effect", async () => {
  await assertInvalidImage(
    { previewImageUrl: "https://media.example.com/preview\nimage.png" },
    /must be percent-encoded and must not contain whitespace/
  );
});

test("percent-encoded and signed image URLs remain accepted and unchanged", async () => {
  const calls = setupHarness();
  const payload = imagePayload({
    originalImageUrl: "https://media.example.com/folder%20name/original.png?signature=private-value",
    previewImageUrl: "https://media.example.com/folder%20name/preview.png?signature=other-private-value"
  });

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(payload);

  assert.equal(result.body.status, "sent");
  assert.equal(calls.imagePushes.length, 1);
  assert.equal(calls.imagePushes[0][1], payload.originalImageUrl);
  assert.equal(calls.imagePushes[0][2], payload.previewImageUrl);
});

test("image URL longer than 2,000 characters is rejected", async () => {
  await assertInvalidImage(
    { originalImageUrl: `https://media.example.com/${"a".repeat(2_001)}` },
    /must be 2000 characters or fewer/
  );
});

test("image URL containing embedded credentials is rejected", async () => {
  await assertInvalidImage(
    { previewImageUrl: "https://username:password@media.example.com/preview.png" },
    /must not contain embedded credentials/
  );
});

test("unsupported messageType is rejected without reflecting its raw value", async () => {
  const calls = setupHarness();
  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine({
    ...imagePayload(),
    messageType: "unsupported-private-value"
  });

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error, "Unsupported messageType. Supported values are text and image");
  assert.doesNotMatch(JSON.stringify(result), /unsupported-private-value/);
  assertNoDeliveryOrRepositoryCalls(calls);
});

test("image path never invokes Inbox mirroring and cannot duplicate LINE on a mirror failure", async () => {
  config.env.GHL_WORKFLOW_OUTBOUND_MIRROR_ENABLED = true;
  const calls = setupHarness();
  workflowOutboundClient.mirrorWorkflowOutboundMessageToGhl = async () => {
    throw new Error("mirror sentinel must not be called");
  };

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(imagePayload());

  assert.equal(result.body.ok, true);
  assert.equal(calls.imagePushes.length, 1);
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.providerDispatches.length, 0);
});

test("successful LINE image remains sent when audit persistence fails", async () => {
  const calls = setupHarness();
  let auditSaveAttempts = 0;
  repository.saveMessageEvent = async () => {
    auditSaveAttempts += 1;
    throw new Error("audit storage unavailable");
  };

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    imagePayload(),
    { requestId: "request_audit_failure" }
  );
  const auditFailureLogs = calls.logs.filter(({ args }) =>
    args.some((value) => value === "Failed to persist GHL workflow LINE image audit event")
  );

  assert.equal(result.body.status, "sent");
  assert.equal(result.body.ok, true);
  assert.equal(result.body.lineMessageId, "line_image_exact");
  assert.equal(calls.imagePushes.length, 1);
  assert.equal(auditSaveAttempts, 1);
  assert.equal(auditFailureLogs.length, 1);
  assert.equal(auditFailureLogs[0].args[0].auditPersistenceStatus, "failed");
  assert.equal(auditFailureLogs[0].args[0].lineHttpStatusCode, 200);
  assert.doesNotMatch(JSON.stringify(calls.logs), /audit storage unavailable/);
});

test("two image sends from the same workflow use distinct LINE audit external IDs", async () => {
  const calls = setupHarness();
  const messageIds = ["line_image_first", "line_image_second"];
  lineClient.pushLineImageMessage = async (...args) => {
    calls.imagePushes.push(args);
    return {
      messageId: messageIds.shift(),
      statusCode: 200,
      lineRequestId: "line_request_exact"
    };
  };

  const first = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    imagePayload(),
    { requestId: "request_first" }
  );
  const second = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    imagePayload(),
    { requestId: "request_second" }
  );

  assert.equal(first.body.status, "sent");
  assert.equal(second.body.status, "sent");
  assert.equal(calls.imagePushes.length, 2);
  assert.deepEqual(
    calls.messageEvents.map(({ externalMessageId }) => externalMessageId),
    ["line:line_image_first", "line:line_image_second"]
  );
});

test("stored image audit input contains hostnames but no media URLs, paths, or signed values", async () => {
  const calls = setupHarness();
  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    imagePayload(),
    { requestId: "request_storage_exact" }
  );
  const storedEvent = calls.messageEvents[0];
  const stored = JSON.stringify(storedEvent);

  assert.equal(result.body.status, "sent");
  assert.equal(storedEvent.payload.messageType, "image");
  assert.equal(storedEvent.payload.originalImageHostname, "media.example.com");
  assert.equal(storedEvent.payload.previewImageHostname, "media.example.com");
  assert.doesNotMatch(stored, /https:\/\//);
  assert.doesNotMatch(stored, /original\.png|preview\.png/);
  assert.doesNotMatch(stored, /signature|private-value/);
});

test("LINE media rejection retains successful channel diagnostics and safe HTTP metadata", async () => {
  const calls = setupHarness();
  lineClient.pushLineImageMessage = async () => {
    throw new lineClient.LineApiError({
      category: "invalid_request",
      statusCode: 400,
      lineRequestId: "line_media_rejection"
    });
  };

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    imagePayload(),
    { requestId: "request_media_rejection" }
  );
  const storedEvent = calls.messageEvents[0];

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, "failed");
  assert.equal(storedEvent.requestPayload.channelResolutionStatus, "success");
  assert.equal(storedEvent.requestPayload.channelConnected, true);
  assert.equal(storedEvent.requestPayload.lineHttpStatusCode, 400);
  assert.equal(storedEvent.requestPayload.lineRequestId, "line_media_rejection");
  assert.equal(storedEvent.requestPayload.lineErrorCategory, "invalid_request");
  assert.match(storedEvent.externalMessageId, /^workflow-image-attempt:[0-9a-f]{32}$/);
  assert.notEqual(storedEvent.externalMessageId, "workflow:workflow_exact");
});

test("disconnected image channel remains a 409 and performs no LINE request", async () => {
  const calls = setupHarness();
  lineOutboundChannelService.resolveLineChannelForOutbound = async () => {
    throw new lineOutboundChannelService.LineChannelNotConnectedError({
      lineChannelId: "line_channel_exact",
      channelTokenSource: "profile_channel"
    });
  };

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(
    imagePayload(),
    { requestId: "request_disconnected" }
  );
  const storedEvent = calls.messageEvents[0];

  assert.equal(result.httpStatus, 409);
  assert.equal(result.body.status, "failed");
  assert.equal(calls.imagePushes.length, 0);
  assert.equal(storedEvent.requestPayload.channelResolutionStatus, "failed");
  assert.equal(storedEvent.requestPayload.channelConnected, false);
  assert.equal(storedEvent.requestPayload.lineResultStatus, "not_attempted");
});

test("image response and structured logs never contain media URLs or signed values", async () => {
  const calls = setupHarness();
  const payload = imagePayload();
  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(payload, { requestId: "request_exact" });
  const exposed = JSON.stringify({ response: result, logs: calls.logs });
  const serializedLogs = JSON.stringify(calls.logs);

  assert.doesNotMatch(exposed, /media\.example\.com/);
  assert.doesNotMatch(exposed, /original\.png|preview\.png/);
  assert.doesNotMatch(exposed, /private-value/);
  assert.doesNotMatch(
    serializedLogs,
    /location_exact|contact_exact|tenant_exact|line_user_exact|line_channel_exact|conversation_exact|workflow_exact|line_image_exact/
  );
  assert.match(exposed, /request_exact/);
  assert.match(exposed, /mirrorResultStatus/);
});

test("LINE image failures do not expose provider error bodies containing media URLs", async () => {
  const calls = setupHarness();
  lineClient.pushLineImageMessage = async () => {
    throw new Error("LINE rejected https://media.example.com/original.png?signature=private-value");
  };

  const result = await ghlWorkflowActionService.processGhlWorkflowSendLine(imagePayload());
  const exposed = JSON.stringify({ response: result, logs: calls.logs });

  assert.equal(result.body.error, "LINE image send failed");
  assert.doesNotMatch(exposed, /media\.example\.com|original\.png|private-value/);
  assert.equal(calls.messageEvents.length, 1);
  assert.equal(calls.messageEvents[0].status, "failed");
});
