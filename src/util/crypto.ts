import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * Generate an opaque token with a human-readable prefix.
 * e.g. randomToken("at") → "at_a1b2c3d4..."
 */
export function randomToken(prefix: string, byteLength = 32): string {
  return `${prefix}_${randomBytes(byteLength).toString("base64url")}`;
}

/** SHA-256 hex digest — for storing tokens at rest without reversibility. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time comparison of two hex strings. Prevents timing attacks
 * on token lookup.
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
