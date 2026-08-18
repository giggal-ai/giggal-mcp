/**
 * Response sanitization — hides proprietary implementation details before
 * anything crosses the MCP boundary.
 *
 * The backend's raw `reason` strings often carry information we do NOT want
 * exposed to end-users or embedded in LLM context: raw SMTP status codes,
 * server-specific greeting text (gsmtp message IDs give away the provider),
 * verbose bounce messages with support URLs, and phrases that hint at our
 * internal probe technique ("Catch-all verification inconclusive" reveals
 * that catch-all rescue exists as a distinct algorithmic stage).
 *
 * Everything user-facing goes through {@link sanitizeReason} which maps to
 * a small whitelist of neutral, generic phrasings. Unknown / unmapped input
 * collapses to a safe default rather than passing through raw.
 *
 * Error messages from the backend follow the same policy via
 * {@link sanitizeErrorMessage} — we never surface backend detail verbatim.
 */

/** Neutral, user-safe reason phrasing keyed by outcome. */
const SAFE_REASONS = {
  MAILBOX_VERIFIED: "Mailbox verified",
  MAILBOX_NOT_FOUND: "Mailbox does not exist",
  MAILBOX_REJECTED: "Mailbox rejected by mail server",
  MAILBOX_UNVERIFIED: "Mailbox could not be verified",
  VERIFY_INCONCLUSIVE: "Verification inconclusive",
  VERIFY_TIMEOUT: "Verification timed out",
  SERVER_UNAVAILABLE: "Mail server unavailable",
  TEMPORARY_ISSUE: "Temporarily unavailable — retry later",
  INVALID_ADDRESS: "Invalid email address",
  DISPOSABLE: "Disposable email address",
} as const;

/**
 * Map any backend `reason` string to a whitelisted safe phrase.
 * Deterministic + case-insensitive so cache hits and misses map identically.
 */
export function sanitizeReason(raw: string | undefined | null, status: string): string {
  const r = (raw ?? "").trim().toLowerCase();

  // SMTP 2.x.x = mailbox accepted. Any variant → single safe phrase.
  if (/^2\.\d\.\d/.test(r) || /recipient .*ok/.test(r) || r === "mailbox verified" || r === "all validations passed") {
    return SAFE_REASONS.MAILBOX_VERIFIED;
  }

  // Explicit non-existence
  if (r === "email does not exist" || r === "mailbox not found" || r === "mailbox does not exist") {
    return SAFE_REASONS.MAILBOX_NOT_FOUND;
  }

  // SMTP 5.1.x usually = user unknown / mailbox not found
  if (/^5\.1\.\d/.test(r) || /user unknown/.test(r) || /no such user/.test(r)) {
    return SAFE_REASONS.MAILBOX_NOT_FOUND;
  }

  // SMTP 5.4.x, 5.7.x = rejection / policy denial. Includes "Access denied",
  // any URL, tenant IDs — all of which we must not leak.
  if (/^5\.[47]\.\d/.test(r) || /address rejected/.test(r) || /access denied/.test(r) || /policy/.test(r)) {
    return SAFE_REASONS.MAILBOX_REJECTED;
  }

  // "Could not verify" family
  if (/could not be verified/.test(r) || /mailbox not verified/.test(r)) {
    return SAFE_REASONS.MAILBOX_UNVERIFIED;
  }

  // Anything referencing catch-all (including our internal "Catch-all
  // verification inconclusive" phrasing) collapses to a neutral inconclusive.
  if (/catch.?all/.test(r) || /inconclusive/.test(r)) {
    return SAFE_REASONS.VERIFY_INCONCLUSIVE;
  }

  // Timeouts / connection issues
  if (/timeout/.test(r) || /timed out/.test(r)) {
    return SAFE_REASONS.VERIFY_TIMEOUT;
  }
  if (/disconnect/.test(r) || /connection/.test(r) || /server unavailable/.test(r)) {
    return SAFE_REASONS.SERVER_UNAVAILABLE;
  }

  // 4.x.x SMTP responses = temporary greylist / rate-limit
  if (/^4\.\d\.\d/.test(r) || /too many/.test(r) || /rate.?limit/.test(r) || /try (again )?later/.test(r)) {
    return SAFE_REASONS.TEMPORARY_ISSUE;
  }

  // Disposable / role — some backends surface these as reasons
  if (/disposable/.test(r)) return SAFE_REASONS.DISPOSABLE;

  // Syntax / format errors
  if (/invalid/.test(r) && /(email|address|format|syntax)/.test(r)) {
    return SAFE_REASONS.INVALID_ADDRESS;
  }

  // Unknown reason — never pass raw text through. Fall back based on status.
  switch (status) {
    case "deliverable":
      return SAFE_REASONS.MAILBOX_VERIFIED;
    case "undeliverable":
      return SAFE_REASONS.MAILBOX_UNVERIFIED;
    case "risky":
    case "unknown":
    default:
      return SAFE_REASONS.VERIFY_INCONCLUSIVE;
  }
}

/**
 * Collapse backend error details to a neutral, user-safe message. Backend
 * error bodies can include stack traces, database identifiers, or internal
 * service names — never forward them verbatim.
 */
export function sanitizeErrorMessage(_raw: string | undefined | null, statusCode?: number): string {
  if (statusCode === 401 || statusCode === 403) {
    return "Authorization failed. Please reconnect your account.";
  }
  if (statusCode === 402 || statusCode === 429) {
    return "Verification quota exceeded. Please try again later.";
  }
  if (statusCode === 400 || statusCode === 422) {
    return "One or more email addresses are invalid.";
  }
  if (statusCode && statusCode >= 500) {
    return "Verification service is temporarily unavailable.";
  }
  return "Verification failed. Please try again.";
}
