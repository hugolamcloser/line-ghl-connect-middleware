import crypto from "node:crypto";
import { env, requireEnvValue } from "../config/env";
import type { LineProfile } from "../types/line";

const lineApiBaseUrl = "https://api.line.me";

export type LinePushTextMessageResult = {
  messageId?: string;
  raw?: {
    sentMessages?: Array<{
      id?: string;
      quoteToken?: string;
    }>;
    [key: string]: unknown;
  };
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

async function lineRequest<T>(path: string, init?: RequestInit, channelAccessToken?: string): Promise<T> {
  const response = await fetch(`${lineApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${resolveLineChannelAccessToken(channelAccessToken)}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE API ${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function getLineProfile(userId: string, channelAccessToken?: string): Promise<LineProfile | null> {
  try {
    return await lineRequest<LineProfile>(`/v2/bot/profile/${encodeURIComponent(userId)}`, undefined, channelAccessToken);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }

    throw error;
  }
}

export async function pushLineTextMessage(
  to: string,
  text: string,
  channelAccessToken?: string
): Promise<LinePushTextMessageResult> {
  const response = await lineRequest<LinePushTextMessageResult["raw"] | undefined>(
    "/v2/bot/message/push",
    {
      method: "POST",
      body: JSON.stringify({
        to,
        messages: [
          {
            type: "text",
            text
          }
        ]
      })
    },
    channelAccessToken
  );

  return {
    messageId: response?.sentMessages?.[0]?.id,
    raw: response
  };
}
