import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  PUBLIC_BASE_URL: z.string().url().optional(),

  SUPABASE_URL: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),

  LINE_CHANNEL_SECRET: z.string().default(""),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().default(""),

  GHL_API_BASE_URL: z.string().url().default("https://services.leadconnectorhq.com"),
  GHL_PRIVATE_INTEGRATION_TOKEN: z.string().default(""),
  GHL_ALLOW_PRIVATE_TOKEN_FALLBACK: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  GHL_API_VERSION: z.string().min(1).default("2021-07-28"),
  GHL_LOCATION_ID: z.string().default(""),
  GHL_CUSTOM_PROVIDER_ID: z.string().default(""),
  GHL_CUSTOM_PROVIDER_SECRET: z.string().default(""),
  GHL_OAUTH_CLIENT_ID: z.string().default(""),
  GHL_OAUTH_CLIENT_SECRET: z.string().default(""),
  GHL_OAUTH_REDIRECT_URI: z.string().default(""),
  GHL_OAUTH_TOKEN_URL: z.string().url().default("https://services.leadconnectorhq.com/oauth/token"),
  GHL_LINE_USER_ID_FIELD_ID: z.string().default(""),
  GHL_LINE_DISPLAY_NAME_FIELD_ID: z.string().default(""),

  WEBHOOK_SHARED_SECRET: z.string().default("")
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${message}`);
}

export const env = parsed.data;

export const envCheckKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "GHL_LOCATION_ID",
  "GHL_CUSTOM_PROVIDER_ID",
  "GHL_API_VERSION",
  "GHL_OAUTH_CLIENT_ID",
  "GHL_OAUTH_CLIENT_SECRET",
  "GHL_OAUTH_REDIRECT_URI"
] as const;

export type EnvCheckKey = (typeof envCheckKeys)[number];

export const optionalEnvCheckKeys = [
  "GHL_PRIVATE_INTEGRATION_TOKEN",
  "GHL_CUSTOM_PROVIDER_SECRET",
  "WEBHOOK_SHARED_SECRET",
  "GHL_LINE_USER_ID_FIELD_ID",
  "GHL_LINE_DISPLAY_NAME_FIELD_ID"
] as const;

export type OptionalEnvCheckKey = (typeof optionalEnvCheckKeys)[number];
export type PresenceReport = Record<string, "present" | "missing">;

function getPresenceReport<T extends readonly string[]>(keys: T): Record<T[number], "present" | "missing"> {
  return keys.reduce(
    (report, key) => ({
      ...report,
      [key]: process.env[key]?.trim() ? "present" : "missing"
    }),
    {} as Record<T[number], "present" | "missing">
  );
}

export function getEnvPresenceReport(): {
  required: Record<EnvCheckKey, "present" | "missing">;
  optional: Record<OptionalEnvCheckKey, "present" | "missing">;
} {
  return {
    required: getPresenceReport(envCheckKeys),
    optional: getPresenceReport(optionalEnvCheckKeys)
  };
}

export function requireEnvValue(key: string, value: string): string {
  if (!value.trim()) {
    throw new Error(`${key} is required`);
  }

  return value;
}
