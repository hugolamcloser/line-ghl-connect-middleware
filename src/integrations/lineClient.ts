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

export function verifyLineSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.LINE_CHANNEL_SECRET || !signature) {
    return false;
  }

  const expected = crypto.createHmac("sha256", env.LINE_CHANNEL_SECRET).update(rawBody).digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function lineRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${lineApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireEnvValue("LINE_CHANNEL_ACCESS_TOKEN", env.LINE_CHANNEL_ACCESS_TOKEN)}`,
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

export async function getLineProfile(userId: string): Promise<LineProfile | null> {
  try {
    return await lineRequest<LineProfile>(`/v2/bot/profile/${encodeURIComponent(userId)}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      return null;
    }

    throw error;
  }
}

export async function pushLineTextMessage(to: string, text: string): Promise<LinePushTextMessageResult> {
  const response = await lineRequest<LinePushTextMessageResult["raw"] | undefined>("/v2/bot/message/push", {
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
  });

  return {
    messageId: response?.sentMessages?.[0]?.id,
    raw: response
  };
}
