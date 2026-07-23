const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
process.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "direct_legacy";
process.env.GHL_WORKFLOW_PROVIDER_FIRST_V3_TENANT_ALLOWLIST =
  "tenant_phase_2_sensitive,tenant_channel_token_sensitive,tenant_channel_token";

const repository = require("../dist/services/repository");
const config = require("../dist/config/env");
const workflowOutboundClient = require("../dist/integrations/ghlWorkflowOutboundMirrorClient");
const lineClient = require("../dist/integrations/lineClient");
const lineOutboundChannelService = require("../dist/services/lineOutboundChannelService");
const loggerModule = require("../dist/config/logger");
const workflowService = require("../dist/services/ghlWorkflowActionService");
const originalFetch = global.fetch;

const patchedExports = [
  [repository, "getTenantIdsByLocationId"],
  [repository, "findLineProfileByGhlIdsForTenantIds"],
  [repository, "getTenantById"],
  [repository, "saveMessageEvent"],
  [workflowOutboundClient, "mirrorWorkflowOutboundMessageToGhl"],
  [workflowOutboundClient, "createWorkflowProviderMessage"],
  [lineOutboundChannelService, "resolveLineChannelForOutbound"],
  [lineClient, "pushLineMessages"],
  [lineClient, "pushLineImageMessage"],
  [lineClient, "pushLineTextMessage"],
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
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "direct_legacy";
});

function basePayload(overrides = {}) {
  return {
    message: "",
    locationId: "location_phase_2_sensitive",
    contactId: "contact_phase_2_sensitive",
    workflowId: "workflow_phase_2_sensitive",
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
    messageBatches: [],
    imagePushes: [],
    textPushes: [],
    messageEvents: [],
    logs: []
  };

  repository.getTenantIdsByLocationId = async (locationId) => {
    calls.tenantLocations.push(locationId);
    return ["tenant_phase_2_sensitive"];
  };
  repository.findLineProfileByGhlIdsForTenantIds = async (tenantIds, ids) => {
    calls.profileLookups.push({ tenantIds, ids });
    return {
      id: "profile_phase_2_sensitive",
      tenant_id: "tenant_phase_2_sensitive",
      line_user_id: "line_user_phase_2_sensitive",
      line_channel_id: "line_channel_phase_2_sensitive",
      ghl_contact_id: "contact_phase_2_sensitive",
      ghl_conversation_id: "conversation_phase_2_sensitive"
    };
  };
  repository.getTenantById = async (tenantId) => {
    calls.tenantLookups.push(tenantId);
    return {
      id: "tenant_phase_2_sensitive",
      location_id: "location_phase_2_sensitive",
      ghl_provider_id: "provider_phase_2_sensitive"
    };
  };
  repository.saveMessageEvent = async (input) => {
    calls.messageEvents.push(input);
  };
  lineOutboundChannelService.resolveLineChannelForOutbound = async (tenantId, mapping) => {
    calls.channelSelections.push({ tenantId, mapping });
    return {
      channelAccessToken: "tenant_channel_token_sensitive",
      lineChannelId: "line_channel_phase_2_sensitive",
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
      ghlMessageId: "ghl_message_phase_2_sensitive",
      ghlConversationId: "conversation_phase_2_sensitive"
    };
  };
  lineClient.pushLineMessages = async (...args) => {
    calls.messageBatches.push(args);
    const messageIds = args[1].map((_, index) => `line_batch_${calls.messageBatches.length}_${index + 1}`);
    return {
      messageId: messageIds[0],
      messageIds,
      statusCode: 200,
      lineRequestId: `line_request_${calls.messageBatches.length}`
    };
  };
  lineClient.pushLineImageMessage = async (...args) => {
    calls.imagePushes.push(args);
    return { messageId: "line_image_phase_1", statusCode: 200 };
  };
  lineClient.pushLineTextMessage = async (...args) => {
    calls.textPushes.push(args);
    return { messageId: "line_text_phase_1", statusCode: 200 };
  };
  for (const level of ["info", "warn", "error"]) {
    loggerModule.logger[level] = (...args) => calls.logs.push({ level, args });
  }

  return calls;
}

function assertNoSideEffects(calls) {
  assert.equal(calls.tenantLocations.length, 0);
  assert.equal(calls.profileLookups.length, 0);
  assert.equal(calls.tenantLookups.length, 0);
  assert.equal(calls.channelSelections.length, 0);
  assert.equal(calls.providerDispatches.length, 0);
  assert.equal(calls.messageBatches.length, 0);
  assert.equal(calls.imagePushes.length, 0);
  assert.equal(calls.textPushes.length, 0);
  assert.equal(calls.messageEvents.length, 0);
}

function flattenedMessages(calls) {
  return calls.messageBatches.flatMap(([, messages]) => messages);
}

test("empty message and no attachments is rejected", async () => {
  const calls = setupHarness();
  const result = await workflowService.processGhlWorkflowSendLine(basePayload());

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "Message is required");
  assertNoSideEffects(calls);
});

test("text-only request still uses the provider-first path", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  const calls = setupHarness();
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({ message: "phase two text" }));

  assert.equal(result.body.status, "sent");
  assert.equal(calls.providerDispatches.length, 1);
  assert.equal(calls.providerDispatches[0].message, "phase two text");
  assert.equal(calls.messageBatches.length, 0);
});

test("one PNG attachment with an empty message sends one native LINE image", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/image.png?signature=png-private";
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "customer-image.png", size: 123 }]
  }));

  assert.equal(result.body.status, "sent");
  assert.deepEqual(flattenedMessages(calls), [{
    type: "image",
    originalContentUrl: url,
    previewImageUrl: url
  }]);
  assert.equal(calls.providerDispatches.length, 0);
});

test("a PNG exactly at the 1,000,000-byte preview limit remains a native image", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/image-limit.png?signature=limit-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "customer-image-limit.png", size: 1_000_000 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{
    type: "image",
    originalContentUrl: url,
    previewImageUrl: url
  }]);
});

test("a PNG above the preview limit uses a text-link fallback", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/image-large.png?signature=large-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "customer-image-large.png", size: 1_000_001 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `customer-image-large.png\n${url}` }]);
  assert.equal(calls.messageEvents[0].payload.nativeImageCount, 0);
  assert.equal(calls.messageEvents[0].payload.imageLinkCount, 1);
  assert.equal(calls.logs.some(({ args }) => args[0]?.imageLinkCount === 1), true);
});

test("a PNG without a usable size uses a text-link fallback", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/image-unknown-size.png?signature=unknown-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "customer-image-unknown-size.png" }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{
    type: "text",
    text: `customer-image-unknown-size.png\n${url}`
  }]);
});

test("one JPEG attachment is classified case-insensitively as a native image", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/photo?signature=jpeg-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    imageAttachment: [{ url, name: "customer-photo.JPEG", size: 456 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{
    type: "image",
    originalContentUrl: url,
    previewImageUrl: url
  }]);
});

test("JPEG uses the same preview-size fallback rule", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/photo-large?signature=jpeg-large-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    imageAttachment: [{ url, name: "customer-photo.JPEG", size: 1_000_001 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `customer-photo.JPEG\n${url}` }]);
  assert.equal(calls.messageEvents[0].payload.imageLinkCount, 1);
});

test("one MP4 attachment produces a concise text-link fallback", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/video?signature=mp4-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    videoAttachment: [{ url, name: "customer-video.mp4", size: 789 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `customer-video.mp4\n${url}` }]);
});

test("one PDF attachment produces a concise text-link fallback", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/document?signature=pdf-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "customer-document.pdf", size: 321 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `customer-document.pdf\n${url}` }]);
});

test("text plus PNG plus MP4 sends text first and preserves attachment order", async () => {
  const calls = setupHarness();
  const imageUrl = "https://media.example.test/private/ordered-image?signature=image-private";
  const videoUrl = "https://media.example.test/private/ordered-video?signature=video-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    message: "text must be first",
    attachments: [
      { url: imageUrl, name: "ordered-image.png", size: 1 },
      { url: videoUrl, name: "ordered-video.mp4", size: 2 }
    ]
  }));

  assert.deepEqual(flattenedMessages(calls), [
    { type: "text", text: "text must be first" },
    { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
    { type: "text", text: `ordered-video.mp4\n${videoUrl}` }
  ]);
});

test("five mixed attachments preserve alias and attachment order in one LINE request", async () => {
  const calls = setupHarness();
  const values = {
    image: "https://media.example.test/private/a?signature=a-private",
    video: "https://media.example.test/private/b?signature=b-private",
    audio: "https://media.example.test/private/c?signature=c-private",
    document: "https://media.example.test/private/d?signature=d-private",
    unknown: "https://media.example.test/private/e?signature=e-private"
  };
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [
      { url: values.image, name: "a.jpg", size: 100 },
      { url: values.video, name: "b.mov" }
    ],
    imageAttachment: [
      { url: values.audio, name: "c.mp3" },
      { url: values.document, name: "d.docx" }
    ],
    videoAttachment: [{ url: values.unknown, name: "e.bin" }]
  }));

  assert.equal(result.body.status, "sent");
  assert.deepEqual(calls.messageBatches.map(([, messages]) => messages.length), [5]);
  assert.deepEqual(flattenedMessages(calls), [
    { type: "image", originalContentUrl: values.image, previewImageUrl: values.image },
    { type: "text", text: `b.mov\n${values.video}` },
    { type: "text", text: `c.mp3\n${values.audio}` },
    { type: "text", text: `d.docx\n${values.document}` },
    { type: "text", text: `e.bin\n${values.unknown}` }
  ]);
});

test("attachment under payload.data is accepted before top-level fallback", async () => {
  const calls = setupHarness();
  const dataUrl = "https://media.example.test/private/data-image?signature=data-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url: "https://media.example.test/private/top-image", name: "top.png" }],
    data: {
      message: "",
      attachments: [{ url: dataUrl, name: "data.png", size: 1 }]
    }
  }));

  assert.deepEqual(flattenedMessages(calls), [{
    type: "image",
    originalContentUrl: dataUrl,
    previewImageUrl: dataUrl
  }]);
});

test("attachment at the top level is accepted", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/top-level?signature=top-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    imageAttachment: [{ url, name: "top-level.png", size: 1 }]
  }));

  assert.equal(calls.messageBatches.length, 1);
  assert.equal(calls.messageBatches[0][1][0].originalContentUrl, url);
});

test("an empty attachment string is ignored and text remains provider-first", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  const calls = setupHarness();
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({
    message: "text with blank attachment default",
    attachments: "",
    imageAttachment: "   "
  }));

  assert.equal(result.body.status, "sent");
  assert.equal(calls.providerDispatches.length, 1);
  assert.equal(calls.messageBatches.length, 0);
});

test("a single plain attachment object is normalized to one attachment", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/single-object?signature=single-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: { url, name: "single.png", size: 0 }
  }));

  assert.equal(flattenedMessages(calls).length, 1);
  assert.equal(flattenedMessages(calls)[0].originalContentUrl, url);
});

test("non-object and URL-less array entries are ignored safely", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/usable?signature=usable-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [null, "not-an-object", [], { name: "missing-url.png" }, { url, name: "usable.png", size: 1 }]
  }));

  assert.equal(flattenedMessages(calls).length, 1);
  assert.equal(flattenedMessages(calls)[0].originalContentUrl, url);
});

test("a non-HTTPS attachment URL is rejected before lookup or delivery", async () => {
  const calls = setupHarness();
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url: "http://media.example.test/private/insecure.png", name: "insecure.png" }]
  }));

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error, "Attachment URL must use HTTPS");
  assertNoSideEffects(calls);
});

test("signed HTTPS attachment URLs are preserved exactly for delivery", async () => {
  const calls = setupHarness();
  const signedUrl = "https://media.example.test/folder%20name/image.png?signature=exact-private&expires=123";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url: signedUrl, name: "signed.png", size: 1 }]
  }));

  assert.equal(flattenedMessages(calls)[0].originalContentUrl, signedUrl);
  assert.equal(flattenedMessages(calls)[0].previewImageUrl, signedUrl);
});

test("a valid Traditional Chinese attachment filename remains unchanged", async () => {
  const calls = setupHarness();
  const name = "最後7月場次圖.png";
  const url = "https://media.example.test/private/traditional.png?signature=traditional-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name, size: 1_000_001 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `${name}\n${url}` }]);
});

test("a valid Japanese attachment filename remains unchanged", async () => {
  const calls = setupHarness();
  const name = "最終イベント画像.png";
  const url = "https://media.example.test/private/japanese.png?signature=japanese-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name, size: 1_000_001 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `${name}\n${url}` }]);
});

test("an emoji attachment filename remains unchanged", async () => {
  const calls = setupHarness();
  const name = "夏祭り🎉📷.png";
  const url = "https://media.example.test/private/emoji.png?signature=emoji-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name, size: 1_000_001 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `${name}\n${url}` }]);
});

test("valid Simplified Chinese and Korean filenames remain unchanged", async () => {
  const calls = setupHarness();
  const names = ["最终活动文件.pdf", "최종행사파일.pdf"];
  const urls = [
    "https://media.example.test/private/simplified.pdf?signature=simplified-private",
    "https://media.example.test/private/korean.pdf?signature=korean-private"
  ];
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: names.map((name, index) => ({ url: urls[index], name }))
  }));

  assert.deepEqual(flattenedMessages(calls), names.map((name, index) => ({
    type: "text",
    text: `${name}\n${urls[index]}`
  })));
});

test("common Latin-1 and Windows-1252 UTF-8 mojibake repairs to Traditional Chinese", async () => {
  const calls = setupHarness();
  const expectedName = "最後7月場次圖.png";
  const latin1Mojibake = Buffer.from(expectedName, "utf8").toString("latin1");
  const windows1252Mojibake = new TextDecoder("windows-1252").decode(Buffer.from(expectedName, "utf8"));
  const urls = [
    "https://media.example.test/private/latin1.png?signature=latin1-private",
    "https://media.example.test/private/windows1252.png?signature=windows-private"
  ];

  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [
      { url: urls[0], name: latin1Mojibake, size: 1_000_001 },
      { url: urls[1], name: windows1252Mojibake, size: 1_000_001 }
    ]
  }));

  assert.deepEqual(flattenedMessages(calls), urls.map((url) => ({
    type: "text",
    text: `${expectedName}\n${url}`
  })));
});

test("a normal ASCII attachment filename remains unchanged", async () => {
  const calls = setupHarness();
  const name = "quarterly-report-final.pdf";
  const url = "https://media.example.test/private/ascii.pdf?signature=ascii-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `${name}\n${url}` }]);
});

test("an uncertain malformed image filename uses the category fallback and safe extension", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/malformed.png?signature=malformed-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "Ã©ÿ.png", size: 1_000_001 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `圖片附件.png\n${url}` }]);
});

test("uncertain malformed filenames use category-specific fallbacks", async () => {
  const calls = setupHarness();
  const fixtures = [
    { extension: "mp4", label: "影片附件" },
    { extension: "mp3", label: "音訊附件" },
    { extension: "pdf", label: "文件附件" },
    { extension: "bin", label: "附件" }
  ];
  const attachments = fixtures.map(({ extension }, index) => ({
    url: `https://media.example.test/private/fallback-${index}?signature=fallback-private-${index}`,
    name: `Ã©ÿ.${extension}`
  }));
  await workflowService.processGhlWorkflowSendLine(basePayload({ attachments }));

  assert.deepEqual(flattenedMessages(calls), fixtures.map(({ extension, label }, index) => ({
    type: "text",
    text: `${label}.${extension}\n${attachments[index].url}`
  })));
});

test("attachment display names remove path traversal components", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/path.png?signature=path-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "../../private/最後7月場次圖.png", size: 1_000_001 }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `最後7月場次圖.png\n${url}` }]);
});

test("attachment display names remove controls and collapse excessive whitespace", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/control.pdf?signature=control-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: "報告\u0000   \n 最終.pdf" }]
  }));

  assert.deepEqual(flattenedMessages(calls), [{ type: "text", text: `報告 最終.pdf\n${url}` }]);
});

test("attachment display names retain a safe extension within the 120-character limit", async () => {
  const calls = setupHarness();
  const url = "https://media.example.test/private/long.pdf?signature=long-private";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url, name: `${"🎉".repeat(130)}.pdf` }]
  }));
  const displayName = flattenedMessages(calls)[0].text.split("\n")[0];

  assert.equal(Array.from(displayName).length, 120);
  assert.equal(displayName.endsWith(".pdf"), true);
  assert.doesNotMatch(displayName, /\uFFFD/);
});

test("display-name repair leaves signed attachment URLs byte-for-byte unchanged", async () => {
  const calls = setupHarness();
  const expectedName = "最後7月場次圖.png";
  const mojibakeName = new TextDecoder("windows-1252").decode(Buffer.from(expectedName, "utf8"));
  const signedUrl = "https://media.example.test/folder%20name/file.png?X-Signature=a%2Bb%2Fc%3D&expires=123";
  await workflowService.processGhlWorkflowSendLine(basePayload({
    attachments: [{ url: signedUrl, name: mojibakeName, size: 1_000_001 }]
  }));

  assert.equal(flattenedMessages(calls)[0].text, `${expectedName}\n${signedUrl}`);
});

test("text plus four attachments fits in exactly one LINE request", async () => {
  const calls = setupHarness();
  const attachments = Array.from({ length: 4 }, (_, index) => ({
    url: `https://media.example.test/private/text-limit-${index}.png`,
    name: `text-limit-${index}.png`,
    size: 100
  }));
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({
    message: "one leading text message",
    attachments
  }));

  assert.equal(result.body.status, "sent");
  assert.equal(calls.messageBatches.length, 1);
  assert.equal(calls.messageBatches[0][1].length, 5);
  assert.deepEqual(calls.messageBatches[0][1][0], { type: "text", text: "one leading text message" });
});

test("six attachment outputs without text are rejected before side effects", async () => {
  const calls = setupHarness();
  const attachments = Array.from({ length: 6 }, (_, index) => ({
    url: `https://media.example.test/private/no-text-overflow-${index}.png`,
    name: `no-text-overflow-${index}.png`,
    size: 100
  }));
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({ attachments }));

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error, "Workflow text and attachments must produce no more than 5 LINE messages");
  assertNoSideEffects(calls);
});

test("text plus five attachment outputs are rejected before side effects", async () => {
  const calls = setupHarness();
  const attachments = Array.from({ length: 5 }, (_, index) => ({
    url: `https://media.example.test/private/text-overflow-${index}.png`,
    name: `text-overflow-${index}.png`,
    size: 100
  }));
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({
    message: "this consumes one LINE message slot",
    attachments
  }));

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error, "Workflow text and attachments must produce no more than 5 LINE messages");
  assertNoSideEffects(calls);
});

test("more than 20 usable attachments is rejected before side effects", async () => {
  const calls = setupHarness();
  const attachments = Array.from({ length: 21 }, (_, index) => ({
    url: `https://media.example.test/private/limit-${index}.png`,
    name: `limit-${index}.png`
  }));
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({ attachments }));

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error, "A maximum of 20 attachments is supported");
  assertNoSideEffects(calls);
});

test("generic LINE batch client preserves ordered messages and enforces the five-message limit", async () => {
  const originalBatchPush = originals.find(
    ([module, key]) => module === lineClient && key === "pushLineMessages"
  )[2];
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({
      sentMessages: Array.from({ length: 5 }, (_, index) => ({ id: `line_client_${index + 1}` }))
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const messages = [
    { type: "text", text: "first" },
    { type: "image", originalContentUrl: "https://media.example.test/a.png", previewImageUrl: "https://media.example.test/a.png" },
    { type: "text", text: "third" },
    { type: "text", text: "fourth" },
    { type: "text", text: "fifth" }
  ];

  const result = await originalBatchPush("line_user_batch", messages, "tenant_channel_token");

  assert.deepEqual(JSON.parse(requests[0].init.body), { to: "line_user_batch", messages });
  assert.deepEqual(result.messageIds, [
    "line_client_1",
    "line_client_2",
    "line_client_3",
    "line_client_4",
    "line_client_5"
  ]);
  await assert.rejects(
    () => originalBatchPush("line_user_batch", [...messages, { type: "text", text: "sixth" }], "tenant_channel_token"),
    (error) => error instanceof lineClient.LineApiError && error.category === "invalid_request"
  );
  assert.equal(requests.length, 1);
});

test("LINE sent message IDs normalize numeric values consistently for success and accepted retry", async () => {
  const originalBatchPush = originals.find(
    ([module, key]) => module === lineClient && key === "pushLineMessages"
  )[2];
  const responseHeaders = new Headers({ "Content-Type": "application/json" });
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: responseHeaders,
    body: null,
    json: async () => ({
      sentMessages: [
        { id: 123 },
        { id: 0 },
        { id: -45.5 },
        { id: "string-id" },
        { id: "" },
        { id: "   " },
        { id: Number.NaN },
        { id: Number.POSITIVE_INFINITY },
        { id: null },
        { id: { nested: true } },
        { id: true }
      ]
    })
  });

  const success = await originalBatchPush(
    "line_user_numeric",
    [{ type: "text", text: "numeric IDs" }],
    "tenant_channel_token"
  );

  assert.equal(success.messageId, "123");
  assert.deepEqual(success.messageIds, ["123", "0", "-45.5", "string-id"]);

  global.fetch = async () => ({
    status: 409,
    ok: false,
    headers: new Headers({
      "Content-Type": "application/json",
      "X-Line-Accepted-Request-Id": "accepted-request"
    }),
    body: null,
    json: async () => ({ sentMessages: [{ id: 987654321 }, { id: false }, { id: "retry-string" }] })
  });

  const acceptedRetry = await originalBatchPush(
    "line_user_numeric",
    [{ type: "text", text: "accepted retry IDs" }],
    "tenant_channel_token",
    "7ac0e4c4-8f04-4c19-b33a-7b3b9b425df0"
  );

  assert.equal(acceptedRetry.messageId, "987654321");
  assert.deepEqual(acceptedRetry.messageIds, ["987654321", "retry-string"]);
  assert.equal(acceptedRetry.acceptedByRetryKey, true);
});

test("legacy Phase 1 text output remains unchanged", async () => {
  config.env.GHL_WORKFLOW_LINE_DELIVERY_MODE = "provider_first";
  const calls = setupHarness();
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({ message: "legacy unchanged" }));

  assert.deepEqual(result.body, {
    ok: true,
    status: "sent",
    provider: "line",
    lineMessageId: null,
    error: ""
  });
  assert.equal(calls.providerDispatches[0].message, "legacy unchanged");
  assert.equal(calls.messageBatches.length, 0);
});

test("explicit Phase 1 image URL path remains unchanged", async () => {
  const calls = setupHarness();
  const originalImageUrl = "https://media.example.test/private/original.png?signature=phase-one-private";
  const previewImageUrl = "https://media.example.test/private/preview.png?signature=phase-one-preview-private";
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({
    messageType: "image",
    originalImageUrl,
    previewImageUrl,
    attachments: [{ url: "https://media.example.test/private/ignored.png", name: "ignored.png" }]
  }));

  assert.equal(result.body.status, "sent");
  assert.deepEqual(calls.imagePushes, [[
    "line_user_phase_2_sensitive",
    originalImageUrl,
    previewImageUrl,
    "tenant_channel_token_sensitive"
  ]]);
  assert.equal(calls.messageBatches.length, 0);
});

test("attachment logs and audit payload expose only structural metadata", async () => {
  const calls = setupHarness();
  const message = "private customer attachment message";
  const url = "https://media.example.test/private/customer-file.png?signature=log-private-token";
  const filename = "private-customer-filename.png";
  const result = await workflowService.processGhlWorkflowSendLine(
    basePayload({ message, attachments: [{ url, name: filename, size: 123 }] }),
    { requestId: "safe_attachment_request" }
  );
  const exposed = JSON.stringify({ response: result, logs: calls.logs });
  const storedPayload = JSON.stringify(calls.messageEvents[0].payload);

  assert.equal(result.body.status, "sent");
  assert.doesNotMatch(
    exposed,
    /private customer attachment message|media\.example\.test|customer-file\.png|log-private-token|private-customer-filename\.png|location_phase_2_sensitive|contact_phase_2_sensitive|workflow_phase_2_sensitive|tenant_phase_2_sensitive|line_user_phase_2_sensitive|line_channel_phase_2_sensitive|conversation_phase_2_sensitive|tenant_channel_token_sensitive/
  );
  assert.doesNotMatch(
    storedPayload,
    /private customer attachment message|media\.example\.test|customer-file\.png|log-private-token|private-customer-filename\.png/
  );
  assert.equal(calls.messageEvents[0].payload.attachmentCount, 1);
  assert.equal(calls.messageEvents[0].payload.nativeImageCount, 1);
  assert.equal(calls.logs.some(({ args }) =>
    args[0]?.attachmentCount === 1 &&
    args[0]?.nativeImageCount === 1 &&
    args[0]?.textPresent === true &&
    args[0]?.dispatchStatus === "sent" &&
    args[0]?.provider === "line"
  ), true);
});

test("successful attachment delivery remains sent when audit persistence fails", async () => {
  const calls = setupHarness();
  let auditAttempts = 0;
  repository.saveMessageEvent = async () => {
    auditAttempts += 1;
    throw new Error("private audit failure detail");
  };
  const result = await workflowService.processGhlWorkflowSendLine(
    basePayload({
      attachments: [{
        url: "https://media.example.test/private/audit.png?signature=audit-private",
        name: "audit-private-name.png"
      }]
    }),
    { requestId: "safe_audit_request" }
  );
  const serializedLogs = JSON.stringify(calls.logs);

  assert.equal(result.body.status, "sent");
  assert.equal(result.body.ok, true);
  assert.equal(calls.messageBatches.length, 1);
  assert.equal(auditAttempts, 1);
  assert.equal(calls.logs.some(({ args }) =>
    args[0]?.auditPersistenceStatus === "failed" &&
    args.some((value) => value === "Failed to persist GHL workflow LINE attachment audit event")
  ), true);
  assert.doesNotMatch(serializedLogs, /private audit failure detail|media\.example\.test|audit-private|audit-private-name/);
});

test("a failed single LINE attachment request is not reported as complete success", async () => {
  const calls = setupHarness();
  lineClient.pushLineMessages = async (...args) => {
    calls.messageBatches.push(args);
    throw new lineClient.LineApiError({
      category: "invalid_request",
      statusCode: 400,
      lineRequestId: "single_failure_request"
    });
  };
  const attachments = Array.from({ length: 5 }, (_, index) => ({
    url: `https://media.example.test/private/failure-${index}?signature=failure-private-${index}`,
    name: `failure-${index}.png`,
    size: 100
  }));
  const result = await workflowService.processGhlWorkflowSendLine(basePayload({ attachments }));

  assert.equal(calls.messageBatches.length, 1);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.status, "failed");
  assert.equal(result.body.error, "LINE attachment send failed");
  assert.equal(result.body.lineMessageId, null);
  assert.equal(calls.messageEvents.length, 1);
  assert.equal(calls.messageEvents[0].status, "failed");
  assert.equal(calls.messageEvents[0].requestPayload.dispatchStatus, "failed");
  assert.equal(calls.messageEvents[0].requestPayload.sentMessageCount, 0);
  assert.equal(calls.messageEvents[0].requestPayload.totalMessageCount, 5);
});
