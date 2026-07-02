import { Router } from "express";
import { getEnvPresenceReport } from "../config/env";
import { getRecentDebugEvents } from "../services/repository";

export const debugRouter = Router();

debugRouter.get("/debug/env-check", (_req, res) => {
  res.json({
    ok: true,
    environment: getEnvPresenceReport()
  });
});

debugRouter.get("/debug/recent-events", async (_req, res, next) => {
  try {
    const events = await getRecentDebugEvents();
    res.json({
      ok: true,
      ...events
    });
  } catch (error) {
    next(error);
  }
});
