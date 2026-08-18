import type { McpUser } from "../auth.js";

/**
 * MCP tool call response shape. `content` is what the user's AI client
 * renders in chat; `structuredContent` is machine-readable JSON that
 * downstream automation or the AI can parse programmatically.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export type ProgressCallback = (update: ProgressUpdate) => void;

export interface ToolExecutorArgs {
  arguments: unknown;
  user: McpUser;
  /**
   * Optional — set only when the client requested progress notifications
   * via `_meta.progressToken`. Tools that support progress SHOULD call it
   * during long-running work; tools that don't just ignore it.
   */
  onProgress?: ProgressCallback;
}

export type ToolExecutor = (args: ToolExecutorArgs) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  annotations: { readOnlyHint?: true; destructiveHint?: true };
  inputSchema: Record<string, unknown>;
  /**
   * Optional JSON Schema describing the shape of `structuredContent` in the
   * tool result. When present, clients render structured results as a
   * schema-aware view — see MCP spec §Tools/Output Schema.
   */
  outputSchema?: Record<string, unknown>;
}
