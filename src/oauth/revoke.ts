import type { FastifyInstance } from "fastify";
import { revokeAccessToken, revokeRefreshToken } from "./tokens.js";

/**
 * POST /oauth/revoke — RFC 7009 token revocation.
 *
 * Per spec, we always return 200 OK regardless of whether the token
 * existed. This prevents attackers from probing for valid tokens.
 * We accept both access and refresh tokens; the `token_type_hint`
 * parameter is a hint only.
 */
export function registerRevokeRoute(app: FastifyInstance): void {
  app.post("/oauth/revoke", async (req, reply) => {
    const body = req.body as { token?: string; token_type_hint?: string };
    const raw = body.token;

    if (raw) {
      // Try the hinted type first; fall back to the other.
      if (body.token_type_hint === "refresh_token") {
        if (!(await revokeRefreshToken(raw))) await revokeAccessToken(raw);
      } else {
        if (!(await revokeAccessToken(raw))) await revokeRefreshToken(raw);
      }
    }

    // Always 200 per RFC 7009 §2.2 — no info leak about validity.
    return reply.code(200).send({});
  });
}
