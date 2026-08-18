import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { JsonRpcError, JsonRpcErrorCode } from "./errors.js";
import { requireBearer } from "./auth.js";
import { listTools, TOOLS } from "./tools/index.js";
import type { ToolResult, ProgressCallback } from "./tools/types.js";
import { McpSseWriter } from "./sse.js";

/**
 * MCP protocol version we speak. This is the string clients see in the
 * initialize response — Claude and ChatGPT currently negotiate around
 * 2025-03-26 / 2024-11-05. Serving the newer one is fine; clients that
 * only know the older one will still function via the shared subset.
 */
const PROTOCOL_VERSION = "2025-03-26";
// Claude Desktop's connector card was stripping ".ai" from "giggal.ai"
// (treating it as a file extension) and rendering the tab as "Giggal".
// Using a form without a trailing dot-suffix keeps the full brand intact.
const SERVER_NAME = "Giggal AI";
const SERVER_VERSION = "0.1.0";

/**
 * JSON-RPC request shape per spec.
 * `id` may be null / omitted for notifications (fire-and-forget).
 */
const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export function registerMcpRoutes(app: FastifyInstance): void {
  app.post("/mcp", async (req, reply) => {
    // Auth check — throws JsonRpcError.Unauthorized on failure.
    let user;
    try {
      user = await requireBearer(req);
    } catch (err) {
      return replyUnauthorized(reply, err instanceof Error ? err.message : "unauthorized");
    }

    const body = req.body;

    // ── Streaming path: single tools/call with a progressToken ──────────
    // Detect early so we can open an SSE response before the tool starts.
    // MCP spec: client puts progressToken in params._meta.progressToken.
    if (!Array.isArray(body) && looksLikeToolCallWithProgress(body)) {
      const parsed = JsonRpcRequestSchema.safeParse(body);
      if (parsed.success) {
        const progressToken = extractProgressToken(parsed.data.params);
        if (progressToken !== undefined) {
          await handleStreamingToolCall(reply, parsed.data, user, progressToken);
          return reply;
        }
      }
    }

    // ── Non-streaming path (default) ──────────────────────────────────
    const requests = Array.isArray(body) ? body : [body];
    const responses: unknown[] = [];

    for (const raw of requests) {
      const parsed = JsonRpcRequestSchema.safeParse(raw);
      if (!parsed.success) {
        responses.push({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: JsonRpcErrorCode.InvalidRequest,
            message: "malformed JSON-RPC request",
          },
        });
        continue;
      }

      const request = parsed.data;
      const id = request.id ?? null;
      const isNotification = request.id === undefined;

      try {
        const result = await dispatch(request, user);

        // Notifications get no response per JSON-RPC 2.0
        if (isNotification) continue;

        const success: JsonRpcSuccessResponse = {
          jsonrpc: "2.0",
          id,
          result,
        };
        responses.push(success);
      } catch (err) {
        if (isNotification) {
          req.log.warn({ err, method: request.method }, "error handling notification");
          continue;
        }
        if (err instanceof JsonRpcError) {
          responses.push(err.toRpc(id));
        } else {
          // Unhandled path: never surface the raw error to the caller — it
          // could contain stack traces, internal identifiers, or backend
          // detail. The full error is logged server-side for debugging.
          req.log.error({ err, method: request.method }, "unhandled MCP error");
          responses.push({
            jsonrpc: "2.0",
            id,
            error: {
              code: JsonRpcErrorCode.InternalError,
              message: "Internal error. Please try again.",
            },
          });
        }
      }
    }

    // Notifications-only request → empty 202 Accepted
    if (responses.length === 0) {
      return reply.code(202).send();
    }

    // Single request → single response; batch → array (per JSON-RPC 2.0 §6)
    return Array.isArray(body) ? responses : responses[0];
  });

  /**
   * GET /mcp — reserved for the SSE stream direction (server → client).
   * Progress notifications during long tool calls are emitted on the POST
   * response's SSE stream, not this endpoint.
   */
  app.get("/mcp", async (_req, reply) => {
    return reply
      .code(405)
      .header("Allow", "POST")
      .send({
        error: "method_not_allowed",
        error_description:
          "Progress notifications are streamed on the POST response, not GET.",
      });
  });
}

// ── Streaming tool call ──────────────────────────────────────────────────

async function handleStreamingToolCall(
  reply: FastifyReply,
  request: JsonRpcRequest,
  user: import("./auth.js").McpUser,
  progressToken: string | number
): Promise<void> {
  const sse = new McpSseWriter(reply);
  const id = request.id ?? null;

  const onProgress: ProgressCallback = (update) => {
    sse.progress(progressToken, update.progress, update.total, update.message);
  };

  try {
    const result = await callTool(request.params, user, onProgress);
    sse.finish({ jsonrpc: "2.0", id, result });
  } catch (err) {
    if (err instanceof JsonRpcError) {
      sse.finish(err.toRpc(id));
    } else {
      reply.log.error({ err }, "unhandled error in streaming tool call");
      sse.finish({
        jsonrpc: "2.0",
        id,
        error: {
          code: JsonRpcErrorCode.InternalError,
          message: "Internal error. Please try again.",
        },
      });
    }
  }
}

/**
 * Cheap pre-parse test — no need to fully parse before deciding routing.
 * Confirms the object shape matches `{ method: "tools/call", params: {...} }`.
 */
function looksLikeToolCallWithProgress(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return b.method === "tools/call" && typeof b.params === "object" && b.params !== null;
}

function extractProgressToken(params: unknown): string | number | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const meta = (params as Record<string, unknown>)._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const tok = (meta as Record<string, unknown>).progressToken;
  if (typeof tok === "string" || typeof tok === "number") return tok;
  return undefined;
}

// ── Method dispatch (non-streaming path) ──────────────────────────────

async function dispatch(
  req: JsonRpcRequest,
  user: import("./auth.js").McpUser
): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return handleInitialize(req.params);

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { tools: listTools() };

    case "tools/call":
      return callTool(req.params, user, undefined);

    case "ping":
      return {};

    default:
      throw new JsonRpcError(
        JsonRpcErrorCode.MethodNotFound,
        `method '${req.method}' not supported`
      );
  }
}

const InitializeParamsSchema = z.object({
  protocolVersion: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
});

function handleInitialize(params: unknown) {
  const parsed = InitializeParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "malformed initialize params");
  }
  const iss = process.env.OAUTH_ISSUER ?? "";
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
      logging: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      // Branding hints under the `_meta` extension slot MCP clients read
      // to render the connector card (name, tagline, logo). Not part of
      // the required serverInfo fields, but honoured by Claude Desktop and
      // similar clients when present.
      title: "Giggal.ai",
      _meta: {
        displayName: "Giggal.ai",
        description: "Verify Catch-All, Risky & SEG-Protected Emails",
        icon: iss ? `${iss}/assets/logo.png` : undefined,
        logo: iss ? `${iss}/assets/logo.png` : undefined,
        website: "https://giggal.ai",
      },
    },
  };
}

const ToolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
});

/** Shared tool invocation used by both streaming and non-streaming paths. */
async function callTool(
  params: unknown,
  user: import("./auth.js").McpUser,
  onProgress: ProgressCallback | undefined
): Promise<ToolResult> {
  const parsed = ToolsCallParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcError(
      JsonRpcErrorCode.InvalidParams,
      "tools/call requires name + arguments"
    );
  }
  const tool = TOOLS.get(parsed.data.name);
  if (!tool) {
    throw new JsonRpcError(
      JsonRpcErrorCode.MethodNotFound,
      `unknown tool '${parsed.data.name}'`
    );
  }
  return tool.run({
    arguments: parsed.data.arguments,
    user,
    onProgress,
  });
}

// ── Auth failure — RFC 6750 §3 says WWW-Authenticate points at the AS ──

function replyUnauthorized(reply: FastifyReply, message: string) {
  const issuer = process.env.OAUTH_ISSUER ?? "";
  const wwwAuth =
    `Bearer realm="mcp", ` +
    `error="invalid_token", ` +
    `error_description="${message.replace(/"/g, "'")}"` +
    (issuer
      ? `, resource_metadata="${issuer}/.well-known/oauth-protected-resource"`
      : "");
  return reply
    .code(401)
    .header("WWW-Authenticate", wwwAuth)
    .send({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JsonRpcErrorCode.Unauthorized,
        message,
      },
    });
}
