import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) + OAuth 2.0
 * Protected Resource Metadata (RFC 9728). MCP clients use these to
 * discover our endpoints without hardcoding paths.
 */
export function registerMetadataRoutes(app: FastifyInstance): void {
  app.get("/.well-known/oauth-authorization-server", async () => {
    const iss = config.OAUTH_ISSUER;
    return {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      registration_endpoint: `${iss}/oauth/register`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
      scopes_supported: ["verify:read"],
      service_documentation: "https://giggal.ai/docs/mcp",
      // Branding hints picked up by MCP clients (e.g. Claude Desktop's
      // custom-connector card). These are non-standard extensions to RFC 8414
      // but are widely honoured by connector UIs to display server identity.
      service_name: "Giggal.ai",
      service_display_name: "Giggal.ai",
      service_tagline: "Verify Catch-All, Risky & SEG-Protected Emails",
      logo_uri: `${iss}/assets/logo.png`,
      op_logo_uri: `${iss}/assets/logo.png`,
      client_uri: "https://giggal.ai",
    };
  });

  app.get("/.well-known/oauth-protected-resource", async () => {
    const iss = config.OAUTH_ISSUER;
    return {
      resource: iss,
      authorization_servers: [iss],
      scopes_supported: ["verify:read"],
      bearer_methods_supported: ["header"],
      // Same branding hints on the resource metadata for clients that read
      // the protected-resource document first (per RFC 9728 flow).
      resource_name: "Giggal.ai",
      resource_documentation: "https://giggal.ai/docs/mcp",
      logo_uri: `${iss}/assets/logo.png`,
    };
  });
}
