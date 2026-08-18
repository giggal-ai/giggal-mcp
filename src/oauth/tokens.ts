import type { ObjectId } from "mongodb";
import { config } from "../config.js";
import { randomToken, sha256Hex } from "../util/crypto.js";
import { accessTokens, refreshTokens } from "../db/models.js";

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number; // seconds
  scope: string; // space-separated per RFC 6749
}

interface IssueArgs {
  client_id: string;
  user_id: string;
  scopes: string[];
  parent_refresh_id?: ObjectId | null;
}

/**
 * Issue a fresh access + refresh token pair. Raw tokens are only ever
 * returned to the caller here; the DB stores hashes.
 */
export async function issueTokenPair(args: IssueArgs): Promise<IssuedTokens> {
  const now = new Date();
  const accessRaw = randomToken("at");
  const refreshRaw = randomToken("rt");

  await accessTokens().insertOne({
    token_hash: sha256Hex(accessRaw),
    client_id: args.client_id,
    user_id: args.user_id,
    scopes: args.scopes,
    expires_at: new Date(now.getTime() + config.OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000),
    revoked_at: null,
    created_at: now,
  });

  await refreshTokens().insertOne({
    token_hash: sha256Hex(refreshRaw),
    client_id: args.client_id,
    user_id: args.user_id,
    scopes: args.scopes,
    expires_at: new Date(now.getTime() + config.OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000),
    revoked_at: null,
    parent_id: args.parent_refresh_id ?? null,
    created_at: now,
  });

  return {
    access_token: accessRaw,
    refresh_token: refreshRaw,
    token_type: "Bearer",
    expires_in: config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    scope: args.scopes.join(" "),
  };
}

/**
 * Look up a valid, unrevoked, unexpired access token.
 * Returns null if not found / expired / revoked.
 */
export async function findValidAccessToken(raw: string) {
  const hash = sha256Hex(raw);
  const now = new Date();
  return accessTokens().findOne({
    token_hash: hash,
    revoked_at: null,
    expires_at: { $gt: now },
  });
}

/**
 * Revoke a token by its raw form. Idempotent — returns true if we revoked
 * something, false if it didn't exist.
 */
export async function revokeAccessToken(raw: string): Promise<boolean> {
  const hash = sha256Hex(raw);
  const res = await accessTokens().updateOne(
    { token_hash: hash, revoked_at: null },
    { $set: { revoked_at: new Date() } }
  );
  return res.modifiedCount > 0;
}

export async function revokeRefreshToken(raw: string): Promise<boolean> {
  const hash = sha256Hex(raw);
  const res = await refreshTokens().updateOne(
    { token_hash: hash, revoked_at: null },
    { $set: { revoked_at: new Date() } }
  );
  return res.modifiedCount > 0;
}

/**
 * Revoke every descendant of a compromised refresh token chain. Used when
 * we detect a revoked refresh token being reused (stolen-token defence).
 */
export async function revokeRefreshChain(rootId: ObjectId): Promise<void> {
  // Collect ids in the chain rooted at rootId. Simple BFS.
  const toRevoke: ObjectId[] = [rootId];
  const visited = new Set<string>([rootId.toHexString()]);
  const queue: ObjectId[] = [rootId];

  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const children = await refreshTokens()
      .find({ parent_id: parentId }, { projection: { _id: 1 } })
      .toArray();
    for (const c of children) {
      const idHex = c._id!.toHexString();
      if (!visited.has(idHex)) {
        visited.add(idHex);
        toRevoke.push(c._id!);
        queue.push(c._id!);
      }
    }
  }

  await refreshTokens().updateMany(
    { _id: { $in: toRevoke }, revoked_at: null },
    { $set: { revoked_at: new Date() } }
  );
}
