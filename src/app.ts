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
  "x-wincrm-webhook-secret"
] as const;

const sensitiveQueryKeys = new Set(sensitiveQueryKeyNames.map((key) => key.toLowerCase()));

function isSensitiveQueryKey(key: string): boolean {
  return sensitiveQueryKeys.has(key.toLowerCase());
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
      /([?&](?:code|pageToken|actionToken|access_token|accessToken|refresh_token|refreshToken|channelAccessToken|channelSecret|channel_access_token|channel_secret)=)[^&]*/gi,
      "$1[redacted]"
    );
  }
}

function redactSensitiveObjectKeys(value: unknown): unknown {
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

function redactUrlHeaderValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSensitiveUrlQuery(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? redactSensitiveUrlQuery(item) : item));
  }

  return value;
}

export function redactRequestHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return headers;
  }

  const redactedHeaders = redactSensitiveObjectKeys(headers) as Record<string, unknown>;

  for (const key of Object.keys(redactedHeaders)) {
    if (["referer", "referrer"].includes(key.toLowerCase())) {
      redactedHeaders[key] = redactUrlHeaderValue(redactedHeaders[key]);
    }
  }

  return redactedHeaders;
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

  serializedReq.query = redactSensitiveObjectKeys(serializedReq.query);
  serializedReq.headers = redactRequestHeaders(serializedReq.headers);

  return serializedReq;
}

function redactResponseHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return headers;
  }

  const redactedHeaders = { ...(headers as Record<string, unknown>) };

  for (const [key, value] of Object.entries(redactedHeaders)) {
    if (key.toLowerCase() !== "location") {
      continue;
    }

    redactedHeaders[key] = redactUrlHeaderValue(value);
  }

  return redactedHeaders;
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
