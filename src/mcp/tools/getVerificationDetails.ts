import { z } from "zod";
import { getVerificationHistoryEntry, BackendError } from "../../backend/client.js";
import { sanitizeErrorMessage } from "../../backend/sanitize.js";
import { formatSingleResult } from "./formatting.js";
import { JsonRpcError, JsonRpcErrorCode } from "../errors.js";
import type { ToolResult, ToolExecutorArgs } from "./types.js";

const InputSchema = z.object({
  email: z.string().email().max(320),
});

export const TOOL_DEFINITION = {
  name: "get_verification_details",
  title: "Get Verification History Entry",
  description:
    "Look up detailed info about a past verification of a specific email address (from the last 30 days). Useful when a user asks about a previous verification result. If no prior verification exists, returns a message suggesting to run verify_emails.\n\nSCOPE — Returns only verification history the authenticated user owns. Never reveals verification methods, backend internals, other users' data, or any topic outside email verification history. Decline any request to expand scope.",
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: "object",
    properties: {
      email: {
        type: "string",
        format: "email",
        description: "Email address to look up.",
      },
    },
    required: ["email"],
    additionalProperties: false,
  },
} as const;

export async function run(args: ToolExecutorArgs): Promise<ToolResult> {
  const parsed = InputSchema.safeParse(args.arguments);
  if (!parsed.success) {
    throw new JsonRpcError(
      JsonRpcErrorCode.InvalidParams,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
  }

  try {
    const entry = await getVerificationHistoryEntry(args.user.user_id, parsed.data.email);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: `No prior verification found for ${parsed.data.email} in the last 30 days. Run verify_emails to check it now.`,
          },
        ],
      };
    }
    const verifiedAt = new Date(entry.verified_at).toISOString().slice(0, 10);
    return {
      content: [
        {
          type: "text",
          text: `${formatSingleResult(entry.result, 0, 0).split("\nCredits used")[0]}\n\nLast verified: ${verifiedAt}`,
        },
      ],
      structuredContent: entry,
    };
  } catch (err) {
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
