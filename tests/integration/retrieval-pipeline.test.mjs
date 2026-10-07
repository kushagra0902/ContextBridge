import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chunkId,
  eventId,
  memoryId,
  projectId,
  sessionId,
  sourceId,
} from "../../dist/contracts/ids.js";
import {
  classifyQuery,
  diversifyHits,
  expandEvidence,
  fuseCandidates,
  orderByChronology,
  packSearchHits,
  resolveScope,
  retrieveLexical,
  validateHits,
} from "../../dist/retrieval/index.js";
import { openSqliteStorage } from "../../dist/storage/sqlite/index.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-retrieval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("lexical retrieval resolves one scope, hydrates provenance, expands tool pairs, packs, and honors tombstones", async (t) => {
  const directory = await temporaryDirectory(t);
  const storage = await openSqliteStorage({
    databaseFile: join(directory, "retrieval.sqlite"),
    backupBeforeMigration: false,
  });
  t.after(() => storage.close().catch(() => undefined));

  const project = projectId(["retrieval-project"]);
  const twinOne = projectId(["twin-one"]);
  const twinTwo = projectId(["twin-two"]);
  const session = sessionId(["retrieval-session"]);
  const sourceValue = sourceId(["retrieval-source"]);
  await storage.scopes.upsertScopes([
    { kind: "project", id: project, displayName: "Retrieval" },
    { kind: "project", id: twinOne, displayName: "Twin" },
    { kind: "project", id: twinTwo, displayName: "Twin" },
    { kind: "session", id: session, projectId: project, title: "Debug Retrieval" },
  ]);

  const source = {
    id: sourceValue,
    kind: "codex_rollout",
    normalizedPath: "/synthetic/retrieval.jsonl",
    formatVersion: "synthetic-v1",
    fileIdentity: {
      device: "synthetic-device",
      inode: "synthetic-inode",
      size: 5_000,
      modifiedAtMs: 1_800_000_000_000,
    },
  };
  const records = [
    ["user_message", "Run Widget.run", undefined],
    ["assistant_message", "TypeError: Widget.run failed at src/widget.ts:9 because input was empty", undefined],
    ["tool_call", "execute Widget.run with diagnostics secret-token", "call-1"],
    ["tool_result", "Widget.run returned exit code 1", "call-1"],
  ];
  const events = records.map(([kind, text, toolCallId], ordinal) => ({
    id: eventId([session, String(ordinal)]),
    sessionId: session,
    ordinal,
    kind,
    observedAt: new Date(Date.UTC(2026, 5, ordinal + 1)).toISOString(),
    text,
    contentHash: `content-${ordinal}`,
    EvidenceSource: {
      sourceId: sourceValue,
      sourceOrdinal: ordinal,
      byteStart: ordinal * 100,
      byteEnd: ordinal * 100 + 99,
      formatVersion: "synthetic-v1",
    },
    ...(toolCallId === undefined ? {} : { toolCallId }),
  }));
  await storage.evidence.commitBatch(
    { source, events },
    {
      sourceId: sourceValue,
      fileFingerprint: "retrieval-fixture",
      committedByteOffset: 400,
      lastCompleteLineHash: "line-four",
    },
  );

  const chunk = {
    id: chunkId([session, "chunk"]),
    sequence: 0,
    scope: { projectId: project, sessionId: session },
    eventIds: events.map((event) => event.id),
    displayText: events.map((event) => event.text).join("\n"),
    embeddingText: "Widget.run TypeError empty input diagnostics exit code",
    tokenCount: 20,
    fingerprint: "retrieval-chunk-fingerprint",
    observedFrom: events[0].observedAt,
    observedTo: events.at(-1).observedAt,
  };
  const decision = {
    id: memoryId([session, "decision"]),
    type: "decision",
    scope: { projectId: project, sessionId: session },
    title: "Validate Widget input",
    body: "We decided to validate input before Widget.run because empty input caused the failure.",
    status: "active",
    evidenceIds: [chunk.id],
    derivation: "extractive",
    extractorVersion: "retrieval-test-v1",
    observedFrom: chunk.observedFrom,
    observedTo: chunk.observedTo,
    derivedAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    decision: "Validate input before Widget.run",
    rationale: "Empty input caused the failure",
    alternatives: [],
    constraints: [],
    affectedEntities: ["Widget.run"],
  };
  await storage.derivedData.commit({
    upsertChunks: [chunk],
    deleteChunkIds: [],
    upsertMemories: [decision],
    deleteMemoryIds: [],
    embeddingJobs: [],
  });

  const resolved = await resolveScope({ query: "Retrieval" }, storage.scopes);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.scope.id, project);
  const ambiguous = await resolveScope({ query: "Twin" }, storage.scopes);
  assert.equal(ambiguous.status, "ambiguous");

  const query = "TypeError: Widget.run failed at src/widget.ts:9 because input was empty";
  const intent = classifyQuery(query);
  assert.equal(intent, "exact_error");
  const candidates = await retrieveLexical({
    query,
    intent,
    scope: { projectId: project, sessionId: session },
    limit: 20,
  }, {
    lexicalSearch: storage.lexicalSearch,
    memories: storage.memories,
    evidence: storage.evidence,
  });
  assert.ok(candidates.some((candidate) => candidate.entity.id === chunk.id));
  const fused = fuseCandidates([candidates], { intent, explicitScope: true });
  const hydrated = await validateHits({
    candidates: fused,
    scope: { projectId: project, sessionId: session },
  }, {
    evidence: storage.evidence,
    memories: storage.memories,
  });
  assert.ok(hydrated.some((hit) => hit.entity.id === chunk.id));
  assert.deepEqual(hydrated.find((hit) => hit.entity.id === chunk.id).evidenceIds, chunk.eventIds);
  const ordered = diversifyHits(orderByChronology(hydrated, intent), 20);
  const packed = await packSearchHits(ordered, {
    budget: { maxItems: 10, maxBytes: 20_000, maxTokens: 20_000 },
    cursorSecret: "integration-cursor-secret",
    contextKey: `${project}:${query}`,
    outputPolicy: { sanitizeText: async (text) => text.replaceAll("secret-token", "[REDACTED]") },
  });
  assert.ok(packed.hits.length > 0);
  assert.equal(JSON.stringify(packed).includes("secret-token"), false);

  const expanded = await expandEvidence({
    evidenceIds: [events[2].id],
    beforeEvents: 0,
    afterEvents: 0,
    budget: { maxItems: 10, maxBytes: 20_000, maxTokens: 20_000 },
  }, {
    evidence: storage.evidence,
    scopes: storage.scopes,
    outputPolicy: { sanitizeText: async (text) => text.replaceAll("secret-token", "[REDACTED]") },
  }, {
    scope: { projectId: project, sessionId: session },
  });
  assert.deepEqual(expanded.events.map((event) => event.kind), ["tool_call", "tool_result"]);
  assert.equal(JSON.stringify(expanded).includes("secret-token"), false);

  await storage.scopes.upsertExclusion({
    scope: { projectId: project },
    reason: "forgotten",
    blocksIngestion: true,
    status: "excluded",
    excludedAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  });
  assert.deepEqual(await validateHits({
    candidates: fused,
    scope: { projectId: project, sessionId: session },
  }, {
    evidence: storage.evidence,
    memories: storage.memories,
  }), []);
});
