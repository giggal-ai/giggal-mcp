/**
 * JSON-RPC 2.0 error codes (RFC-style, reserved -32768 to -32000).
 * MCP layers a few of its own on top.
 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // MCP-specific (application-defined range)
  ToolExecutionError: -32000,
  Unauthorized: -32001,
} as const;

export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

export class JsonRpcError extends Error {
  constructor(
    public readonly code: JsonRpcErrorCodeValue,
    message: string,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "JsonRpcError";
  }

  toRpc(id: string | number | null): JsonRpcErrorResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: this.code,
        message: this.message,
        ...(this.data !== undefined ? { data: this.data } : {}),
      },
    };
  }
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}
