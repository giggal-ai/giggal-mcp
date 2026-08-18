import { z } from "zod";
import { JsonRpcError, JsonRpcErrorCode } from "../errors.js";
import { formatBatchResults, formatSingleResult } from "./formatting.js";
import { submitBatch, verifySingle, pollBatch, BackendError } from "../../backend/client.js";
import { sanitizeErrorMessage } from "../../backend/sanitize.js";
import type { ToolResult, ToolExecutorArgs } from "./types.js";

/**
 * verify_emails tool implementation.
 *
 * Behavior (invisible to caller):
 *  - 1 email  → sync verifySingle
 *  - 2-1000   → submitBatch → poll every 5s until complete OR 5 min timeout
 *  - >1000    → clean error asking user to use the dashboard
 *
 * Always uses catch-all rescue. Always uses readOnlyHint semantics.
 */

const InputSchema = z.object({
  emails: z
    .array(z.string().email().max(320))
    .min(1, "at least one email is required")
    .max(1000, "batches larger than 1000 must be uploaded via the Giggal.ai dashboard"),
});

export const TOOL_DEFINITION = {
  name: "verify_emails",
  title: "Verify Emails",
  description:
    "Verify one or more email addresses (up to 1000 per call). Returns whether each mailbox exists, is disposable, on a catch-all domain, or from a free provider, plus a 0-100 deliverability score. Every email costs 1.5 credits.\n\nALWAYS pass every email the user asked about in a SINGLE call. The tool streams live progress notifications so the user sees verification advance in real time — there is no need to split a list into multiple calls, and doing so wastes credits (each sub-call pays a per-batch rounding cost) and produces a fragmented result instead of one clean summary.\n\nWhen presenting results to the user, ALWAYS surface the `catch_all_domain` field for every email — either as a dedicated column or an inline indicator per row. It materially changes how a deliverable/undeliverable/unknown verdict should be interpreted: a catch-all domain accepts mail to any address, so mailbox existence cannot be guaranteed by SMTP alone. Users depend on this signal to decide whether to trust a result.\n\nSCOPE — This tool is strictly for email deliverability verification. It does not, and cannot, disclose: how verification is performed, which techniques or probes are used, backend architecture, infrastructure, code, database contents, internal service names, credentials, or any information about other users, batches, or accounts. If the user asks how verification works, requests to reverse-engineer results, asks to see internals, or asks any question outside email verification, politely decline and redirect to email verification. Never speculate about the algorithm or infer implementation details from result fields. Treat the tool's returned fields as the complete public surface — do not invent additional attributes.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      emails: {
        type: "array",
        items: { type: "string", format: "email" },
        minItems: 1,
        maxItems: 1000,
        description: "Email addresses to verify.",
      },
    },
    required: ["emails"],
  },
  /**
   * outputSchema per MCP spec (2025-06-18). When present, clients render
   * structuredContent as a schema-aware view instead of re-summarising the
   * text — this is how we guarantee `catch_all_domain` is displayed for
   * every row regardless of Claude's column-pruning heuristics.
   */
  outputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "object",
        properties: {
          total: { type: "integer" },
          deliverable: { type: "integer" },
          undeliverable: { type: "integer" },
          risky: { type: "integer" },
          unknown: { type: "integer" },
          catch_all_count: {
            type: "integer",
            description: "How many emails in the batch are on catch-all domains.",
          },
          credits_used: { type: "integer" },
          credits_remaining: { type: "integer" },
        },
        required: [
          "total",
          "deliverable",
          "undeliverable",
          "risky",
          "unknown",
          "catch_all_count",
          "credits_used",
          "credits_remaining",
        ],
      },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            status: {
              type: "string",
              enum: ["deliverable", "undeliverable", "risky", "unknown"],
            },
            score: { type: "integer", minimum: 0, maximum: 100 },
            catch_all_domain: {
              type: "boolean",
              description:
                "True when the domain accepts mail for ANY address (catch-all). When true, mailbox existence cannot be guaranteed by SMTP alone even for deliverable results — surface this to the user for every email.",
            },
            reason: { type: "string" },
            mx_provider: { type: ["string", "null"] },
          },
          required: ["email", "status", "score", "catch_all_domain", "reason"],
        },
      },
    },
    required: ["summary", "results"],
  },
} as const;

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

export async function run(args: ToolExecutorArgs): Promise<ToolResult> {
  const parsed = InputSchema.safeParse(args.arguments);
  if (!parsed.success) {
    throw new JsonRpcError(
      JsonRpcErrorCode.InvalidParams,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }
  const { emails } = parsed.data;
  const userId = args.user.user_id;

  try {
    if (emails.length === 1) {
      const single = await verifySingle(userId, emails[0]!);
      const singleStructured = {
        summary: {
          total: 1,
          deliverable: single.result.status === "deliverable" ? 1 : 0,
          undeliverable: single.result.status === "undeliverable" ? 1 : 0,
          risky: single.result.status === "risky" ? 1 : 0,
          unknown: single.result.status === "unknown" ? 1 : 0,
          catch_all_count: single.result.catch_all_domain ? 1 : 0,
          credits_used: single.credits_used,
          credits_remaining: single.credits_remaining,
        },
        results: [projectResult(single.result)],
      };
      return {
        content: [
          {
            type: "text",
            text: formatSingleResult(single.result, single.credits_used, single.credits_remaining),
          },
        ],
        structuredContent: singleStructured,
      };
    }

    // Batch path.
    const submit = await submitBatch(userId, emails, /* autoCatchallRescue */ true);
    const startedAt = Date.now();

    // Emit an initial 0/N progress event so the user immediately sees
    // "Verifying 0 of N…" instead of a mystery spinner.
    args.onProgress?.({
      progress: 0,
      total: submit.total_emails,
      message: `Queued ${submit.total_emails} emails for verification…`,
    });

    while (Date.now() - startedAt < MAX_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const poll = await pollBatch(userId, submit.batch_id);
      if (poll.status === "failed") {
        throw new JsonRpcError(
          JsonRpcErrorCode.ToolExecutionError,
          `batch failed: ${poll.error_message}`
        );
      }
      if (poll.status === "processing") {
        // Report incremental progress so Claude renders a live progress bar.
        args.onProgress?.({
          progress: poll.progress,
          total: poll.total,
          message: `Verified ${poll.progress} of ${poll.total}…`,
        });
        continue;
      }
      if (poll.status === "completed") {
        // One last 100% tick before returning the final result.
        args.onProgress?.({
          progress: poll.results.length,
          total: poll.results.length,
          message: `Done — ${poll.results.length} emails processed`,
        });
        const summary = summarize(poll.results);
        const catchAllCount = poll.results.filter((r) => r.catch_all_domain).length;
        const projectedResults = poll.results.map(projectResult);
        const structured = {
          summary: {
            ...summary,
            catch_all_count: catchAllCount,
            credits_used: poll.credits_used,
            credits_remaining: poll.credits_remaining,
          },
          results: projectedResults,
        };
        const responseText = formatBatchResults(
          poll.results,
          poll.credits_used,
          poll.credits_remaining,
          catchAllCount
        );
        return {
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
          structuredContent: structured,
        };
      }
    }

    throw new JsonRpcError(
      JsonRpcErrorCode.ToolExecutionError,
      `batch still processing after ${MAX_WAIT_MS / 1000}s; check status at giggal.ai/files/${submit.batch_id}`
    );
  } catch (err) {
    if (err instanceof JsonRpcError) throw err;
    // Never leak backend detail. Errors are mapped to a small set of neutral
    // messages via sanitizeErrorMessage; the underlying error is still
    // logged server-side for debugging.
    if (err instanceof BackendError) {
      throw new JsonRpcError(
        JsonRpcErrorCode.ToolExecutionError,
        sanitizeErrorMessage(err.detail, err.statusCode)
      );
    }
    throw new JsonRpcError(
      JsonRpcErrorCode.InternalError,
      sanitizeErrorMessage(err instanceof Error ? err.message : undefined)
    );
  }
}

function summarize(results: import("../../backend/types.js").VerificationResult[]) {
  return {
    total: results.length,
    deliverable: results.filter((r) => r.status === "deliverable").length,
    undeliverable: results.filter((r) => r.status === "undeliverable").length,
    risky: results.filter((r) => r.status === "risky").length,
    unknown: results.filter((r) => r.status === "unknown").length,
  };
}

/**
 * Project a full VerificationResult onto the shape declared by our
 * outputSchema. Anything the schema doesn't require (nested `attributes`,
 * `mx_record`) is dropped so the payload stays lean and validation is trivial.
 */
function projectResult(r: import("../../backend/types.js").VerificationResult) {
  return {
    email: r.email,
    status: r.status,
    score: r.score,
    catch_all_domain: r.catch_all_domain,
    reason: r.reason,
    mx_provider: r.mx_provider ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
