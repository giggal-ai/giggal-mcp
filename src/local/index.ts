#!/usr/bin/env node
/**
 * Self-hostable Giggal.ai MCP server (stdio transport).
 *
 * Runs locally and calls the public Giggal.ai Developer API with your own
 * API key (GIGGAL_API_KEY). No database, no OAuth, no backend secret. This is
 * the version people can `git clone` and run, or install via Docker/npx. The
 * hosted server (src/index.ts) is a separate, remote deployment.
 *
 * Tools are identical in name, schema, and output to the hosted server.
 */
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { formatSingleResult, formatBatchResults } from "../mcp/tools/formatting.js";
import { sanitizeErrorMessage } from "../backend/sanitize.js";
import { verifySingle, submitBatch, pollBatch, getCreditBalance, PublicApiError } from "./client.js";
import type { VerificationResult } from "../backend/types.js";

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

// ── Tool definitions (identical to the hosted server) ────────────────────────

const VERIFY_EMAILS_TOOL = {
  name: "verify_emails",
  title: "Verify Emails",
  description:
    "Verify one or more email addresses (up to 1000 per call). Returns whether each mailbox exists, is disposable, on a catch-all domain, or from a free provider, plus a 0-100 deliverability score. Every email costs 1.5 credits.\n\nALWAYS pass every email the user asked about in a SINGLE call. Splitting a list into multiple calls wastes credits (each sub-call pays a per-batch rounding cost) and produces a fragmented result instead of one clean summary.\n\nWhen presenting results to the user, ALWAYS surface the `catch_all_domain` field for every email — either as a dedicated column or an inline indicator per row. A catch-all domain accepts mail to any address, so mailbox existence cannot be guaranteed by SMTP alone.\n\nSCOPE — This tool is strictly for email deliverability verification. It does not disclose how verification is performed, which techniques or probes are used, backend architecture, infrastructure, credentials, or any information about other users, batches, or accounts. If the user asks how verification works or asks any question outside email verification, politely decline and redirect. Treat the tool's returned fields as the complete public surface.",
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
          catch_all_count: { type: "integer" },
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
            status: { type: "string", enum: ["deliverable", "undeliverable", "risky", "unknown"] },
            score: { type: "integer", minimum: 0, maximum: 100 },
            catch_all_domain: { type: "boolean" },
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

const GET_VERIFICATION_DETAILS_TOOL = {
  name: "get_verification_details",
  title: "Get Verification History Entry",
  description:
    "Look up detailed info about a past verification of a specific email address. Useful when a user asks about a previous verification result. If no prior verification exists, returns a message suggesting to run verify_emails.\n\nSCOPE — Returns only verification history the authenticated user owns. Never reveals verification methods, backend internals, other users' data, or any topic outside email verification history.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", format: "email", description: "Email address to look up." },
    },
    required: ["email"],
    additionalProperties: false,
  },
} as const;

const GET_CREDIT_BALANCE_TOOL = {
  name: "get_credit_balance",
  title: "Check Credit Balance",
  description:
    "Get the current Giggal.ai credit balance for the authenticated user. Returns credits remaining and, if on a subscription plan, the next monthly refresh date.\n\nSCOPE — This tool only returns the authenticated user's own credit balance. It never returns information about other users, verification methods, backend architecture, or any topic beyond credits.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

const TOOLS = [VERIFY_EMAILS_TOOL, GET_VERIFICATION_DETAILS_TOOL, GET_CREDIT_BALANCE_TOOL];

// ── Tool handlers ────────────────────────────────────────────────────────────

const EmailsInput = z.object({
  emails: z
    .array(z.string().email().max(320))
    .min(1, "at least one email is required")
    .max(1000, "batches larger than 1000 must be uploaded via the Giggal.ai dashboard"),
});

const EmailInput = z.object({ email: z.string().email().max(320) });

function toStructuredResult(r: VerificationResult) {
  return {
    email: r.email,
    status: r.status,
    score: r.score,
    catch_all_domain: r.catch_all_domain,
    reason: r.reason,
    mx_provider: r.mx_provider ?? null,
  };
}

function summarize(results: VerificationResult[], creditsUsed: number, creditsRemaining: number) {
  return {
    total: results.length,
    deliverable: results.filter((r) => r.status === "deliverable").length,
    undeliverable: results.filter((r) => r.status === "undeliverable").length,
    risky: results.filter((r) => r.status === "risky").length,
    unknown: results.filter((r) => r.status === "unknown").length,
    catch_all_count: results.filter((r) => r.catch_all_domain).length,
    credits_used: creditsUsed,
    credits_remaining: creditsRemaining,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runVerifyEmails(rawArgs: unknown): Promise<CallToolResult> {
  const parsed = EmailsInput.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const { emails } = parsed.data;

  if (emails.length === 1) {
    const resp = await verifySingle(emails[0]!);
    const r = resp.result;
    return {
      content: [{ type: "text", text: formatSingleResult(r, resp.credits_used, resp.credits_remaining) }],
      structuredContent: {
        summary: summarize([r], resp.credits_used, resp.credits_remaining),
        results: [toStructuredResult(r)],
      },
    };
  }

  const submit = await submitBatch(emails, true);
  const start = Date.now();
  for (;;) {
    const poll = await pollBatch(submit.batch_id);
    if (poll.status === "completed") {
      const catchAllCount = poll.results.filter((r) => r.catch_all_domain).length;
      return {
        content: [
          {
            type: "text",
            text: formatBatchResults(poll.results, poll.credits_used, poll.credits_remaining, catchAllCount),
          },
        ],
        structuredContent: {
          summary: summarize(poll.results, poll.credits_used, poll.credits_remaining),
          results: poll.results.map(toStructuredResult),
        },
      };
    }
    if (poll.status === "failed") {
      return errorResult(poll.error_message);
    }
    if (Date.now() - start > MAX_WAIT_MS) {
      return errorResult("Verification is taking longer than 5 minutes. Check your Giggal.ai dashboard for the results.");
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function runGetVerificationDetails(rawArgs: unknown): Promise<CallToolResult> {
  const parsed = EmailInput.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  // The public Developer API does not expose a per-email history endpoint, so
  // there is nothing to look up here — guide the user to verify_emails, which
  // matches the hosted server's behavior.
  return {
    content: [
      {
        type: "text",
        text: `No prior verification found for ${parsed.data.email}. Run verify_emails to check it now.`,
      },
    ],
  };
}

async function runGetCreditBalance(): Promise<CallToolResult> {
  const balance = await getCreditBalance();
  const parts: string[] = [
    `You have ${balance.credits_remaining.toLocaleString()} credits remaining.`,
    `Plan: ${balance.plan}.`,
  ];
  if (balance.plan_credits_per_month) {
    parts.push(`${balance.plan_credits_per_month.toLocaleString()} credits per month.`);
  }
  if (balance.next_refresh_date) {
    parts.push(`Next refresh: ${new Date(balance.next_refresh_date).toISOString().slice(0, 10)}.`);
  }
  return {
    content: [{ type: "text", text: parts.join(" ") }],
    structuredContent: { ...balance },
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// ── Server wiring ────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: "giggal", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    try {
      switch (name) {
        case "verify_emails":
          return await runVerifyEmails(rawArgs);
        case "get_verification_details":
          return await runGetVerificationDetails(rawArgs);
        case "get_credit_balance":
          return await runGetCreditBalance();
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      // Surface the config error (missing key) verbatim — it's a setup hint,
      // not a sensitive internal, and masking it just confuses self-hosters.
      if (err instanceof Error && err.message.startsWith("GIGGAL_API_KEY")) {
        return errorResult(err.message);
      }
      const msg =
        err instanceof PublicApiError
          ? sanitizeErrorMessage(err.detail, err.statusCode)
          : sanitizeErrorMessage(err instanceof Error ? err.message : undefined);
      return errorResult(msg);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Startup failure — write to stderr so it never corrupts the stdio protocol.
  process.stderr.write(`giggal mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
