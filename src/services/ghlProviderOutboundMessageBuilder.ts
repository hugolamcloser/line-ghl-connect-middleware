import {
  getAttachmentDisplayName,
  validatePublicHttpsUrl,
  WorkflowLineMessageValidationError,
  type WorkflowAttachmentCategory
} from "./workflowLineMessageBuilder";
import { lineMaxMessagesPerPush, type LinePushMessage } from "../integrations/lineClient";

export type GhlProviderOutboundLinePlan = {
  messages: LinePushMessage[];
  textPresent: boolean;
  attachmentCount: number;
  nativeImageCount: number;
  videoLinkCount: number;
  audioLinkCount: number;
  documentLinkCount: number;
  unknownLinkCount: number;
};

const lineTextMaxCharacters = 5_000;
const maxAttachmentUrlCharacters = 2_000;
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

function getExtension(url: URL): string {
  const finalSegment = url.pathname.split("/").at(-1) ?? "";
  const lastDotIndex = finalSegment.lastIndexOf(".");
  return lastDotIndex > 0 ? finalSegment.slice(lastDotIndex + 1).toLowerCase() : "";
}

function getCategory(extension: string): WorkflowAttachmentCategory {
  if (nativeImageExtensions.has(extension)) {
    return "native_image";
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

function getDisplayName(url: URL, category: WorkflowAttachmentCategory): string {
  const rawFinalSegment = url.pathname.split("/").at(-1) ?? "";
  let decodedFinalSegment: string | undefined;

  try {
    decodedFinalSegment = decodeURIComponent(rawFinalSegment);
  } catch {
    decodedFinalSegment = undefined;
  }

  return getAttachmentDisplayName(decodedFinalSegment, category);
}

export function buildGhlProviderOutboundLinePlan(input: {
  message?: string;
  attachments: unknown[];
}): GhlProviderOutboundLinePlan {
  const text = typeof input.message === "string" && input.message.trim().length > 0
    ? input.message
    : undefined;

  if (text && text.length > lineTextMaxCharacters) {
    throw new WorkflowLineMessageValidationError(
      `Message must be ${lineTextMaxCharacters} characters or fewer`
    );
  }

  const messages: LinePushMessage[] = text ? [{ type: "text", text }] : [];
  const summary = {
    nativeImageCount: 0,
    videoLinkCount: 0,
    audioLinkCount: 0,
    documentLinkCount: 0,
    unknownLinkCount: 0
  };

  for (const rawAttachment of input.attachments) {
    if (typeof rawAttachment !== "string" || rawAttachment.length === 0) {
      throw new WorkflowLineMessageValidationError("Provider attachment must be a non-empty HTTPS URL string");
    }

    if (rawAttachment.length > maxAttachmentUrlCharacters) {
      throw new WorkflowLineMessageValidationError(
        `Provider attachment URL must be ${maxAttachmentUrlCharacters} characters or fewer`
      );
    }

    const validated = validatePublicHttpsUrl(rawAttachment, "Attachment URL");
    const parsed = new URL(validated.url);
    const category = getCategory(getExtension(parsed));

    if (category === "native_image") {
      messages.push({
        type: "image",
        originalContentUrl: rawAttachment,
        previewImageUrl: rawAttachment
      });
      summary.nativeImageCount += 1;
    } else {
      messages.push({
        type: "text",
        text: `${getDisplayName(parsed, category)}\n${rawAttachment}`
      });

      if (category === "video_link") {
        summary.videoLinkCount += 1;
      } else if (category === "audio_link") {
        summary.audioLinkCount += 1;
      } else if (category === "document_link") {
        summary.documentLinkCount += 1;
      } else {
        summary.unknownLinkCount += 1;
      }
    }
  }

  if (messages.length === 0) {
    throw new WorkflowLineMessageValidationError(
      "Outbound provider callback must contain text or at least one attachment"
    );
  }

  if (messages.length > lineMaxMessagesPerPush) {
    throw new WorkflowLineMessageValidationError(
      `Outbound provider callback must produce no more than ${lineMaxMessagesPerPush} LINE messages`
    );
  }

  return {
    messages,
    textPresent: Boolean(text),
    attachmentCount: input.attachments.length,
    ...summary
  };
}
