import type { FastifyReply } from "fastify";

/**
 * MCP Streamable-HTTP SSE writer.
 *
 * The MCP spec lets a tool/call response be either plain JSON or an SSE
 * stream. Streaming is required when the server wants to emit
 * `notifications/progress` between the tool invocation and its result —
 * exactly our case for long-running verify_emails batches.
 *
 * Each frame on the wire is a JSON-RPC message serialised as a single SSE
 * `data:` line. That's it — no event types, no ids.
 */
export class McpSseWriter {
  private opened = false;

  constructor(private readonly reply: FastifyReply) {}

  private open(): void {
    if (this.opened) return;
    this.opened = true;
    this.reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell Fastify not to try to serialise a body.
      "X-Accel-Buffering": "no",
    });
  }

  /** Emit a JSON-RPC notification/progress event to the client. */
  progress(progressToken: string | number, progress: number, total?: number, message?: string): void {
    this.open();
    const params: Record<string, unknown> = { progressToken, progress };
    if (total !== undefined) params.total = total;
    if (message) params.message = message;
    this.send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params,
    });
  }

  /** Emit the final JSON-RPC response and end the stream. */
  finish(response: unknown): void {
    this.open();
    this.send(response);
    this.reply.raw.end();
  }

  private send(message: unknown): void {
    // SSE frame: `data: <json>\n\n`
    this.reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
  }
}
