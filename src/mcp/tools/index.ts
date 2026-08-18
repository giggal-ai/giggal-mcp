import * as verifyEmails from "./verifyEmails.js";
import * as getCreditBalance from "./getCreditBalance.js";
import * as getVerificationDetails from "./getVerificationDetails.js";
import type { ToolDefinition, ToolExecutor } from "./types.js";

interface RegisteredTool {
  definition: ToolDefinition;
  run: ToolExecutor;
}

/**
 * Registry of every tool the server exposes. Kept as a Map keyed by name
 * so tools/call dispatch is O(1).
 */
export const TOOLS: Map<string, RegisteredTool> = new Map([
  [verifyEmails.TOOL_DEFINITION.name, { definition: verifyEmails.TOOL_DEFINITION as ToolDefinition, run: verifyEmails.run }],
  [getCreditBalance.TOOL_DEFINITION.name, { definition: getCreditBalance.TOOL_DEFINITION as ToolDefinition, run: getCreditBalance.run }],
  [getVerificationDetails.TOOL_DEFINITION.name, { definition: getVerificationDetails.TOOL_DEFINITION as ToolDefinition, run: getVerificationDetails.run }],
]);

/** All tool definitions in the order clients should see them. */
export function listTools(): ToolDefinition[] {
  return [...TOOLS.values()].map((t) => t.definition);
}
