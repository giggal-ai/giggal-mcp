import type { FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { registerMetadataRoutes } from "./metadata.js";
import { registerDcrRoute } from "./register.js";
import { registerAuthorizeRoute } from "./authorize.js";
import { registerTokenRoute } from "./token.js";
import { registerRevokeRoute } from "./revoke.js";
import { OAuthError } from "./errors.js";

/**
 * Registers all OAuth routes on the given Fastify instance.
 *
 * OAuth endpoints receive form-urlencoded bodies (RFC 6749), so we register
 * the formbody plugin here. Rate-limits protect against brute-force and
 * enumeration.
 */
export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  // IMPORTANT: register the error handler BEFORE any child scopes are
  // created, so those children inherit it. Fastify handlers cascade from
  // parent to child — but only if the parent's handler exists at the time
  // the child context is opened.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof OAuthError) {
      return reply.code(err.statusCode).send(err.toResponseBody());
    }
    req.log.error({ err }, "unhandled error in OAuth handler");
    return reply.code(500).send({
      error: "server_error",
      error_description: "internal server error",
    });
  });

  // Cookie support — required for consent-flow session tracking.
  await app.register(cookie, { secret: undefined, hook: "onRequest" });
  await app.register(formbody);

  // Per-endpoint rate limits — tight on the sensitive ones, loose on discovery.
  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: 30,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
    });
    registerTokenRoute(scope);
    registerRevokeRoute(scope);
  });

  await app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
    });
    registerDcrRoute(scope);
  });

  // Authorize + metadata don't need aggressive rate limiting.
  registerAuthorizeRoute(app);
  registerMetadataRoutes(app);
}
