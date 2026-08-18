/**
 * MongoDB collection schemas for OAuth 2.1 storage.
 *
 * We use raw MongoDB (not Mongoose) here because:
 *  - the schemas are small and stable
 *  - we don't need lifecycle hooks or population
 *  - one less dependency
 *
 * All tokens are stored HASHED (sha256Hex). Never store raw tokens at rest.
 */
import type { Collection, Db, ObjectId } from "mongodb";
import { getDb } from "./connection.js";

// ── Collection names ──────────────────────────────────────────────────────
export const COLL = {
  clients: "mcp_clients",
  authCodes: "mcp_auth_codes",
  accessTokens: "mcp_access_tokens",
  refreshTokens: "mcp_refresh_tokens",
} as const;

// ── Documents ─────────────────────────────────────────────────────────────

export interface McpClient {
  _id?: ObjectId;
  client_id: string;
  client_secret_hash: string | null; // null for public clients (PKCE only)
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scopes: string[];
  token_endpoint_auth_method: "client_secret_post" | "client_secret_basic" | "none";
  created_at: Date;
  created_via_dcr: boolean;
  last_used_at: Date | null;
}

export interface McpAuthCode {
  _id?: ObjectId;
  code_hash: string; // sha256 of the raw code
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: "S256";
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface McpAccessToken {
  _id?: ObjectId;
  token_hash: string;
  client_id: string;
  user_id: string;
  scopes: string[];
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface McpRefreshToken {
  _id?: ObjectId;
  token_hash: string;
  client_id: string;
  user_id: string;
  scopes: string[];
  expires_at: Date;
  revoked_at: Date | null;
  /**
   * Parent refresh token id (for rotation chain).
   * If a token in this chain is ever reused after revocation, we invalidate
   * every descendant. Defends against stolen refresh tokens.
   */
  parent_id: ObjectId | null;
  created_at: Date;
}

// ── Typed accessors ───────────────────────────────────────────────────────

export const clients = (): Collection<McpClient> =>
  getDb().collection<McpClient>(COLL.clients);

export const authCodes = (): Collection<McpAuthCode> =>
  getDb().collection<McpAuthCode>(COLL.authCodes);

export const accessTokens = (): Collection<McpAccessToken> =>
  getDb().collection<McpAccessToken>(COLL.accessTokens);

export const refreshTokens = (): Collection<McpRefreshToken> =>
  getDb().collection<McpRefreshToken>(COLL.refreshTokens);

// ── Indexes ───────────────────────────────────────────────────────────────

/**
 * Idempotent — safe to run on every startup. MongoDB skips existing indexes.
 * TTL indexes automatically expire documents past `expires_at`.
 */
export async function ensureIndexes(db: Db = getDb()): Promise<void> {
  await Promise.all([
    // Clients — client_id lookup on every token request
    db.collection<McpClient>(COLL.clients).createIndex({ client_id: 1 }, { unique: true }),

    // Auth codes — hash lookup + TTL cleanup
    db.collection<McpAuthCode>(COLL.authCodes).createIndex({ code_hash: 1 }, { unique: true }),
    db.collection<McpAuthCode>(COLL.authCodes).createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 }
    ),

    // Access tokens — hash lookup + TTL
    db.collection<McpAccessToken>(COLL.accessTokens).createIndex(
      { token_hash: 1 },
      { unique: true }
    ),
    db.collection<McpAccessToken>(COLL.accessTokens).createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 }
    ),

    // Refresh tokens — hash lookup + TTL + parent chain traversal
    db.collection<McpRefreshToken>(COLL.refreshTokens).createIndex(
      { token_hash: 1 },
      { unique: true }
    ),
    db.collection<McpRefreshToken>(COLL.refreshTokens).createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 }
    ),
    db.collection<McpRefreshToken>(COLL.refreshTokens).createIndex({ parent_id: 1 }),
  ]);
}
