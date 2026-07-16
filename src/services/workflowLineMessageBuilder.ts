import { isIP } from "node:net";

export type WorkflowLineMessageType = "text" | "image";

export type WorkflowLineMessageInputPresence = {
  messagePresent: boolean;
  originalImageUrlPresent: boolean;
  previewImageUrlPresent: boolean;
};

export type WorkflowLineTextMessage = {
  type: "text";
  text: string;
  inputPresence: WorkflowLineMessageInputPresence;
};

export type WorkflowLineImageMessage = {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
  originalHostname: string;
  previewHostname: string;
  inputPresence: WorkflowLineMessageInputPresence;
};

export type WorkflowLineMessage = WorkflowLineTextMessage | WorkflowLineImageMessage;

export class WorkflowLineMessageValidationError extends Error {}

const lineTextMaxCharacters = 5_000;
const lineImageUrlMaxCharacters = 2_000;

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwnProperty(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function getActionField(payload: Record<string, unknown>, key: string): unknown {
  const data = getRecord(payload.data);
  return hasOwnProperty(data, key) ? data[key] : payload[key];
}

function getTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseMessageType(value: unknown): WorkflowLineMessageType {
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
    return "text";
  }

  if (typeof value !== "string") {
    throw new WorkflowLineMessageValidationError("messageType must be text or image");
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "text" || normalized === "image") {
    return normalized;
  }

  throw new WorkflowLineMessageValidationError("Unsupported messageType. Supported values are text and image");
}

function parseIpv4(address: string): number[] | undefined {
  const octets = address.split(".");

  if (octets.length !== 4) {
    return undefined;
  }

  const parsed = octets.map((octet) => Number(octet));

  return parsed.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? parsed
    : undefined;
}

function isNonPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);

  if (!octets) {
    return true;
  }

  const [first, second] = octets;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function expandIpv6(address: string): number[] | undefined {
  let normalized = address.toLowerCase();

  if (normalized.includes("%")) {
    return undefined;
  }

  const ipv4TailMatch = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4TailMatch) {
    const ipv4 = parseIpv4(ipv4TailMatch[2]);
    if (!ipv4) {
      return undefined;
    }

    normalized = `${ipv4TailMatch[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    return undefined;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;

  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }

  const segments = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right
  ];

  if (segments.length !== 8 || segments.some((segment) => !/^[0-9a-f]{1,4}$/.test(segment))) {
    return undefined;
  }

  return segments.map((segment) => Number.parseInt(segment, 16));
}

function isNonPublicIpv6(address: string): boolean {
  const segments = expandIpv6(address);

  if (!segments) {
    return true;
  }

  const [first] = segments;
  const isUnspecified = segments.every((segment) => segment === 0);
  const isLoopback = segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isMulticast = (first & 0xff00) === 0xff00;
  const isIpv4Mapped = segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff;
  const isIpv4Compatible = segments.slice(0, 6).every((segment) => segment === 0);

  if (isIpv4Mapped || isIpv4Compatible) {
    const ipv4Address = [
      segments[6] >> 8,
      segments[6] & 0xff,
      segments[7] >> 8,
      segments[7] & 0xff
    ].join(".");

    return isNonPublicIpv4(ipv4Address);
  }

  return isUnspecified || isLoopback || isUniqueLocal || isLinkLocal || isMulticast;
}

function validatePublicHttpsUrl(
  value: unknown,
  fieldName: "originalImageUrl" | "previewImageUrl"
): { url: string; hostname: string } {
  const normalized = getTrimmedString(value);

  if (!normalized) {
    throw new WorkflowLineMessageValidationError(`${fieldName} is required for image messages`);
  }

  if (typeof value === "string" && /[\u0000-\u0020\u007f]/.test(value)) {
    throw new WorkflowLineMessageValidationError(
      `${fieldName} must be percent-encoded and must not contain whitespace`
    );
  }

  if (normalized.length > lineImageUrlMaxCharacters) {
    throw new WorkflowLineMessageValidationError(
      `${fieldName} must be ${lineImageUrlMaxCharacters} characters or fewer`
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new WorkflowLineMessageValidationError(`${fieldName} must be a valid absolute URL`);
  }

  if (parsed.protocol !== "https:") {
    throw new WorkflowLineMessageValidationError(`${fieldName} must use HTTPS`);
  }

  if (parsed.username || parsed.password) {
    throw new WorkflowLineMessageValidationError(`${fieldName} must not contain embedded credentials`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new WorkflowLineMessageValidationError(`${fieldName} must not use localhost`);
  }

  const ipVersion = isIP(hostname);
  if (
    (ipVersion === 4 && isNonPublicIpv4(hostname)) ||
    (ipVersion === 6 && isNonPublicIpv6(hostname))
  ) {
    throw new WorkflowLineMessageValidationError(`${fieldName} must not use a loopback or private-network IP address`);
  }

  return { url: normalized, hostname };
}

export function buildWorkflowLineMessage(payload: Record<string, unknown>): WorkflowLineMessage {
  const rawMessage = getActionField(payload, "message");
  const rawOriginalImageUrl = getActionField(payload, "originalImageUrl");
  const rawPreviewImageUrl = getActionField(payload, "previewImageUrl");
  const inputPresence: WorkflowLineMessageInputPresence = {
    messagePresent: Boolean(getTrimmedString(rawMessage)),
    originalImageUrlPresent: Boolean(getTrimmedString(rawOriginalImageUrl)),
    previewImageUrlPresent: Boolean(getTrimmedString(rawPreviewImageUrl))
  };
  const messageType = parseMessageType(getActionField(payload, "messageType"));

  if (messageType === "text") {
    const text = getTrimmedString(rawMessage);

    if (!text) {
      throw new WorkflowLineMessageValidationError("Message is required");
    }

    if (text.length > lineTextMaxCharacters) {
      throw new WorkflowLineMessageValidationError(`Message must be ${lineTextMaxCharacters} characters or fewer`);
    }

    return { type: "text", text, inputPresence };
  }

  const originalImage = validatePublicHttpsUrl(rawOriginalImageUrl, "originalImageUrl");
  const previewImage = validatePublicHttpsUrl(rawPreviewImageUrl, "previewImageUrl");

  return {
    type: "image",
    originalContentUrl: originalImage.url,
    previewImageUrl: previewImage.url,
    originalHostname: originalImage.hostname,
    previewHostname: previewImage.hostname,
    inputPresence
  };
}
