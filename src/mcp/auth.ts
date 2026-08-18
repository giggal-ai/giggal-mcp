import type { FastifyRequest } from "fastify";
import { findValidAccessToken } from "../oauth/tokens.js";
import { looksLikeApiKey, resolveApiKey } from "../backend/apiKey.js";
import { JsonRpcError, JsonRpcErrorCode } from "./errors.js";

export interface McpUser {
  user_id: string;
  /** Populated for OAuth-authenticated calls; undefined for API-key calls. */
  client_id?: string;
  scopes: string[];
  /** How the caller authenticated — useful for audit / rate-limit branching. */
  auth_source: "oauth" | "api_key";
}

/**
 * Extract + validate the Bearer token from a request. Two token types are
 * accepted, dispatched by prefix:
 *
 *   • `tp_live_...`  — Giggal.ai Developer API key. Resolved via backend's
 *     `/api/mcp/whoami` (short-lived in-memory cache). This is how MCP
 *     clients that don't do OAuth (Cursor, Windsurf, VS Code, Cline, Zed,
 *     Codex, Claude Code) authenticate.
 *   • anything else — treated as an OAuth 2.1 access token minted by this
 *     service's `/oauth/token` endpoint. Used by claude.ai and ChatGPT's
 *     custom-connector flow.
 *
 * Throws JsonRpcError(Unauthorized) if the token is missing or unrecognised;
 * the router catches that and returns a JSON-RPC error with the proper
 * WWW-Authenticate header.
 */
export async function requireBearer(req: FastifyRequest): Promise<McpUser> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new JsonRpcError(JsonRpcErrorCode.Unauthorized, "missing bearer token");
  }
  const raw = auth.slice(7).trim();

  if (looksLikeApiKey(raw)) {
    const userId = await resolveApiKey(raw);
    if (!userId) {
      throw new JsonRpcError(JsonRpcErrorCode.Unauthorized, "invalid api key");
    }
    return {
      user_id: userId,
      scopes: ["verify:read"],
      auth_source: "api_key",
    };
  }

  const token = await findValidAccessToken(raw);
  if (!token) {
    throw new JsonRpcError(JsonRpcErrorCode.Unauthorized, "invalid or expired access token");
  }
  return {
    user_id: token.user_id,
    client_id: token.client_id,
    scopes: token.scopes,
    auth_source: "oauth",
  };
}
