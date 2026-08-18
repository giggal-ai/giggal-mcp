import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  MONGODB_URI: z.string().min(1),

  BACKEND_INTERNAL_URL: z
    .string()
    .refine(
      (v) => v === "mock://" || /^https?:\/\//.test(v),
      "must be http(s):// URL or the literal 'mock://'"
    ),
  MCP_SERVICE_BACKEND_TOKEN: z.string().min(16, "shared token must be at least 16 chars"),

  OAUTH_ISSUER: z.string().url(),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  OAUTH_AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 chars"),
  SESSION_COOKIE_NAME: z.string().default("tp_mcp_sess"),
  SESSION_COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  ALLOWED_CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),

  LOGIN_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid env config:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
