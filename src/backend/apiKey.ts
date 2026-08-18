import { request } from "undici";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * API-key authentication for the MCP endpoint.
 *
 * Giggal.ai Developer API keys look like `tp_live_<lookup>.<secret>` — the
 * exact same format the backend already accepts on `/v1/*` routes. Reusing
 * them lets MCP clients that don't do OAuth (Cursor, Windsurf, VS Code,
 * Cline, Zed, Codex, Claude Code) authenticate by pasting a key as
 * `Authorization: Bearer tp_live_...`.
 *
 * We validate by calling backend's `GET /api/mcp/whoami` (protected by the
 * existing apiKeyAuth middleware) which returns the owning user_id. To keep
 * per-request latency low, valid resolutions are cached in memory for a
 * short TTL — long enough to matter for a rapid-fire tool call, short
 * enough that key revocation propagates in reasonable time.
 */

/** Recognise the developer-API key format. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith("tp_live_");
}

interface CacheEntry {
  userId: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

/**
 * Resolve an API key to the owning user's id. Returns null when the key is
 * unknown, revoked, or the backend is unreachable — the caller should treat
 * that identically to any other invalid-token case.
 */
export async function resolveApiKey(apiKey: string): Promise<string | null> {
  const cached = cache.get(apiKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.userId;
  }
  if (cached) cache.delete(apiKey);

  try {
    const url = `${config.BACKEND_INTERNAL_URL}/api/mcp/whoami`;
    const res = await request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.statusCode !== 200) return null;
    const body = await res.body.text();
    const parsed = JSON.parse(body) as { data?: { userId?: string } };
    const userId = parsed.data?.userId;
    if (!userId) return null;
    cache.set(apiKey, { userId, expiresAt: now + CACHE_TTL_MS });
    return userId;
  } catch (err) {
    logger.warn({ err }, "api key resolution failed");
    return null;
  }
}
