import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { HttpError } from "../middleware/errors";
import { exchangeGhlAuthorizationCode, GhlOAuthError } from "../services/ghlOAuthService";
import { serializeError } from "../utils/errors";
import { redactSecrets } from "../utils/redaction";

const oauthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional()
});

export const oauthRouter = Router();

function getOAuthFailureStatus(error: GhlOAuthError): number {
  if (
    error.publicErrorCode === "oauth_missing_location_id" ||
    error.publicErrorCode === "oauth_missing_company_id" ||
    error.publicErrorCode === "oauth_missing_installed_locations" ||
    error.publicErrorCode === "oauth_app_id_mismatch"
  ) {
    return 400;
  }

  if (error.publicErrorCode === "oauth_storage_failed" || error.publicErrorCode === "oauth_missing_marketplace_app_id") {
    return 500;
  }

  return 502;
}

oauthRouter.get("/oauth/callback", async (req, res, next) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;

  logger.info(
    {
      codePresent: Boolean(code),
      codeLength: code?.length ?? 0,
      tokenUrl: env.GHL_OAUTH_TOKEN_URL,
      redirectUri: env.GHL_OAUTH_REDIRECT_URI,
      clientIdPresent: Boolean(env.GHL_OAUTH_CLIENT_ID),
      clientSecretPresent: Boolean(env.GHL_OAUTH_CLIENT_SECRET)
    },
    "HighLevel OAuth callback reached"
  );

  try {
    const parsed = oauthCallbackSchema.safeParse(req.query);

    if (!parsed.success) {
      logger.warn({ codePresent: false }, "HighLevel OAuth callback missing authorization code");
      throw new HttpError(400, "Missing GHL OAuth authorization code", parsed.error.flatten());
    }

    const status = await exchangeGhlAuthorizationCode(parsed.data.code);
    logger.info({ oauth: status }, "HighLevel OAuth callback completed successfully");

    res.json({
      ok: true,
      installed: true,
      state: parsed.data.state,
      oauth: status
    });
  } catch (error) {
    if (error instanceof GhlOAuthError) {
      logger.error(
        {
          codePresent: Boolean(code),
          error: redactSecrets(serializeError(error)),
          publicErrorCode: error.publicErrorCode,
          statusCode: error.statusCode,
          responseBody: error.responseBody
        },
        "HighLevel OAuth callback failed"
      );

      res.status(getOAuthFailureStatus(error)).json({
        ok: false,
        error: error.publicErrorCode,
        message: error.message,
        status: error.statusCode,
        response_body: error.responseBody
      });
      return;
    }

    if (!(error instanceof HttpError)) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        {
          codePresent: Boolean(code),
          error: redactSecrets(serializeError(error))
        },
        "Unexpected HighLevel OAuth callback failure"
      );

      res.status(500).json({
        ok: false,
        error: "oauth_storage_failed",
        message
      });
      return;
    }

    next(error);
  }
});
