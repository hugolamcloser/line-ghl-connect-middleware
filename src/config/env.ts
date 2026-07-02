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
  GHL_API_VERSION: z.string().min(1).default("2021-07-28"),
  GHL_LOCATION_ID: z.string().default(""),
  GHL_CUSTOM_PROVIDER_ID: z.string().default(""),
  GHL_CUSTOM_PROVIDER_SECRET: z.string().default(""),
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
  "GHL_PRIVATE_INTEGRATION_TOKEN",
  "GHL_LOCATION_ID",
  "GHL_CUSTOM_PROVIDER_ID",
  "GHL_API_VERSION",
  "GHL_CUSTOM_PROVIDER_SECRET",
  "WEBHOOK_SHARED_SECRET"
] as const;

export type EnvCheckKey = (typeof envCheckKeys)[number];

export function getEnvPresenceReport(): Record<EnvCheckKey, "present" | "missing"> {
  return envCheckKeys.reduce(
    (report, key) => ({
      ...report,
      [key]: process.env[key]?.trim() ? "present" : "missing"
    }),
    {} as Record<EnvCheckKey, "present" | "missing">
  );
}

export function requireEnvValue(key: EnvCheckKey, value: string): string {
  if (!value.trim()) {
    throw new Error(`${key} is required`);
  }

  return value;
}
