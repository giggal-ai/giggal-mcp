import type { FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { z } from "zod";
import { clients } from "../db/models.js";
import { randomToken } from "../util/crypto.js";
import { OAuthError } from "./errors.js";

/**
 * RFC 7591 Dynamic Client Registration.
 *
 * Claude / ChatGPT / any MCP client posts a metadata document and we
 * respond with a fresh client_id (+ client_secret if confidential).
 *
 * MVP registration policy:
 *  - No pre-registration required
 *  - No admin approval — we trust the redirect_uris the client claims
 *  - Public clients (PKCE only, no secret) allowed via `none` auth method
 *  - Confidential clients get a bcrypt-hashed secret returned once
 *
 * Rate limiting is applied at the router level to prevent abuse.
 */

const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const SUPPORTED_RESPONSE_TYPES = new Set(["code"]);
const SUPPORTED_AUTH_METHODS = new Set([
  "client_secret_post",
  "client_secret_basic",
  "none",
]);

const RequestSchema = z.object({
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(20),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export function registerDcrRoute(app: FastifyInstance): void {
  app.post("/oauth/register", async (req, reply) => {
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new OAuthError(
        "invalid_client_metadata",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }
    const body = parsed.data;

    // Validate redirect URIs — all must be HTTPS (or localhost for dev).
    for (const uri of body.redirect_uris) {
      const u = new URL(uri);
      const isLocalhost =
        u.hostname === "localhost" ||
        u.hostname === "127.0.0.1" ||
        u.hostname.endsWith(".localhost");
      if (u.protocol !== "https:" && !isLocalhost) {
        throw new OAuthError(
          "invalid_redirect_uri",
          `redirect_uri must be HTTPS: ${uri}`
        );
      }
    }

    const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
    const responseTypes = body.response_types ?? ["code"];
    const authMethod = (body.token_endpoint_auth_method ?? "client_secret_post") as
      | "client_secret_post"
      | "client_secret_basic"
      | "none";

    for (const g of grantTypes) {
      if (!SUPPORTED_GRANT_TYPES.has(g)) {
        throw new OAuthError("invalid_client_metadata", `unsupported grant_type: ${g}`);
      }
    }
    for (const rt of responseTypes) {
      if (!SUPPORTED_RESPONSE_TYPES.has(rt)) {
        throw new OAuthError(
          "invalid_client_metadata",
          `unsupported response_type: ${rt}`
        );
      }
    }
    if (!SUPPORTED_AUTH_METHODS.has(authMethod)) {
      throw new OAuthError(
        "invalid_client_metadata",
        `unsupported token_endpoint_auth_method: ${authMethod}`
      );
    }

    // Scopes — MVP has only verify:read; ignore anything else the client asks for.
    const requestedScopes = (body.scope ?? "verify:read").split(" ").filter(Boolean);
    const scopes = requestedScopes.includes("verify:read") ? ["verify:read"] : ["verify:read"];

    const clientId = randomToken("cli", 16);
    const isPublic = authMethod === "none";
    const rawSecret = isPublic ? null : randomToken("cs", 32);
    const secretHash = rawSecret ? await bcrypt.hash(rawSecret, 10) : null;

    await clients().insertOne({
      client_id: clientId,
      client_secret_hash: secretHash,
      client_name: body.client_name ?? "Unnamed MCP client",
      redirect_uris: body.redirect_uris,
      grant_types: grantTypes,
      response_types: responseTypes,
      scopes,
      token_endpoint_auth_method: authMethod,
      created_at: new Date(),
      created_via_dcr: true,
      last_used_at: null,
    });

    // RFC 7591 §3.2.1 response
    return reply.code(201).send({
      client_id: clientId,
      ...(rawSecret ? { client_secret: rawSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name ?? "Unnamed MCP client",
      redirect_uris: body.redirect_uris,
      grant_types: grantTypes,
      response_types: responseTypes,
      scope: scopes.join(" "),
      token_endpoint_auth_method: authMethod,
    });
  });
}
