import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import helmet from "helmet";
import pino from "pino";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { jsonBodyParser } from "./middleware/jsonBody";
import { errorHandler, notFoundHandler } from "./middleware/errors";
import { adminRouter } from "./routes/admin";
import { appLineRouter } from "./routes/appLine";
import { debugRouter } from "./routes/debug";
import { ghlAppInstallWebhookRouter } from "./routes/ghlAppInstallWebhook";
import { ghlWebhookRouter } from "./routes/ghlWebhook";
import { healthRouter } from "./routes/health";
import { lineWebhookRouter } from "./routes/lineWebhook";
import { oauthRouter } from "./routes/oauth";

const sensitiveQueryKeyNames = [
  "authorization",
  "code",
  "pageToken",
  "actionToken",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "state",
  "client_secret",
  "clientSecret",
  "id_token",
  "idToken",
  "token",
  "channelAccessToken",
  "channelSecret",
  "channel_access_token",
  "channel_secret",
  "x-ghl-signature",
  "x-wh-signature",
  "x-line-signature",
  "x-provider-secret",
  "x-ghl-secret",
  "x-webhook-secret",
  "x-wincrm-webhook-secret",
  "locationId",
  "contactId",
  "conversationId",
  "ghlConversationId",
  "tenantId",
  "companyId",
  "lineUserId",
  "lineChannelId",
  "channelId",
  "messageId",
  "ghlMessageId",
  "workflowId",
  "userId"
] as const;

const sensitiveQueryKeys = new Set(sensitiveQueryKeyNames.map((key) => key.toLowerCase()));

function isSensitiveQueryKey(key: string): boolean {
  if (sensitiveQueryKeys.has(key.toLowerCase())) {
    return true;
  }

  try {
    return sensitiveQueryKeys.has(decodeURIComponent(key.replace(/\+/g, " ")).toLowerCase());
  } catch {
    return false;
  }
}

export function redactSensitiveUrlQuery(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) {
    return rawUrl;
  }

  try {
    const parsedUrl = new URL(rawUrl, "http://localhost");
    let changed = false;

    for (const key of Array.from(parsedUrl.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        parsedUrl.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }

    return changed ? `${parsedUrl.pathname}${parsedUrl.search}` : rawUrl;
  } catch {
    return rawUrl.replace(
      /([?&])([^=&#]+)=([^&#]*)/g,
      (matchedParameter, delimiter: string, rawKey: string) => {
        let decodedKey = rawKey;

        try {
          decodedKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
        } catch {
          // Keep the original key for the case-insensitive safety check.
        }

        return isSensitiveQueryKey(decodedKey) ? `${delimiter}${rawKey}=[redacted]` : matchedParameter;
      }
    );
  }
}

export function redactSensitiveQueryObject(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const redactedValue = { ...(value as Record<string, unknown>) };

  for (const key of Object.keys(redactedValue)) {
    if (isSensitiveQueryKey(key)) {
      redactedValue[key] = "[redacted]";
    }
  }

  return redactedValue;
}

export function redactRequestHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return headers;
  }

  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key.toLowerCase(), value])
  );
  const isPresent = (key: string): boolean => normalizedHeaders[key] !== undefined;

  return {
    headerCount: Object.keys(normalizedHeaders).length,
    contentTypePresent: isPresent("content-type"),
    contentLengthPresent: isPresent("content-length"),
    userAgentPresent: isPresent("user-agent"),
    requestIdPresent: isPresent("x-request-id"),
    forwardedForPresent: isPresent("x-forwarded-for") || isPresent("forwarded"),
    authorizationPresent: isPresent("authorization"),
    webhookSecretPresent: isPresent("x-wincrm-webhook-secret") || isPresent("x-webhook-secret"),
    providerSecretPresent: isPresent("x-provider-secret") || isPresent("x-ghl-secret"),
    signaturePresent:
      isPresent("x-line-signature") || isPresent("x-ghl-signature") || isPresent("x-wh-signature")
  };
}

function redactRequestSerializer(req: IncomingMessage): Record<string, unknown> {
  const serializedReq = pino.stdSerializers.req(req) as unknown as Record<string, unknown> & {
    headers?: unknown;
    query?: unknown;
    url?: unknown;
  };

  if (typeof serializedReq.url === "string") {
    serializedReq.url = redactSensitiveUrlQuery(serializedReq.url);
  }

  serializedReq.query = redactSensitiveQueryObject(serializedReq.query);
  serializedReq.headers = redactRequestHeaders(serializedReq.headers);

  return serializedReq;
}

export function redactResponseHeaders(headers: unknown): Record<string, unknown> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return { headerCount: 0 };
  }

  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key.toLowerCase(), value])
  );
  const isPresent = (key: string): boolean => normalizedHeaders[key] !== undefined;

  return {
    headerCount: Object.keys(normalizedHeaders).length,
    contentTypePresent: isPresent("content-type"),
    contentLengthPresent: isPresent("content-length"),
    locationPresent: isPresent("location"),
    setCookiePresent: isPresent("set-cookie"),
    authorizationPresent: isPresent("authorization") || isPresent("proxy-authorization"),
    accessTokenPresent: isPresent("x-access-token"),
    refreshTokenPresent: isPresent("x-refresh-token"),
    webhookSecretPresent: isPresent("x-wincrm-webhook-secret") || isPresent("x-webhook-secret"),
    providerSecretPresent: isPresent("x-provider-secret") || isPresent("x-ghl-secret"),
    signaturePresent:
      isPresent("x-line-signature") || isPresent("x-ghl-signature") || isPresent("x-wh-signature")
  };
}

function redactResponseSerializer(res: ServerResponse): Record<string, unknown> {
  const serializedRes = pino.stdSerializers.res(res) as unknown as Record<string, unknown> & { headers?: unknown };

  serializedRes.headers = redactResponseHeaders(serializedRes.headers);

  return serializedRes;
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(pinoHttp({ logger, serializers: { req: redactRequestSerializer, res: redactResponseSerializer } }));
  app.use(jsonBodyParser);

  app.use(healthRouter);
  app.use(debugRouter);
  app.use(oauthRouter);
  app.use(ghlAppInstallWebhookRouter);
  app.use(lineWebhookRouter);
  app.use(ghlWebhookRouter);
  app.use(appLineRouter);
  app.use(adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
