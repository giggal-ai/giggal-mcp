/**
 * OAuth 2.0 / 2.1 standard error codes. RFC 6749 §5.2 for token endpoint
 * errors, RFC 6749 §4.1.2.1 for authorize errors, RFC 7591 §3.2.2 for
 * client registration errors.
 */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "invalid_token";

export class OAuthError extends Error {
  /**
   * `statusCode` is the property name Fastify's default error handler
   * reads. Setting it here means even if our custom handler misses (e.g.
   * nested scope issue), the response HTTP status is still correct.
   */
  constructor(
    public readonly code: OAuthErrorCode,
    public readonly description: string,
    public readonly statusCode = 400
  ) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
  }

  toResponseBody(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
