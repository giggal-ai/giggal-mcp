import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * Compact signed tokens used for two things:
 *  1. Login handoff — backend mints a token after Clerk auth, browser passes
 *     it to mcp-service via ?mcp_login_token=… so mcp-service knows who the
 *     user is without needing Clerk SDK.
 *  2. Session cookie — mcp-service issues its own signed cookie so consent
 *     survives the POST /oauth/authorize round-trip.
 *
 * Both use HMAC-SHA256 with the shared secret. Not full JWTs — no header
 * negotiation, no algorithm agility. Just `payloadJson.base64url.hmac`.
 */

interface Payload {
  user_id: string;
  exp: number; // unix seconds
}

const SESSION_TTL_SECONDS = 15 * 60; // 15 min — enough for consent flow
const HANDOFF_TTL_SECONDS = 60; // 1 min — one round-trip

// ── mint ──────────────────────────────────────────────────────────────────

export function mintSessionToken(userId: string, secret: string): string {
  return mint(userId, secret, SESSION_TTL_SECONDS);
}

/**
 * Backend uses this shape too (via the shared MCP_SERVICE_BACKEND_TOKEN).
 * Exported for symmetry — the backend copy is in its own file, but they
 * must produce byte-identical outputs.
 */
export function mintHandoffToken(userId: string, secret: string): string {
  return mint(userId, secret, HANDOFF_TTL_SECONDS);
}

function mint(userId: string, secret: string, ttlSeconds: number): string {
  const payload: Payload = {
    user_id: userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

// ── verify ────────────────────────────────────────────────────────────────

export function verifyToken(token: string, secret: string): Payload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts as [string, string];

  const expected = createHmac("sha256", secret).update(b64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.user_id !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ── shared secret accessors ───────────────────────────────────────────────

/** The secret used to verify handoff tokens minted by backend. */
export function handoffSecret(): string {
  return config.MCP_SERVICE_BACKEND_TOKEN;
}

/** Session-cookie signing secret — separate concern, kept distinct. */
export function sessionSecret(): string {
  return config.SESSION_SECRET;
}
