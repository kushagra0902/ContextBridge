import assert from "node:assert/strict";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { startMcpHttpServer } from "../../dist/runtime/index.js";

const projectId = `ku::project:${"a".repeat(64)}`;
const sessionId = `ku::session:${"b".repeat(64)}`;
const resourceUri = `context-bridge://sessions/${encodeURIComponent(sessionId)}`;
const secret = "cb1.runtime-http-test-secret-0123456789";

test("M16 serves authenticated loopback MCP and session mention resources", async (t) => {
  const server = await startMcpHttpServer({ app: fixtureApp(), secret, port: 0 });
  t.after(() => server.close());

  const unauthorized = await fetch(server.healthUrl);
  assert.equal(unauthorized.status, 401);

  const health = await fetch(server.healthUrl, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");

  const client = new Client({ name: "context-bridge-http-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    authProvider: { token: async () => secret },
  });
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  const modelTools = listed.tools.filter((tool) =>
    !Array.isArray(tool._meta?.ui?.visibility) || !tool._meta.ui.visibility.includes("app"));
  assert.deepEqual(modelTools.map((tool) => tool.name), [
    "list_context_scopes",
    "get_context_overview",
    "search_memory",
    "get_evidence",
  ]);
  const mentionTool = listed.tools.find((tool) => tool.name === "search_mentions");
  assert.deepEqual(mentionTool?._meta?.["openai/extensions"], { "mentions/search": {} });
  assert.deepEqual(mentionTool?._meta?.ui?.visibility, ["app"]);

  const mentions = await client.callTool({ name: "search_mentions", arguments: { query: "sqlite" } });
  assert.equal(mentions.structuredContent.items[0].uri, resourceUri);
  const resource = await client.readResource({ uri: resourceUri });
  assert.equal(JSON.parse(resource.contents[0].text).session.id, sessionId);
});

function fixtureApp() {
  return {
    listContextScopes: async () => ({ status: "empty", scopes: [], ambiguous: false, truncation: { truncated: false, limitsReached: [] } }),
    getContextOverview: async () => ({ status: "empty" }),
    searchMemory: async () => ({ status: "empty", hits: [] }),
    getEvidence: async () => ({ status: "not_found", events: [], chunks: [] }),
    searchSessionReferences: async () => [{
      uri: resourceUri,
      title: "SQLite investigation",
      subtitle: "bridge · main · 2026-10-04",
      description: "Saved, historical Codex session context",
      lastModified: "2026-10-04T01:00:00.000Z",
    }],
    readSessionReference: async (uri) => uri === resourceUri
      ? { status: "ok", session: { id: sessionId, projectId } }
      : undefined,
  };
}
