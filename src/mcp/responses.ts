import type { CallToolResult } from "@modelcontextprotocol/server";

import { isContextBridgeError } from "../contracts/errors.js";

export interface McpErrorBody {
  readonly status: "error";
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export function toMcpResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ...value },
  };
}

export function toMcpError(error: unknown): CallToolResult {
  const body: McpErrorBody = isContextBridgeError(error)
    ? { status: "error", error: { code: error.code, message: error.message } }
    : error instanceof RangeError
      ? { status: "error", error: { code: "LIMIT_EXCEEDED", message: error.message } }
      : error instanceof TypeError
        ? { status: "error", error: { code: "INVALID_INPUT", message: error.message } }
        : { status: "error", error: { code: "INTERNAL_ERROR", message: "The retrieval operation failed" } };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: { ...body },
  };
}
