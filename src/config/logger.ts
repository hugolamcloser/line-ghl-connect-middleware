import pino from "pino";
import { env } from "./env";

const sensitiveLogHeaderNames = [
  "authorization",
  "proxy-authorization",
  "set-cookie",
  "x-access-token",
  "x-refresh-token",
  "x-wincrm-webhook-secret",
  "x-webhook-secret",
  "x-provider-secret",
  "x-ghl-secret",
  "x-line-signature",
  "x-ghl-signature",
  "x-wh-signature"
] as const;

const sensitiveLogHeaderContainers = ["req.headers", "request.headers", "res.headers", "response.headers", "headers"] as const;

const sensitiveLogHeaderPaths = sensitiveLogHeaderContainers.flatMap((container) =>
  sensitiveLogHeaderNames.map((headerName) => `${container}["${headerName}"]`)
);

export const logRedactionPaths = [
  ...sensitiveLogHeaderPaths,
  "message",
  "text",
  "requestBody",
  "request_body",
  "responseBody",
  "response_body",
  "error",
  "errorMessage",
  "error.message",
  "err.message",
  "req.body",
  "request.body",
  "res.body",
  "response.body",
  "payload.message",
  "payload.text",
  "payload.error",
  "payload.errorMessage",
  "payload.requestBody",
  "payload.request_body",
  "payload.responseBody",
  "payload.response_body",
  "data.message",
  "data.text",
  "data.error",
  "data.errorMessage",
  "data.requestBody",
  "data.request_body",
  "data.responseBody",
  "data.response_body",
  "originalImageUrl",
  "previewImageUrl",
  "imageUrl",
  "locationId",
  "contactId",
  "conversationId",
  "callbackConversationId",
  "tenantId",
  "tenantIds",
  "companyId",
  "lineUserId",
  "lineChannelId",
  "lineMessageId",
  "ghlMessageId",
  "messageId",
  "channelId",
  "userId",
  "ghlConversationId",
  "existingGhlConversationId",
  "conversationProviderId",
  "workflowId",
  "foundTenantId",
  "foundLineUserId",
  "foundGhlConversationId",
  "access_token",
  "refresh_token",
  "authorization",
  "config.SUPABASE_SERVICE_ROLE_KEY",
  "config.LINE_CHANNEL_SECRET",
  "config.LINE_CHANNEL_ACCESS_TOKEN",
  "config.GHL_PRIVATE_INTEGRATION_TOKEN",
  "config.GHL_OAUTH_CLIENT_SECRET"
] as const;

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [...logRedactionPaths],
    censor: "[redacted]"
  }
});
