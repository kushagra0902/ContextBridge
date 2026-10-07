import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { createMentions } from "@openai/mcp-extensions/server";

import { createMcpHandlers, type McpReadApplication } from "./handlers.js";
import { MCP_SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./instructions.js";
import {
  getContextOverviewInputSchema,
  getEvidenceInputSchema,
  listContextScopesInputSchema,
  searchMemoryInputSchema,
} from "./tool-schemas.js";
import { SESSION_RESOURCE_TEMPLATE } from "./session-references.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createMcpServer(app: McpReadApplication): McpServer {
  const server = new McpServer(
    { name: "context-bridge", version: "0.0.0" },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const handlers = createMcpHandlers(app);

  server.registerTool("list_context_scopes", {
    title: "List context scopes",
    description: TOOL_DESCRIPTIONS.listContextScopes,
    inputSchema: listContextScopesInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, handlers.listContextScopes);

  server.registerTool("get_context_overview", {
    title: "Get context overview",
    description: TOOL_DESCRIPTIONS.getContextOverview,
    inputSchema: getContextOverviewInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, handlers.getContextOverview);

  server.registerTool("search_memory", {
    title: "Search memory",
    description: TOOL_DESCRIPTIONS.searchMemory,
    inputSchema: searchMemoryInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, handlers.searchMemory);

  server.registerTool("get_evidence", {
    title: "Get evidence",
    description: TOOL_DESCRIPTIONS.getEvidence,
    inputSchema: getEvidenceInputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
  }, handlers.getEvidence);

  registerSessionReferences(server, app);

  return server;
}

function registerSessionReferences(server: McpServer, app: McpReadApplication): void {
  if (app.searchSessionReferences === undefined || app.readSessionReference === undefined) return;

  // The OpenAI extension package currently types its helper against MCP SDK v1,
  // while Context Bridge uses the split v2 SDK. The helper only requires the
  // compatible registerTool surface at runtime.
  const mentions = createMentions(
    server as unknown as Parameters<typeof createMentions>[0],
  );
  mentions.setHandler(async ({ query }) => {
    if (query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query)) return { items: [] };
    const references = await app.searchSessionReferences?.(query) ?? [];
    return {
      items: references.slice(0, 20).map((reference) => ({
        type: "resource_link" as const,
        uri: reference.uri,
        name: reference.title,
        title: reference.title,
        ...(reference.description === undefined ? {} : { description: reference.description }),
        mimeType: "application/json",
        annotations: {
          audience: ["user" as const, "assistant" as const],
          priority: 1,
          ...(reference.lastModified === undefined ? {} : { lastModified: reference.lastModified }),
        },
        ...(reference.subtitle === undefined ? {} : { _meta: { "openai/subtitle": reference.subtitle } }),
      })),
    };
  });

  server.registerResource(
    "codex-session-context",
    new ResourceTemplate(SESSION_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "Codex session context",
      description: "A bounded, redacted historical overview for one tagged Codex session.",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await app.readSessionReference?.(uri.href);
      const body = result ?? { status: "not_found" };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body) }],
      };
    },
  );
}

export interface McpStdioHandle extends StdioServerHandle {
  readonly closed: Promise<void>;
}

/** Serves the read-only MCP surface over stdio. Loopback HTTP belongs to M16. */
export function serveMcpStdio(app: McpReadApplication): McpStdioHandle {
  const transport = new StdioServerTransport();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const handle = serveStdio(() => createMcpServer(app), { transport });
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    resolveClosed();
  };
  return {
    closed,
    async close() {
      await handle.close();
      resolveClosed();
    },
  };
}
