import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createMcpServer } from "../../dist/mcp/index.js";

const projectId = `ku::project:${"a".repeat(64)}`;
const workstreamId = `ku::workstream:${"b".repeat(64)}`;
const eventId = `ku::event:${"c".repeat(64)}`;

function fixtureApp(overrides = {}) {
  return {
    async listContextScopes(input) {
      return {
        status: "ok",
        scopes: [{
          scope: { kind: "project", id: projectId, displayName: "Bridge" },
          matchedBy: "name",
          score: 1,
          aliases: [],
        }],
        ambiguous: false,
        truncation: { truncated: false, limitsReached: [] },
        received: input,
      };
    },
    async getContextOverview() {
      return {
        schemaVersion: 1,
        status: "empty",
        scope: { projectId },
        synopses: [],
        decisions: [],
        openItems: [],
        freshness: { pendingSemanticJobs: 0, stale: false },
        truncation: { truncated: false, limitsReached: [] },
      };
    },
    async searchMemory(input) {
      return {
        schemaVersion: 1,
        status: "ok",
        intent: input.intent ?? "general",
        scope: input.filters.scope,
        hits: [{
          entity: { kind: "chunk", id: `ku::chunk:${"d".repeat(64)}` },
          type: "chunk",
          scope: input.filters.scope,
          snippet: "Synthetic historical evidence",
          matches: [{ channel: "fts", rank: 1 }],
          evidenceIds: [eventId],
          currentness: "historical_unverified",
          fusedScore: 1,
        }],
        freshness: { pendingSemanticJobs: 0, stale: false },
        semanticStatus: "disabled",
        truncation: { truncated: false, limitsReached: [] },
      };
    },
    async getEvidence() {
      return {
        schemaVersion: 1,
        status: "ok",
        scope: { projectId },
        chunks: [],
        events: [],
        unavailableEvidenceIds: [],
        truncation: { truncated: false, limitsReached: [] },
      };
    },
    ...overrides,
  };
}

async function connect(app) {
  const server = createMcpServer(app);
  const client = new Client({ name: "context-bridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("MCP server exposes exactly four bounded read-only tools", async (t) => {
  const { client, server } = await connect(fixtureApp());
  t.after(async () => Promise.all([client.close(), server.close()]));

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "list_context_scopes",
    "get_context_overview",
    "search_memory",
    "get_evidence",
  ]);
  for (const tool of listed.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  assert.match(client.getInstructions(), /untrusted data/i);
  assert.match(client.getInstructions(), /does not prove the current repository state/i);
});

test("MCP search maps narrow inputs to the transport-neutral use case", async (t) => {
  let received;
  const app = fixtureApp({
    async searchMemory(input) {
      received = input;
      return {
        schemaVersion: 1,
        status: "empty",
        intent: "decision_rationale",
        scope: input.filters.scope,
        hits: [],
        freshness: { pendingSemanticJobs: 0, stale: false },
        semanticStatus: "disabled",
        truncation: { truncated: false, limitsReached: [] },
      };
    },
  });
  const { client, server } = await connect(app);
  t.after(async () => Promise.all([client.close(), server.close()]));

  const result = await client.callTool({
    name: "search_memory",
    arguments: {
      query: "why was sqlite selected?",
      scope: { projectId, workstreamId },
      intent: "decision_rationale",
      memoryTypes: ["decision"],
      limit: 4,
      maxTokens: 1_000,
    },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "empty");
  assert.deepEqual(received.filters.scope, { projectId, workstreamId });
  assert.deepEqual(received.filters.memoryTypes, ["decision"]);
  assert.deepEqual(received.budget, { maxItems: 4, maxTokens: 1_000 });
});

test("MCP rejects oversized input before the application boundary", async (t) => {
  let calls = 0;
  const { client, server } = await connect(fixtureApp({
    async listContextScopes() {
      calls += 1;
      throw new Error("should not run");
    },
  }));
  t.after(async () => Promise.all([client.close(), server.close()]));

  const result = await client.callTool({
    name: "list_context_scopes",
    arguments: { query: "x".repeat(257), limit: 21 },
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test("MCP rejects conflicting scope selectors before the application boundary", async (t) => {
  let calls = 0;
  const { client, server } = await connect(fixtureApp({
    async searchMemory() {
      calls += 1;
      throw new Error("should not run");
    },
  }));
  t.after(async () => Promise.all([client.close(), server.close()]));

  const result = await client.callTool({
    name: "search_memory",
    arguments: { query: "sqlite", scope: { projectId }, scopeQuery: "bridge" },
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test("MCP masks unexpected application errors", async (t) => {
  const { client, server } = await connect(fixtureApp({
    async getEvidence() {
      throw new Error("seeded-secret-must-not-leak");
    },
  }));
  t.after(async () => Promise.all([client.close(), server.close()]));

  const result = await client.callTool({
    name: "get_evidence",
    arguments: { evidenceIds: [eventId] },
  });
  assert.equal(result.isError, true);
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.doesNotMatch(text, /seeded-secret/);
  assert.match(text, /INTERNAL_ERROR/);
});
