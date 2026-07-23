import crypto from "node:crypto";
import { Router } from "express";
import { env } from "../config/env";
import { HttpError } from "../middleware/errors";
import { verifyGhlWebhookSignature } from "../middleware/ghlWebhookSignature";
import { processGhlOutboundWebhook } from "../services/ghlSyncService";
import { processGhlWorkflowSendLine, type WorkflowSendLineResponse } from "../services/ghlWorkflowActionService";
import type { RawBodyRequest } from "../types/http";

export const ghlWebhookRouter = Router();

function validateProviderSecret(headerValue: string | undefined): void {
  if (!env.GHL_CUSTOM_PROVIDER_SECRET) {
    return;
  }

  if (headerValue !== env.GHL_CUSTOM_PROVIDER_SECRET) {
    throw new HttpError(401, "Invalid GHL provider secret");
  }
}

function workflowActionResponse(
  status: WorkflowSendLineResponse["status"],
  error = "",
  lineMessageId: string | null = null
): WorkflowSendLineResponse {
  return {
    ok: status === "sent",
    status,
    provider: "line",
    lineMessageId,
    error
  };
}

function isValidWorkflowActionSecret(headerValue: string | undefined): boolean {
  if (!env.WEBHOOK_SHARED_SECRET || !headerValue) {
    return false;
  }

  const expected = Buffer.from(env.WEBHOOK_SHARED_SECRET);
  const actual = Buffer.from(headerValue);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function normalizeWorkflowRequestId(requestId: unknown): string | undefined {
  if (typeof requestId === "string") {
    return requestId;
  }

  if (typeof requestId === "number") {
    return String(requestId);
  }

  return undefined;
}

ghlWebhookRouter.post("/webhooks/ghl/workflows/send-line", async (req, res, next) => {
  try {
    if (!isValidWorkflowActionSecret(req.header("x-wincrm-webhook-secret"))) {
      res.status(401).json(workflowActionResponse("failed", "Unauthorized"));
      return;
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json(workflowActionResponse("failed", "Invalid workflow action payload"));
      return;
    }

    const result = await processGhlWorkflowSendLine(req.body as Record<string, unknown>, {
      requestId: normalizeWorkflowRequestId(req.id)
    });
    res.status(result.httpStatus).json(result.body);
  } catch (error) {
    next(error);
  }
});

ghlWebhookRouter.post(
  ["/webhooks/ghl", "/webhooks/ghl/outbound", "/webhooks/ghl/line/outbound"],
  async (req: RawBodyRequest, res, next) => {
    try {
      if (!req.rawBody) {
        throw new HttpError(400, "Raw provider callback body is required");
      }

      if (!verifyGhlWebhookSignature({
        rawBody: req.rawBody,
        ghlSignature: req.header("x-ghl-signature") ?? undefined
      })) {
        throw new HttpError(401, "Invalid HighLevel provider callback signature");
      }

      validateProviderSecret(req.header("x-provider-secret") ?? req.header("x-ghl-secret"));

      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new HttpError(400, "Invalid outbound webhook payload");
      }

      const result = await processGhlOutboundWebhook(req.body as Record<string, unknown>);
      res.json({ ok: true, result });
    } catch (error) {
      next(error);
    }
  }
);
