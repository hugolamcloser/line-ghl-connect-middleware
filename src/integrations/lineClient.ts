import crypto from "node:crypto";
import { env, requireEnvValue } from "../config/env";
import type { LineProfile } from "../types/line";

const lineApiBaseUrl = "https://api.line.me";

export type LinePushMessageResult = {
  messageId?: string;
  messageIds?: string[];
  statusCode: number;
  lineRequestId?: string;
  acceptedRequestId?: string;
  acceptedByRetryKey?: boolean;
  raw?: {
    sentMessages?: Array<{
      id?: string | number;
      quoteToken?: string;
    }>;
    [key: string]: unknown;
  };
};

export type LinePushTextMessageResult = LinePushMessageResult;

export type LinePushTextMessage = {
  type: "text";
  text: string;
};

export type LinePushImageMessage = {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
};

export type LinePushMessage = LinePushTextMessage | LinePushImageMessage;

export const lineMaxMessagesPerPush = 5;

export type LineApiErrorCategory =
  | "authentication"
  | "authorization"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "invalid_response"
  | "unknown_http_error"
  | "invalid_retry_key";

export class LineApiError extends Error {
  public readonly statusCode?: number;
  public readonly lineRequestId?: string;
  public readonly category: LineApiErrorCategory;

  constructor(input: {
    category: LineApiErrorCategory;
    statusCode?: number;
    lineRequestId?: string;
  }) {
    const status = input.statusCode ? `, status ${input.statusCode}` : "";
    super(`LINE API request failed (${input.category}${status})`);
    this.name = "LineApiError";
    this.statusCode = input.statusCode;
    this.lineRequestId = input.lineRequestId;
    this.category = input.category;
  }
}

type LineRequestResult<T> = {
  data: T;
  statusCode: number;
  lineRequestId?: string;
  acceptedRequestId?: string;
  acceptedByRetryKey?: boolean;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LineBotInfo = {
  userId?: string;
  basicId?: string;
  displayName?: string;
  pictureUrl?: string;
  chatMode?: string;
  markAsReadMode?: string;
  [key: string]: unknown;
};

function resolveLineChannelAccessToken(channelAccessToken?: string): string {
  const normalizedChannelAccessToken = channelAccessToken?.trim();

  if (normalizedChannelAccessToken) {
    return normalizedChannelAccessToken;
  }

  return requireEnvValue("LINE_CHANNEL_ACCESS_TOKEN", env.LINE_CHANNEL_ACCESS_TOKEN);
}

export function verifyLineSignature(
  rawBody: Buffer,
  signature: string | undefined,
  channelSecret?: string
): boolean {
  const resolvedChannelSecret = channelSecret?.trim() || env.LINE_CHANNEL_SECRET;

  if (!resolvedChannelSecret || !signature) {
    return false;
  }

  const expected = crypto.createHmac("sha256", resolvedChannelSecret).update(rawBody).digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getLineErrorCategory(statusCode: number): LineApiErrorCategory {
  if (statusCode === 400 || statusCode === 422) {
    return "invalid_request";
  }

  if (statusCode === 401) {
    return "authentication";
  }

  if (statusCode === 403) {
    return "authorization";
  }

  if (statusCode === 404) {
    return "not_found";
  }

  if (statusCode === 409) {
    return "conflict";
  }

  if (statusCode === 429) {
    return "rate_limited";
  }

  if (statusCode >= 500) {
    return "server_error";
  }

  return "unknown_http_error";
}

function getHeaderValue(response: Response, headerName: string): string | undefined {
  const value = response.headers.get(headerName)?.trim();
  return value || undefined;
}

function normalizeLineSentMessages(value: unknown): Array<{ id: string; quoteToken?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || !("id" in entry)) {
      return [];
    }

    const rawId = entry.id;
    const id = typeof rawId === "string"
      ? rawId.trim().length > 0 ? rawId : undefined
      : typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : undefined;
    const quoteToken = "quoteToken" in entry && typeof entry.quoteToken === "string"
      ? entry.quoteToken
      : undefined;

    return id ? [{ id, ...(quoteToken ? { quoteToken } : {}) }] : [];
  });
}

async function getSafeAcceptedRetryData<T>(response: Response): Promise<T> {
  try {
    const body = (await response.json()) as unknown;

    if (typeof body !== "object" || body === null || !("sentMessages" in body)) {
      return undefined as T;
    }

    const sentMessages = normalizeLineSentMessages(body.sentMessages);

    return { sentMessages } as T;
  } catch {
    return undefined as T;
  }
}

async function lineRequestWithMetadata<T>(
  path: string,
  init?: RequestInit,
  channelAccessToken?: string,
  options: { retryKey?: string; acceptRetryConflict?: boolean } = {}
): Promise<LineRequestResult<T>> {
  const retryKey = options.retryKey?.trim();

  if (options.retryKey !== undefined && (!retryKey || !uuidPattern.test(retryKey))) {
    throw new LineApiError({ category: "invalid_retry_key" });
  }

  let response: Response;

  try {
    response = await fetch(`${lineApiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${resolveLineChannelAccessToken(channelAccessToken)}`,
        "Content-Type": "application/json",
        ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}),
        ...(init?.headers ?? {})
      }
    });
  } catch {
    throw new LineApiError({ category: "network_error" });
  }

  const lineRequestId = getHeaderValue(response, "X-Line-Request-Id");
  const acceptedRequestId = getHeaderValue(response, "X-Line-Accepted-Request-Id");

  if (
    response.status === 409 &&
    options.acceptRetryConflict &&
    retryKey &&
    acceptedRequestId
  ) {
    return {
      data: await getSafeAcceptedRetryData<T>(response),
      statusCode: response.status,
      lineRequestId,
      acceptedRequestId,
      acceptedByRetryKey: true
    };
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore cleanup failures and preserve the safe typed LINE error below.
    }

    throw new LineApiError({
      category: getLineErrorCategory(response.status),
      statusCode: response.status,
      lineRequestId
    });
  }

  if (response.status === 204) {
    return { data: undefined as T, statusCode: response.status, lineRequestId };
  }

  try {
    return {
      data: (await response.json()) as T,
      statusCode: response.status,
      lineRequestId
    };
  } catch {
    throw new LineApiError({
      category: "invalid_response",
      statusCode: response.status,
      lineRequestId
    });
  }
}

async function lineRequest<T>(path: string, init?: RequestInit, channelAccessToken?: string): Promise<T> {
  const result = await lineRequestWithMetadata<T>(path, init, channelAccessToken);
  return result.data;
}

export async function getLineProfile(userId: string, channelAccessToken?: string): Promise<LineProfile | null> {
  try {
    return await lineRequest<LineProfile>(`/v2/bot/profile/${encodeURIComponent(userId)}`, undefined, channelAccessToken);
  } catch (error) {
    if (error instanceof LineApiError && error.statusCode === 404) {
      return null;
    }

    throw error;
  }
}

export async function getLineBotInfo(channelAccessToken?: string): Promise<LineBotInfo> {
  return lineRequest<LineBotInfo>("/v2/bot/info", undefined, channelAccessToken);
}

export async function validateLineChannelAccessToken(channelAccessToken: string): Promise<void> {
  await getLineBotInfo(channelAccessToken);
}

export async function pushLineMessages(
  to: string,
  messages: LinePushMessage[],
  channelAccessToken?: string,
  retryKey?: string
): Promise<LinePushMessageResult> {
  if (messages.length === 0 || messages.length > lineMaxMessagesPerPush) {
    throw new LineApiError({ category: "invalid_request" });
  }

  const result = await lineRequestWithMetadata<LinePushMessageResult["raw"] | undefined>(
    "/v2/bot/message/push",
    {
      method: "POST",
      body: JSON.stringify({
        to,
        messages
      })
    },
    channelAccessToken,
    { retryKey, acceptRetryConflict: true }
  );

  const normalizedSentMessages = normalizeLineSentMessages(result.data?.sentMessages);
  const messageIds = normalizedSentMessages.map(({ id }) => id);

  return {
    messageId: messageIds[0],
    messageIds,
    statusCode: result.statusCode,
    lineRequestId: result.lineRequestId,
    acceptedRequestId: result.acceptedRequestId,
    acceptedByRetryKey: result.acceptedByRetryKey,
    raw: result.data
  };
}

async function pushLineMessage(
  to: string,
  message: LinePushMessage,
  channelAccessToken?: string,
  retryKey?: string
): Promise<LinePushMessageResult> {
  return pushLineMessages(to, [message], channelAccessToken, retryKey);
}

export async function pushLineTextMessage(
  to: string,
  text: string,
  channelAccessToken?: string
): Promise<LinePushMessageResult> {
  return pushLineMessage(to, { type: "text", text }, channelAccessToken);
}

export async function pushLineImageMessage(
  to: string,
  originalContentUrl: string,
  previewImageUrl: string,
  channelAccessToken?: string,
  retryKey?: string
): Promise<LinePushMessageResult> {
  return pushLineMessage(
    to,
    {
      type: "image",
      originalContentUrl,
      previewImageUrl
    },
    channelAccessToken,
    retryKey
  );
}
