import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { createMcpServer, type McpReadApplication } from "../mcp/index.js";
import { validateLocalRequest } from "../security/local-auth.js";

export interface McpHttpServerOptions {
  readonly app: McpReadApplication;
  readonly secret: string;
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly maxRequestBytes?: number;
  readonly maxConcurrentRequests?: number;
  readonly onError?: (code: string) => void;
}

export interface McpHttpServerHandle {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly url: string;
  readonly healthUrl: string;
  close(): Promise<void>;
}

export async function startMcpHttpServer(
  options: McpHttpServerOptions,
): Promise<McpHttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3847;
  const maxRequestBytes = boundedPositive(options.maxRequestBytes ?? 1_048_576, "request byte limit");
  const maxConcurrentRequests = boundedPositive(options.maxConcurrentRequests ?? 16, "concurrency limit");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("HTTP port must be from 0 to 65535");
  }
  const mcpHandler = createMcpHandler(() => createMcpServer(options.app), {
    legacy: "stateless",
    maxRequestBodySize: maxRequestBytes,
    keepAliveMs: 15_000,
    onerror: () => options.onError?.("MCP_HANDLER_ERROR"),
  });
  const nodeHandler = toNodeHandler(mcpHandler, {
    maxRequestBodySize: maxRequestBytes,
    onerror: () => options.onError?.("MCP_HTTP_ADAPTER_ERROR"),
  });
  let activeRequests = 0;
  let closing = false;
  const server = createServer(async (request, response) => {
    try {
      if (closing) return writeJson(response, 503, { status: "stopping" });
      const pathname = requestPath(request);
      if (pathname === undefined) return writeJson(response, 400, { status: "invalid_request" });
      if (pathname !== "/mcp" && pathname !== "/healthz" && pathname !== "/readyz") {
        return writeJson(response, 404, { status: "not_found" });
      }
      const hostHeader = header(request, "host");
      const origin = header(request, "origin");
      const authorization = header(request, "authorization");
      const decision = await validateLocalRequest({
        ...(hostHeader === undefined ? {} : { host: hostHeader }),
        ...(origin === undefined ? {} : { origin }),
        ...(authorization === undefined ? {} : { authorization }),
      }, options.secret);
      if (!decision.allowed) {
        const status = decision.reason === "missing_token" || decision.reason === "invalid_token" ? 401 : 403;
        response.setHeader("WWW-Authenticate", "Bearer");
        return writeJson(response, status, { status: "unauthorized" });
      }
      if (pathname === "/healthz" || pathname === "/readyz") {
        if (request.method !== "GET") return writeJson(response, 405, { status: "method_not_allowed" });
        return writeJson(response, 200, {
          status: "ok",
          service: "context-bridge",
          transport: "streamable-http",
        });
      }
      if (activeRequests >= maxConcurrentRequests) {
        response.setHeader("Retry-After", "1");
        return writeJson(response, 429, { status: "busy" });
      }
      activeRequests += 1;
      try {
        await nodeHandler(
          request as unknown as Parameters<typeof nodeHandler>[0],
          response,
        );
      } finally {
        activeRequests -= 1;
      }
    } catch {
      options.onError?.("HTTP_REQUEST_ERROR");
      if (!response.headersSent) writeJson(response, 500, { status: "error" });
      else response.destroy();
    }
  });
  hardenServer(server);
  await listen(server, port, host);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeNodeServer(server);
    throw new Error("HTTP server did not expose a TCP address");
  }
  const actualPort = address.port;
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/mcp`,
    healthUrl: `http://${host}:${actualPort}/healthz`,
    async close() {
      if (closing) return;
      closing = true;
      await Promise.allSettled([mcpHandler.close(), closeNodeServer(server)]);
    },
  };
}

function requestPath(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(response: ServerResponse, status: number, value: object): void {
  if (response.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function hardenServer(server: Server): void {
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 5_000);
    timer.unref();
  });
}

function boundedPositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be positive`);
  return value;
}
