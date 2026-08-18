import Fastify from "fastify";
import cors from "@fastify/cors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { connectDb, disconnectDb } from "./db/connection.js";
import { ensureIndexes } from "./db/models.js";
import { registerOAuthRoutes } from "./oauth/router.js";
import { registerMcpRoutes } from "./mcp/router.js";

/**
 * Load the Giggal.ai brand logo once at boot. We serve it from `/assets/logo.png`
 * (referenced by the OAuth consent page and by the MCP connector submission).
 * Reading a static file at boot instead of every request avoids disk I/O on
 * a hot path served to every user starting an OAuth flow.
 */
const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "REBRANDING", "giggal_logo.png");
let LOGO_BYTES: Buffer | null = null;
try {
  LOGO_BYTES = readFileSync(LOGO_PATH);
} catch {
  // Non-fatal — logo endpoint just returns 404 if the file isn't present.
}

async function main() {
  // Fastify creates its own pino instance from these options. Type-friendly.
  // Our standalone `logger` (imported above) is used for non-request code
  // paths like DB connection lifecycle.
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      base: { service: "mcp-service", env: config.NODE_ENV },
    },
    disableRequestLogging: false,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow no-origin requests (curl, health checks) and configured origins
      if (!origin) return cb(null, true);
      if (config.ALLOWED_CORS_ORIGINS.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
  });

  // Giggal.ai brand logo — used by the OAuth consent page, connector cards,
  // and referenced by connector submissions. Cached since the logo is stable.
  const serveLogo = async (_req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => {
    if (!LOGO_BYTES) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("Cache-Control", "public, max-age=86400")
      .type("image/png")
      .send(LOGO_BYTES);
  };

  app.get("/assets/logo.png", serveLogo);
  // Claude Desktop + browser tabs probe well-known paths for the connector-
  // card icon and favicon. Serve the same PNG for all of them so the
  // Giggal.ai logo shows regardless of which convention the client uses.
  // We cover BOTH origin-root paths (browser default) AND paths relative
  // to the /mcp endpoint (some clients probe next to the URL they were
  // given rather than the origin root).
  app.get("/favicon.ico", serveLogo);
  app.get("/favicon.png", serveLogo);
  app.get("/icon.png", serveLogo);
  app.get("/apple-touch-icon.png", serveLogo);
  app.get("/apple-touch-icon-precomposed.png", serveLogo);
  app.get("/mcp/favicon.ico", serveLogo);
  app.get("/mcp/favicon.png", serveLogo);
  app.get("/mcp/icon.png", serveLogo);
  app.get("/mcp/apple-touch-icon.png", serveLogo);
  app.get("/mcp/logo.png", serveLogo);

  // Health check
  app.get("/health", async () => {
    return {
      status: "ok",
      service: "mcp-service",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    };
  });

  // Root — hint page for humans who hit the domain in a browser
  app.get("/", async (_req, reply) => {
    return reply.type("text/plain").send(
      [
        "Giggal.ai MCP Service",
        "giggal.ai — Verify Catch-All, Risky & SEG-Protected Emails",
        "",
        "This is a Model Context Protocol server for AI assistants.",
        "Add it to Claude or ChatGPT to verify emails from chat.",
        "",
        "Docs: https://giggal.ai/docs/mcp",
        "",
        "Endpoints:",
        "  POST /mcp",
        "  GET  /mcp",
        "  GET  /openapi.json",
        "  GET  /.well-known/oauth-authorization-server",
        "  POST /oauth/register",
        "  GET  /oauth/authorize",
        "  POST /oauth/token",
        "  POST /oauth/revoke",
      ].join("\n")
    );
  });

  // Connect DB before starting, then ensure OAuth-related indexes exist.
  await connectDb();
  await ensureIndexes();

  // OAuth 2.1 endpoints + well-known metadata
  await registerOAuthRoutes(app);

  // MCP protocol endpoints (POST /mcp + GET /mcp).
  // Registered as its own scope so the OAuth error handler (which converts
  // OAuthError → RFC 6749 shape) doesn't hijack JSON-RPC errors.
  await app.register(async (scope) => {
    registerMcpRoutes(scope);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info({ port: config.PORT }, "mcp-service listening");
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
