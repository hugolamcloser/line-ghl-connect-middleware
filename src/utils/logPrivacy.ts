import crypto from "node:crypto";

export function hasLogValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

export function buildShortLogRef(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  return crypto.createHash("sha256").update(value.trim()).digest("hex").slice(0, 12);
}

export function buildMessageLogMetadata(message: unknown): {
  messagePresent: boolean;
  messageLength: number;
} {
  return {
    messagePresent: typeof message === "string" && message.trim().length > 0,
    messageLength: typeof message === "string" ? message.length : 0
  };
}
