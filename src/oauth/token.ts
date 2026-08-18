import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcrypt";
import { z } from "zod";
import { authCodes, clients, refreshTokens, type McpClient } from "../db/models.js";
import { sha256Hex } from "../util/crypto.js";
import { verifyPkce } from "./pkce.js";
import { issueTokenPair, revokeRefreshChain } from "./tokens.js";
import { OAuthError } from "./errors.js";

/**
 * POST /oauth/token
 *
 * Handles two grant types:
 *   - authorization_code — exchange a fresh code for an access + refresh pair
 *   - refresh_token      — rotate a refresh token for a new pair
 *
 * Client auth is one of: `client_secret_post` (in body), `client_secret_basic`
 * (Authorization header), or `none` (PKCE-only public client).
 */

const CodeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  code_verifier: z.string().min(43).max(128),
});

const RefreshGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
});

export function registerTokenRoute(app: FastifyInstance): void {
  app.post("/oauth/token", async (req, reply) => {
    const body = req.body as Record<string, string>;
    const clientCreds = extractClientCreds(req, body);
    const client = await authenticateClient(clientCreds);

    // Dispatch by grant_type
    switch (body.grant_type) {
      case "authorization_code": {
        const parsed = CodeGrantSchema.safeParse({ ...body, client_id: client.client_id });
        if (!parsed.success) {
          throw new OAuthError("invalid_request", formatZod(parsed.error));
        }
        const tokens = await handleCodeGrant(client, parsed.data);
        return reply.send(tokens);
      }
      case "refresh_token": {
        const parsed = RefreshGrantSchema.safeParse({ ...body, client_id: client.client_id });
        if (!parsed.success) {
          throw new OAuthError("invalid_request", formatZod(parsed.error));
        }
        const tokens = await handleRefreshGrant(client, parsed.data);
        return reply.send(tokens);
      }
      default:
        throw new OAuthError(
          "unsupported_grant_type",
          `grant_type '${body.grant_type ?? "(missing)"}' is not supported`
        );
    }
  });
}

// ── Grant handlers ────────────────────────────────────────────────────────

async function handleCodeGrant(
  client: McpClient,
  args: z.infer<typeof CodeGrantSchema>
) {
  const codeHash = sha256Hex(args.code);

  // Atomically mark the code as used. If it was already used or expired,
  // findOneAndUpdate returns null and we reject the exchange.
  const now = new Date();
  const doc = await authCodes().findOneAndUpdate(
    {
      code_hash: codeHash,
      used_at: null,
      expires_at: { $gt: now },
    },
    { $set: { used_at: now } },
    { returnDocument: "before" }
  );

  if (!doc) {
    throw new OAuthError("invalid_grant", "code is invalid, expired, or already used");
  }

  if (doc.client_id !== client.client_id) {
    throw new OAuthError("invalid_grant", "code was issued to a different client");
  }
  if (doc.redirect_uri !== args.redirect_uri) {
    throw new OAuthError("invalid_grant", "redirect_uri does not match the one used at authorize");
  }
  if (!verifyPkce(args.code_verifier, doc.code_challenge, doc.code_challenge_method)) {
    throw new OAuthError("invalid_grant", "PKCE code_verifier does not match code_challenge");
  }

  return issueTokenPair({
    client_id: client.client_id,
    user_id: doc.user_id,
    scopes: doc.scopes,
  });
}

async function handleRefreshGrant(
  client: McpClient,
  args: z.infer<typeof RefreshGrantSchema>
) {
  const hash = sha256Hex(args.refresh_token);
  const now = new Date();
  const doc = await refreshTokens().findOne({ token_hash: hash });

  if (!doc) {
    throw new OAuthError("invalid_grant", "refresh token not recognised");
  }
  if (doc.client_id !== client.client_id) {
    throw new OAuthError("invalid_grant", "refresh token was issued to a different client");
  }

  // Stolen-token defence: if this token was already revoked, someone is
  // reusing it. Revoke the whole chain so the attacker's fresh tokens die too.
  if (doc.revoked_at !== null) {
    await revokeRefreshChain(doc._id!);
    throw new OAuthError("invalid_grant", "refresh token was already used");
  }
  if (doc.expires_at <= now) {
    throw new OAuthError("invalid_grant", "refresh token expired");
  }

  // Optional scope downgrade — client can ask for a narrower scope on refresh
  // but never wider. We only have one scope right now, so this is a no-op,
  // but the check protects future expansion.
  const requested = args.scope ? args.scope.split(" ").filter(Boolean) : doc.scopes;
  for (const s of requested) {
    if (!doc.scopes.includes(s)) {
      throw new OAuthError("invalid_scope", `cannot widen scope to '${s}' on refresh`);
    }
  }

  // Rotate: revoke this refresh token and issue a new pair pointing at it.
  await refreshTokens().updateOne({ _id: doc._id }, { $set: { revoked_at: now } });

  return issueTokenPair({
    client_id: client.client_id,
    user_id: doc.user_id,
    scopes: requested,
    parent_refresh_id: doc._id!,
  });
}

// ── Client auth ───────────────────────────────────────────────────────────

interface ClientCreds {
  client_id: string;
  client_secret: string | null;
}

function extractClientCreds(req: FastifyRequest, body: Record<string, string>): ClientCreds {
  // Try Authorization: Basic first
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const [id, ...rest] = decoded.split(":");
      const secret = rest.join(":");
      if (id) {
        return { client_id: decodeURIComponent(id), client_secret: decodeURIComponent(secret) };
      }
    } catch {
      // fall through to body-based auth
    }
  }

  // client_secret_post — creds in body
  if (body.client_id) {
    return {
      client_id: body.client_id,
      client_secret: body.client_secret ?? null,
    };
  }

  throw new OAuthError("invalid_client", "missing client credentials", 401);
}

async function authenticateClient(creds: ClientCreds): Promise<McpClient> {
  const client = await clients().findOne({ client_id: creds.client_id });
  if (!client) {
    throw new OAuthError("invalid_client", "unknown client_id", 401);
  }

  // Public clients (auth_method=none) don't have a secret. Their security
  // comes entirely from PKCE.
  if (client.token_endpoint_auth_method === "none") {
    if (creds.client_secret) {
      // Client claims to be public but is sending a secret — reject as misconfig.
      throw new OAuthError(
        "invalid_client",
        "client is public and must not send client_secret",
        401
      );
    }
    return client;
  }

  // Confidential client — verify bcrypt hash.
  if (!creds.client_secret || !client.client_secret_hash) {
    throw new OAuthError("invalid_client", "missing client_secret", 401);
  }
  const ok = await bcrypt.compare(creds.client_secret, client.client_secret_hash);
  if (!ok) {
    throw new OAuthError("invalid_client", "invalid client_secret", 401);
  }
  return client;
}

// ── Utility ────────────────────────────────────────────────────────────────

function formatZod(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
