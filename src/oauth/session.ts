import type { FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { mintSessionToken, sessionSecret, verifyToken } from "./loginToken.js";

/**
 * MCP consent-flow session — HMAC-signed cookie that stores which
 * Giggal.ai user has authenticated at the consent screen.
 *
 * The cookie is set by /oauth/authorize after it receives a valid
 * `mcp_login_token` handoff from the frontend (which itself only mints
 * after Clerk auth completes). No Clerk SDK is needed in mcp-service —
 * all trust flows through the shared MCP_SERVICE_BACKEND_TOKEN secret.
 */

export const SESSION_COOKIE = "tp_mcp_session";

/** Resolve the authenticated Giggal.ai user from a request. */
export function getUserId(req: FastifyRequest): string | null {
  // Dev-mode shortcuts — never active in prod builds.
  if (config.NODE_ENV !== "production") {
    const q = (req.query as { dev_user_id?: string } | undefined)?.dev_user_id;
    if (q) return q;
    const h = req.headers["x-dev-user-id"];
    if (typeof h === "string" && h.length > 0) return h;
  }

  // Normal path — signed session cookie set after handoff.
  const cookies = req.cookies as Record<string, string> | undefined;
  const raw = cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const payload = verifyToken(raw, sessionSecret());
  return payload?.user_id ?? null;
}

/** Set the signed session cookie for a user. */
export function setSessionCookie(reply: FastifyReply, userId: string): void {
  const token = mintSessionToken(userId, sessionSecret());
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60, // 15 min — matches session token TTL
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Build the URL we redirect unauthenticated users to. Frontend handles
 * Clerk login and then bounces back to `return_to` with a signed handoff
 * token in the URL.
 */
export function loginRedirectUrl(returnTo: string): string {
  const u = new URL(config.LOGIN_URL);
  u.searchParams.set("return_to", returnTo);
  return u.toString();
}
