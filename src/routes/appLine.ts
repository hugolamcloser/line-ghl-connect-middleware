import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { requireSharedSecret } from "../middleware/sharedSecret";
import {
  connectLineChannel,
  disconnectLineChannel,
  getLineConnectionSettings
} from "../services/lineConnectionService";
import { appLinePageRouter } from "./appLinePage";

const locationBodySchema = z.object({
  locationId: z.string().min(1)
});

const connectBodySchema = z
  .object({
    locationId: z.string().min(1),
    channelAccessToken: z.string().min(1).optional(),
    channel_access_token: z.string().min(1).optional(),
    channelSecret: z.string().min(1).optional(),
    channel_secret: z.string().min(1).optional()
  })
  .transform((input) => ({
    locationId: input.locationId,
    channelAccessToken: input.channelAccessToken ?? input.channel_access_token,
    channelSecret: input.channelSecret ?? input.channel_secret
  }))
  .pipe(
    z.object({
      locationId: z.string().min(1),
      channelAccessToken: z.string().min(1),
      channelSecret: z.string().min(1)
    })
  );

export const appLineRouter = Router();

appLineRouter.use(appLinePageRouter);

function getPublicBaseUrl(req: Request): string {
  if (env.PUBLIC_BASE_URL) {
    return env.PUBLIC_BASE_URL;
  }

  return `${req.protocol}://${req.get("host")}`;
}

function getQueryLocationId(req: Request): string {
  const parsed = z.object({ locationId: z.string().min(1) }).parse(req.query);
  return parsed.locationId;
}

appLineRouter.get("/app/line/settings", requireSharedSecret, async (req, res, next) => {
  try {
    const settings = await getLineConnectionSettings({
      locationId: getQueryLocationId(req),
      publicBaseUrl: getPublicBaseUrl(req)
    });

    res.json(settings);
  } catch (error) {
    next(error);
  }
});

appLineRouter.post("/app/line/connect", requireSharedSecret, async (req, res, next) => {
  try {
    const input = connectBodySchema.parse(req.body);
    const settings = await connectLineChannel({
      locationId: input.locationId,
      channelAccessToken: input.channelAccessToken,
      channelSecret: input.channelSecret,
      publicBaseUrl: getPublicBaseUrl(req)
    });

    res.json(settings);
  } catch (error) {
    next(error);
  }
});

appLineRouter.post("/app/line/disconnect", requireSharedSecret, async (req, res, next) => {
  try {
    const input = locationBodySchema.parse(req.body);
    const settings = await disconnectLineChannel({
      locationId: input.locationId,
      publicBaseUrl: getPublicBaseUrl(req)
    });

    res.json(settings);
  } catch (error) {
    next(error);
  }
});
