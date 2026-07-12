import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { verifyGhlWebhookSignature } from "../middleware/ghlWebhookSignature";
import { HttpError } from "../middleware/errors";
import { recordGhlAppInstall } from "../services/ghlOAuthService";
import type { RawBodyRequest } from "../types/http";

const appInstallSchema = z.object({
  type: z.literal("INSTALL"),
  appId: z.string().trim().min(1),
  companyId: z.string().trim().min(1),
  locationId: z.string().trim().min(1),
  webhookId: z.string().trim().min(1).optional(),
  webhook_id: z.string().trim().min(1).optional(),
  timestamp: z.union([z.string(), z.number()]).optional()
}).passthrough();

export const ghlAppInstallWebhookRouter = Router();

function getDeliveryKey(req: RawBodyRequest, payload: z.infer<typeof appInstallSchema>): string {
  const webhookId = payload.webhookId ?? payload.webhook_id ??
    req.header("x-ghl-webhook-id") ?? req.header("x-webhook-id");

  if (webhookId?.trim()) {
    return `webhook:${webhookId.trim()}`;
  }

  return `sha256:${crypto.createHash("sha256").update(req.rawBody ?? Buffer.alloc(0)).digest("hex")}`;
}

ghlAppInstallWebhookRouter.post("/webhooks/ghl/app-install", async (req: RawBodyRequest, res, next) => {
  try {
    if (!req.rawBody) {
      throw new HttpError(400, "Raw webhook body is required");
    }

    const signatureValid = verifyGhlWebhookSignature({
      rawBody: req.rawBody,
      ghlSignature: req.header("x-ghl-signature") ?? undefined,
      legacySignature: req.header("x-wh-signature") ?? undefined
    });

    if (!signatureValid) {
      throw new HttpError(401, "Invalid HighLevel webhook signature");
    }

    const parsed = appInstallSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new HttpError(400, "Invalid HighLevel AppInstall payload", parsed.error.flatten());
    }

    if (!env.GHL_MARKETPLACE_APP_ID || parsed.data.appId !== env.GHL_MARKETPLACE_APP_ID) {
      logger.warn(
        {
          eventType: parsed.data.type,
          appId: parsed.data.appId,
          companyId: parsed.data.companyId,
          locationId: parsed.data.locationId,
          configuredAppIdPresent: Boolean(env.GHL_MARKETPLACE_APP_ID)
        },
        "Ignoring HighLevel AppInstall for an unconfigured appId"
      );
      res.status(202).json({ ok: true, ignored: true, reason: "app_id_mismatch" });
      return;
    }

    const result = await recordGhlAppInstall({
      appId: parsed.data.appId,
      companyId: parsed.data.companyId,
      locationId: parsed.data.locationId,
      deliveryKey: getDeliveryKey(req, parsed.data)
    });

    logger.info(
      {
        eventType: parsed.data.type,
        appId: parsed.data.appId,
        companyId: parsed.data.companyId,
        locationId: parsed.data.locationId,
        tenantId: result.tenant_id,
        status: result.status,
        failedLocationIds: result.failed_location_ids
      },
      "Processed HighLevel AppInstall webhook"
    );

    const statusCode = result.status === "pending_app_install" ? 202 : result.status === "failed" ? 502 : 200;
    res.status(statusCode).json({
      ok: result.status !== "failed",
      status: result.status,
      app_id: parsed.data.appId,
      company_id: parsed.data.companyId,
      location_id: parsed.data.locationId,
      tenant_id: result.tenant_id,
      locations: result.locations,
      failed_location_ids: result.failed_location_ids
    });
  } catch (error) {
    next(error);
  }
});
