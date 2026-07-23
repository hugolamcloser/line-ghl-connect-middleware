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

export type WorkflowAttachmentCategory =
  | "native_image"
  | "image_link"
  | "video_link"
  | "audio_link"
  | "document_link"
  | "unknown_link";

export type NormalizedWorkflowAttachment = {
  url: string;
  displayName: string;
  size?: number;
  category: WorkflowAttachmentCategory;
};

export type WorkflowAttachmentSummary = {
  attachmentCount: number;
  nativeImageCount: number;
  imageLinkCount: number;
  videoLinkCount: number;
  audioLinkCount: number;
  documentLinkCount: number;
  unknownLinkCount: number;
};

export type WorkflowLineAttachmentMessage = {
  type: "attachments";
  text?: string;
  attachments: NormalizedWorkflowAttachment[];
  attachmentSummary: WorkflowAttachmentSummary;
  inputPresence: WorkflowLineMessageInputPresence;
};

export type WorkflowLineMessage =
  | WorkflowLineTextMessage
  | WorkflowLineImageMessage
  | WorkflowLineAttachmentMessage;

export class WorkflowLineMessageValidationError extends Error {}

const lineTextMaxCharacters = 5_000;
const lineImageUrlMaxCharacters = 2_000;
const maxWorkflowAttachments = 20;
const maxWorkflowAttachmentLineMessages = 5;
const maxNativeImagePreviewBytes = 1_000_000;
const maxAttachmentDisplayNameCharacters = 120;
const attachmentAliases = ["attachments", "imageAttachment", "videoAttachment"] as const;
const nativeImageExtensions = new Set(["jpg", "jpeg", "png"]);
const videoExtensions = new Set(["mp4", "mov", "m4v", "webm"]);
const audioExtensions = new Set(["mp3", "m4a", "wav", "aac", "ogg"]);
const documentExtensions = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "ppt",
  "pptx",
  "txt"
]);
const windows1252SpecialBytes = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f]
]);

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

export function validatePublicHttpsUrl(
  value: unknown,
  fieldName: "originalImageUrl" | "previewImageUrl" | "Attachment URL"
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

function getAttachmentCategory(
  name: string | undefined,
  size: number | undefined
): WorkflowAttachmentCategory {
  if (!name) {
    return "unknown_link";
  }

  const lastPathSegment = name.split(/[\\/]/).at(-1) ?? "";
  const lastDotIndex = lastPathSegment.lastIndexOf(".");
  const extension = lastDotIndex > 0 ? lastPathSegment.slice(lastDotIndex + 1).toLowerCase() : "";

  if (nativeImageExtensions.has(extension)) {
    return size !== undefined && size <= maxNativeImagePreviewBytes
      ? "native_image"
      : "image_link";
  }

  if (videoExtensions.has(extension)) {
    return "video_link";
  }

  if (audioExtensions.has(extension)) {
    return "audio_link";
  }

  if (documentExtensions.has(extension)) {
    return "document_link";
  }

  return "unknown_link";
}

function getWindows1252Bytes(value: string): number[] | undefined {
  const bytes: number[] = [];

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      return undefined;
    }

    if (codePoint <= 0xff) {
      bytes.push(codePoint);
      continue;
    }

    const mappedByte = windows1252SpecialBytes.get(codePoint);
    if (mappedByte === undefined) {
      return undefined;
    }

    bytes.push(mappedByte);
  }

  return bytes;
}

function getUtf8SequenceLength(bytes: number[], index: number): number {
  const first = bytes[index];
  const second = bytes[index + 1];

  if (first >= 0xc2 && first <= 0xdf) {
    return second >= 0x80 && second <= 0xbf ? 2 : 0;
  }

  const third = bytes[index + 2];
  if (first >= 0xe0 && first <= 0xef) {
    const secondIsValid =
      second >= 0x80 &&
      second <= 0xbf &&
      (first !== 0xe0 || second >= 0xa0) &&
      (first !== 0xed || second <= 0x9f);

    return secondIsValid && third >= 0x80 && third <= 0xbf ? 3 : 0;
  }

  const fourth = bytes[index + 3];
  if (first >= 0xf0 && first <= 0xf4) {
    const secondIsValid =
      second >= 0x80 &&
      second <= 0xbf &&
      (first !== 0xf0 || second >= 0x90) &&
      (first !== 0xf4 || second <= 0x8f);

    return secondIsValid &&
      third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
      ? 4
      : 0;
  }

  return 0;
}

function countMojibakeIndicators(value: string): number {
  const bytes = getWindows1252Bytes(value);
  if (!bytes) {
    return 0;
  }

  let count = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const sequenceLength = getUtf8SequenceLength(bytes, index);
    if (sequenceLength > 0) {
      count += 1;
      index += sequenceLength - 1;
    }
  }

  return count;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function isPrintableUnicode(value: string): boolean {
  if (!value || value.includes("\uFFFD") || containsUnpairedSurrogate(value)) {
    return false;
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      return false;
    }
  }

  return true;
}

function repairUtf8Mojibake(value: string): string | undefined {
  const originalIndicatorCount = countMojibakeIndicators(value);
  if (originalIndicatorCount === 0) {
    return undefined;
  }

  const bytes = getWindows1252Bytes(value);
  if (!bytes) {
    return undefined;
  }

  let repaired: string;
  try {
    repaired = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }

  if (
    !isPrintableUnicode(repaired) ||
    countMojibakeIndicators(repaired) >= originalIndicatorCount
  ) {
    return undefined;
  }

  return repaired;
}

function getSafeAttachmentExtension(value: string): string | undefined {
  return value.match(/\.([A-Za-z0-9]{1,10})$/)?.[0];
}

function truncateAttachmentDisplayName(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= maxAttachmentDisplayNameCharacters) {
    return value;
  }

  const extension = getSafeAttachmentExtension(value);
  if (!extension) {
    return characters.slice(0, maxAttachmentDisplayNameCharacters).join("");
  }

  const baseName = value.slice(0, -extension.length);
  const baseLimit = maxAttachmentDisplayNameCharacters - Array.from(extension).length;
  return `${Array.from(baseName).slice(0, Math.max(baseLimit, 0)).join("")}${extension}`;
}

export function getAttachmentDisplayName(name: string | undefined, category: WorkflowAttachmentCategory): string {
  const fallbackByCategory: Record<WorkflowAttachmentCategory, string> = {
    native_image: "圖片附件",
    image_link: "圖片附件",
    video_link: "影片附件",
    audio_link: "音訊附件",
    document_link: "文件附件",
    unknown_link: "附件"
  };

  if (!name) {
    return fallbackByCategory[category];
  }

  const lastPathSegment = name.split(/[\\/]/).at(-1) ?? "";
  const originalIndicatorCount = countMojibakeIndicators(lastPathSegment);
  const repaired = repairUtf8Mojibake(lastPathSegment);
  const fallbackExtension = getSafeAttachmentExtension(lastPathSegment) ?? "";

  if (originalIndicatorCount > 0 && !repaired) {
    return `${fallbackByCategory[category]}${fallbackExtension}`;
  }

  const sanitized = (repaired ?? lastPathSegment)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!isPrintableUnicode(sanitized)) {
    return `${fallbackByCategory[category]}${fallbackExtension}`;
  }

  return truncateAttachmentDisplayName(sanitized);
}

function normalizeAttachmentObject(value: Record<string, unknown>): NormalizedWorkflowAttachment | undefined {
  const rawUrl = value.url;

  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return undefined;
  }

  validatePublicHttpsUrl(rawUrl, "Attachment URL");
  const rawName = typeof value.name === "string" && value.name.trim().length > 0
    ? value.name
    : undefined;
  const size = typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0
    ? value.size
    : undefined;
  const category = getAttachmentCategory(rawName, size);

  return {
    url: rawUrl,
    displayName: getAttachmentDisplayName(rawName, category),
    ...(size !== undefined ? { size } : {}),
    category
  };
}

export function normalizeWorkflowAttachments(payload: Record<string, unknown>): NormalizedWorkflowAttachment[] {
  const normalized: NormalizedWorkflowAttachment[] = [];

  for (const alias of attachmentAliases) {
    const rawValue = getActionField(payload, alias);
    const candidates = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const candidate of candidates) {
      if (!isPlainRecord(candidate)) {
        continue;
      }

      const attachment = normalizeAttachmentObject(candidate);
      if (!attachment) {
        continue;
      }

      if (normalized.length >= maxWorkflowAttachments) {
        throw new WorkflowLineMessageValidationError(
          `A maximum of ${maxWorkflowAttachments} attachments is supported`
        );
      }

      normalized.push(attachment);
    }
  }

  return normalized;
}

function summarizeWorkflowAttachments(
  attachments: NormalizedWorkflowAttachment[]
): WorkflowAttachmentSummary {
  const summary: WorkflowAttachmentSummary = {
    attachmentCount: attachments.length,
    nativeImageCount: 0,
    imageLinkCount: 0,
    videoLinkCount: 0,
    audioLinkCount: 0,
    documentLinkCount: 0,
    unknownLinkCount: 0
  };

  for (const attachment of attachments) {
    if (attachment.category === "native_image") {
      summary.nativeImageCount += 1;
    } else if (attachment.category === "image_link") {
      summary.imageLinkCount += 1;
    } else if (attachment.category === "video_link") {
      summary.videoLinkCount += 1;
    } else if (attachment.category === "audio_link") {
      summary.audioLinkCount += 1;
    } else if (attachment.category === "document_link") {
      summary.documentLinkCount += 1;
    } else {
      summary.unknownLinkCount += 1;
    }
  }

  return summary;
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
    const attachments = normalizeWorkflowAttachments(payload);

    if (text && text.length > lineTextMaxCharacters) {
      throw new WorkflowLineMessageValidationError(`Message must be ${lineTextMaxCharacters} characters or fewer`);
    }

    if (attachments.length > 0) {
      const outputMessageCount = attachments.length + (text ? 1 : 0);

      if (outputMessageCount > maxWorkflowAttachmentLineMessages) {
        throw new WorkflowLineMessageValidationError(
          `Workflow text and attachments must produce no more than ${maxWorkflowAttachmentLineMessages} LINE messages`
        );
      }

      return {
        type: "attachments",
        ...(text ? { text } : {}),
        attachments,
        attachmentSummary: summarizeWorkflowAttachments(attachments),
        inputPresence
      };
    }

    if (!text) {
      throw new WorkflowLineMessageValidationError("Message is required");
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
