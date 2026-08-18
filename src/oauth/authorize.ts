import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { authCodes, clients } from "../db/models.js";
import { randomToken, sha256Hex } from "../util/crypto.js";
import { isValidChallenge } from "./pkce.js";
import { getUserId, loginRedirectUrl, setSessionCookie } from "./session.js";
import { verifyToken, handoffSecret } from "./loginToken.js";
import { OAuthError } from "./errors.js";

/**
 * GET /oauth/authorize — user-facing consent screen + authorization code issuance.
 *
 * Flow:
 *   1. Client redirects user's browser here with query params
 *   2. If user isn't logged into Giggal.ai → redirect to LOGIN_URL
 *   3. If GET → render simple consent HTML with Allow / Deny buttons
 *   4. POST /oauth/authorize with `decision=allow` → issue code, redirect back to client
 *   5. POST /oauth/authorize with `decision=deny` → redirect back with error
 */

const QuerySchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
  state: z.string().max(500).optional(),
  scope: z.string().optional(),
});

type AuthorizeQuery = z.infer<typeof QuerySchema>;

export function registerAuthorizeRoute(app: FastifyInstance): void {
  app.get("/oauth/authorize", async (req, reply) => {
    const params = parseAuthorizeParams(req.query);

    // Handoff-token exchange — if the frontend just bounced the user back
    // with `?mcp_login_token=…`, verify it, set our session cookie, then
    // redirect to the same URL WITHOUT the token so it can't be replayed
    // out of the browser history.
    const rawToken = (req.query as { mcp_login_token?: string } | undefined)?.mcp_login_token;
    if (typeof rawToken === "string" && rawToken.length > 0) {
      const payload = verifyToken(rawToken, handoffSecret());
      if (payload) {
        setSessionCookie(reply, payload.user_id);
        // Strip the token from the URL and continue the flow
        const clean = new URL(`${config.OAUTH_ISSUER}${req.url}`);
        clean.searchParams.delete("mcp_login_token");
        return reply.redirect(clean.toString().slice(config.OAUTH_ISSUER.length));
      }
      // Invalid or expired handoff — fall through and let the user re-auth.
    }

    // Fetch client + validate redirect_uri BEFORE trusting anything from the request.
    const client = await clients().findOne({ client_id: params.client_id });
    if (!client) {
      // Per RFC 6749 §4.1.2.1, when client_id is invalid we MUST NOT redirect —
      // we render an error page instead.
      return reply
        .code(400)
        .type("text/html")
        .send(renderErrorPage("Unknown client. Contact the app that sent you here."));
    }
    if (!client.redirect_uris.includes(params.redirect_uri)) {
      return reply
        .code(400)
        .type("text/html")
        .send(renderErrorPage("Invalid redirect_uri for this client."));
    }
    if (!isValidChallenge(params.code_challenge)) {
      return redirectWithError(reply, params, "invalid_request", "malformed code_challenge");
    }

    // Auth check — must be logged into Giggal.ai to grant consent.
    const userId = getUserId(req);
    if (!userId) {
      const returnTo = `${config.OAUTH_ISSUER}${req.url}`;
      return reply.redirect(loginRedirectUrl(returnTo));
    }

    return reply.type("text/html").send(
      renderConsentPage({
        client_name: client.client_name,
        scopes: client.scopes,
        // Everything the browser needs to POST back to us
        formAction: `${config.OAUTH_ISSUER}/oauth/authorize`,
        params,
      })
    );
  });

  app.post("/oauth/authorize", async (req, reply) => {
    const body = req.body as Record<string, string | undefined>;
    const params = parseAuthorizeParams(body);
    const decision = body.decision;

    const client = await clients().findOne({ client_id: params.client_id });
    if (!client || !client.redirect_uris.includes(params.redirect_uri)) {
      return reply
        .code(400)
        .type("text/html")
        .send(renderErrorPage("Client or redirect_uri no longer valid."));
    }

    const userId = getUserId(req);
    if (!userId) {
      return reply
        .code(401)
        .type("text/html")
        .send(renderErrorPage("Not signed in."));
    }

    if (decision !== "allow") {
      return redirectWithError(reply, params, "access_denied", "user denied consent");
    }

    // Issue a fresh authorization code. Raw code goes to client via redirect;
    // we only persist the hash.
    const codeRaw = randomToken("ac", 32);
    const now = new Date();
    await authCodes().insertOne({
      code_hash: sha256Hex(codeRaw),
      client_id: params.client_id,
      user_id: userId,
      redirect_uri: params.redirect_uri,
      scopes: client.scopes,
      code_challenge: params.code_challenge,
      code_challenge_method: "S256",
      expires_at: new Date(now.getTime() + config.OAUTH_AUTH_CODE_TTL_SECONDS * 1000),
      used_at: null,
      created_at: now,
    });

    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set("code", codeRaw);
    if (params.state) redirect.searchParams.set("state", params.state);
    return reply.redirect(redirect.toString());
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseAuthorizeParams(raw: unknown): AuthorizeQuery {
  const parsed = QuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new OAuthError(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }
  return parsed.data;
}

function redirectWithError(
  reply: import("fastify").FastifyReply,
  params: AuthorizeQuery,
  error: string,
  description: string
) {
  const u = new URL(params.redirect_uri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (params.state) u.searchParams.set("state", params.state);
  return reply.redirect(u.toString());
}

// ── HTML rendering — deliberately minimal, no framework overhead ──────────

interface ConsentPageArgs {
  client_name: string;
  scopes: string[];
  formAction: string;
  params: AuthorizeQuery;
}

function renderConsentPage(args: ConsentPageArgs): string {
  const hidden = (name: string, value: string | undefined) =>
    value === undefined
      ? ""
      : `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

  const scopeItems = args.scopes
    .map((s) => `<li><code>${escapeHtml(s)}</code> — ${scopeDescription(s)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(args.client_name)} — Giggal.ai</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; max-width: 460px; margin: 60px auto; padding: 0 20px; color: #111; }
  .brand { text-align: center; margin-bottom: 24px; }
  .brand img { max-width: 200px; height: auto; }
  .tagline { color: #6b7280; font-size: 13px; margin-top: 8px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .sub { color: #666; margin: 0 0 24px; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; }
  ul { padding-left: 20px; margin: 12px 0 24px; }
  li { margin: 6px 0; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 14px; }
  .buttons { display: flex; gap: 8px; margin-top: 24px; }
  button { flex: 1; padding: 12px; border-radius: 8px; border: 0; font-size: 15px; font-weight: 500; cursor: pointer; }
  .primary { background: #10b981; color: #fff; }
  .primary:hover { background: #059669; }
  .secondary { background: #f3f4f6; color: #374151; }
  .secondary:hover { background: #e5e7eb; }
  .foot { color: #9ca3af; font-size: 13px; margin-top: 20px; text-align: center; }
</style>
</head>
<body>
<div class="brand">
  <img src="/assets/logo.png" alt="Giggal.ai">
  <div class="tagline">Verify Catch-All, Risky &amp; SEG-Protected Emails</div>
</div>
<div class="card">
  <h1>Allow ${escapeHtml(args.client_name)} to access Giggal.ai?</h1>
  <p class="sub">This app is asking to:</p>
  <ul>${scopeItems}</ul>
  <form method="POST" action="${escapeHtml(args.formAction)}">
    ${hidden("response_type", args.params.response_type)}
    ${hidden("client_id", args.params.client_id)}
    ${hidden("redirect_uri", args.params.redirect_uri)}
    ${hidden("code_challenge", args.params.code_challenge)}
    ${hidden("code_challenge_method", args.params.code_challenge_method)}
    ${hidden("state", args.params.state)}
    ${hidden("scope", args.params.scope)}
    <div class="buttons">
      <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
      <button class="primary" type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>
  <p class="foot">You can revoke access anytime in your Giggal.ai settings.</p>
</div>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Error — Giggal.ai</title>
<style>body{font:16px/1.5 sans-serif;max-width:460px;margin:60px auto;padding:0 20px;text-align:center;}</style>
</head><body><h1>Something went wrong</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function scopeDescription(scope: string): string {
  switch (scope) {
    case "verify:read":
      return "verify email addresses, check your credit balance, and look up past verifications";
    default:
      return escapeHtml(scope);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
