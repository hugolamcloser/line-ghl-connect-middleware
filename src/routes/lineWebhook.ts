import { Router } from "express";
import { z } from "zod";
import { logger } from "../config/logger";
import { HttpError } from "../middleware/errors";
import type { RawBodyRequest } from "../types/http";
import type { LineWebhookPayload } from "../types/line";
import { verifyLineSignature } from "../integrations/lineClient";
import { processLineWebhookEvent } from "../services/lineSyncService";
import { serializeError } from "../utils/errors";
import { redactSecrets } from "../utils/redaction";

const lineWebhookSchema = z.object({
  destination: z.string(),
  events: z.array(z.record(z.unknown()))
});

export const lineWebhookRouter = Router();

async function processLineEventsInBackground(payload: LineWebhookPayload): Promise<void> {
  for (const event of payload.events) {
    try {
      await processLineWebhookEvent(event);
    } catch (error) {
      logger.error(
        {
          lineUserId: "userId" in event.source ? event.source.userId : undefined,
          lineMessageId: event.message?.id,
          error: redactSecrets(serializeError(error))
        },
        "Unhandled LINE background processing error"
      );
    }
  }
}

lineWebhookRouter.post(["/webhooks/line", "/webhooks/line/inbound"], (req: RawBodyRequest, res, next) => {
  try {
    const signature = req.header("x-line-signature");

    if (!req.rawBody || !verifyLineSignature(req.rawBody, signature)) {
      throw new HttpError(401, "Invalid LINE signature");
    }

    const payload = lineWebhookSchema.parse(req.body) as LineWebhookPayload;
    logger.info({ eventCount: payload.events.length }, "LINE webhook accepted for background processing");
    res.json({ ok: true, accepted: true });
    void processLineEventsInBackground(payload);
  } catch (error) {
    next(error);
  }
});
