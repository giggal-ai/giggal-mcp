import { createHash } from "node:crypto";

export type CodeChallengeMethod = "S256" | "plain";

/**
 * Verify that a code_verifier matches the stored code_challenge. Per RFC 7636.
 * We only accept S256 (Anthropic + OpenAI require it; plain is deprecated).
 */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method: CodeChallengeMethod
): boolean {
  if (method !== "S256") return false;
  const derived = createHash("sha256").update(verifier).digest("base64url");
  return derived === challenge;
}

const VERIFIER_REGEX = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 §4.1: verifier is 43-128 chars from an unreserved set. */
export function isValidVerifier(v: string): boolean {
  return VERIFIER_REGEX.test(v);
}

/** Challenge is base64url without padding; 43 chars for SHA-256 output. */
export function isValidChallenge(c: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(c);
}
