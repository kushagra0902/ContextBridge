import assert from "node:assert/strict";
import test from "node:test";

import { projectId, chunkId, eventId, sessionId, vectorId } from "../../../dist/contracts/ids.js";
import {
  classifyQuery,
  decodeSearchCursor,
  diversifyHits,
  fuseCandidates,
  orderByChronology,
  packSearchHits,
  retrieveSemantic,
  validateHits,
} from "../../../dist/retrieval/index.js";

const project = projectId(["retrieval-unit"]);
const firstChunk = chunkId(["retrieval-unit", "one"]);
const secondChunk = chunkId(["retrieval-unit", "two"]);
const firstEvent = eventId(["retrieval-unit", "event-one"]);
const secondEvent = eventId(["retrieval-unit", "event-two"]);

test("query intent rules identify exact, rationale, chronology, open-item and overview queries", () => {
  assert.equal(classifyQuery("TypeError: Widget.run failed"), "exact_error");
  assert.equal(classifyQuery("where is src/retrieval/pack.ts used?"), "exact_identifier");
  assert.equal(classifyQuery("why was SQLite chosen?"), "decision_rationale");
  assert.equal(classifyQuery("show the timeline before launch"), "chronology");
  assert.equal(classifyQuery("what TODO items are remaining?"), "open_items");
  assert.equal(classifyQuery("summarize the project"), "broad_synthesis");
  assert.throws(() => classifyQuery("   "), /search query/i);
});

test("RRF rewards exact matches, chronology preserves superseded history, and diversification removes duplicate evidence", () => {
  const scope = { projectId: project };
  const exact = { entity: { kind: "chunk", id: firstChunk }, scope, channel: "exact", rank: 2 };
  const fts = { entity: { kind: "chunk", id: firstChunk }, scope, channel: "fts", rank: 1 };
  const other = { entity: { kind: "chunk", id: secondChunk }, scope, channel: "fts", rank: 1 };
  const fused = fuseCandidates([[fts, other], [exact]], { intent: "exact_identifier" });
  assert.equal(fused[0].entity.id, firstChunk);
  assert.deepEqual(fused[0].matches.map((match) => match.channel), ["fts", "exact"]);

  const older = {
    entity: { kind: "chunk", id: firstChunk },
    type: "chunk",
    scope,
    snippet: "older",
    matches: [],
    evidenceIds: [firstEvent],
    observedAt: "2026-01-01T00:00:00.000Z",
    currentness: "superseded",
    fusedScore: 2,
  };
  const newer = {
    ...older,
    entity: { kind: "chunk", id: secondChunk },
    snippet: "newer",
    evidenceIds: [secondEvent],
    observedAt: "2026-02-01T00:00:00.000Z",
    currentness: "historical_unverified",
    fusedScore: 1,
  };
  assert.deepEqual(orderByChronology([older, newer], "chronology").map((hit) => hit.snippet), ["older", "newer"]);
  assert.deepEqual(orderByChronology([older, newer], "latest_state").map((hit) => hit.snippet), ["newer", "older"]);
  assert.equal(diversifyHits([newer, { ...older, evidenceIds: [secondEvent] }], 10).length, 1);
});

test("packing sanitizes text, enforces hard limits, and binds signed cursors to a request", async () => {
  const scope = { projectId: project };
  const hits = [firstChunk, secondChunk].map((id, index) => ({
    entity: { kind: "chunk", id },
    type: "chunk",
    scope,
    snippet: `private-${index} ${"detail ".repeat(30)}`,
    matches: [{ channel: "fts", rank: index + 1 }],
    evidenceIds: [index === 0 ? firstEvent : secondEvent],
    currentness: "historical_unverified",
    fusedScore: 1 - index / 10,
  }));
  const secret = "unit-test-cursor-secret";
  const packed = await packSearchHits(hits, {
    budget: { maxItems: 1, maxBytes: 2_000, maxTokens: 2_000 },
    cursorSecret: secret,
    contextKey: "query-a",
    outputPolicy: { sanitizeText: async (text) => text.replaceAll("private", "[redacted]") },
  });
  assert.equal(packed.hits.length, 1);
  assert.match(packed.hits[0].snippet, /\[redacted\]/u);
  assert.equal(packed.truncation.truncated, true);
  assert.ok(packed.continuation);
  assert.equal(decodeSearchCursor(packed.continuation, secret, "query-a"), 1);
  assert.throws(() => decodeSearchCursor(packed.continuation, secret, "query-b"), /does not match/i);
});

test("semantic retrieval degrades cleanly when no vector capability is installed", async () => {
  const result = await retrieveSemantic(
    { query: "why did this happen?", scope: { projectId: project } },
    {},
  );
  assert.deepEqual(result, { status: "disabled", candidates: [] });
});

test("semantic retrieval uses the active space and SQLite validation rejects a stale fingerprint", async () => {
  const session = sessionId(["retrieval-unit-session"]);
  const vector = vectorId(["retrieval-unit-vector"]);
  const space = {
    id: "space-v1",
    provider: "local_transformers",
    modelId: "fixture-model",
    modelRevision: "one",
    dimension: 2,
    distanceMetric: "cosine",
    normalization: "l2",
    tokenizerVersion: "one",
    preprocessingVersion: "one",
    redactionVersion: "one",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const semantic = await retrieveSemantic({
    query: "conceptual failure cause",
    scope: { projectId: project, sessionId: session },
  }, {
    provider: {
      manifest: () => space,
      capability: async () => ({ status: "ready", provider: "local_transformers", modelCached: true }),
      embedDocuments: async () => [],
      embedQuery: async () => new Float32Array([0.5, 0.5]),
    },
    embeddingJobs: { getActiveSpace: async () => space },
    vectorIndex: {
      health: async () => ({ status: "ready", activeSpaceId: space.id, vectorCount: 1, pendingJobs: 0, failedJobs: 0, staleVectorRejects: 0 }),
      search: async () => [{
        id: vector,
        entity: { kind: "chunk", id: firstChunk },
        spaceId: space.id,
        fingerprint: "stale-fingerprint",
        distance: 0.1,
        rank: 1,
      }],
    },
  });
  assert.equal(semantic.status, "ready");
  const fused = fuseCandidates([semantic.candidates], { intent: "general" });
  const chunk = {
    id: firstChunk,
    sequence: 0,
    scope: { projectId: project, sessionId: session },
    eventIds: [firstEvent],
    displayText: "authoritative content",
    embeddingText: "authoritative content",
    tokenCount: 2,
    fingerprint: "current-fingerprint",
  };
  const validated = await validateHits({
    candidates: fused,
    scope: { projectId: project, sessionId: session },
    semanticSpaceId: space.id,
  }, {
    evidence: { getChunks: async () => [chunk] },
    memories: { get: async () => [] },
    embeddingJobs: {
      getRecords: async () => [{
        entity: { kind: "chunk", id: firstChunk },
        spaceId: space.id,
        fingerprint: "current-fingerprint",
        vectorId: vector,
        indexedAt: "2026-01-02T00:00:00.000Z",
      }],
    },
  });
  assert.deepEqual(validated, []);
});
