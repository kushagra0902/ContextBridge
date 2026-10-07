import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { eventId, projectId, sessionId, sourceId } from "../../dist/contracts/ids.js";
import { syncSessionChunks } from "../../dist/processing/chunks/index.js";
import { openSqliteStorage } from "../../dist/storage/sqlite/index.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-chunks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("canonical events become bounded searchable chunks and incremental resync touches only affected rows", async (t) => {
  const directory = await temporaryDirectory(t);
  const storage = await openSqliteStorage({
    databaseFile: join(directory, "pipeline.sqlite"),
    backupBeforeMigration: false,
  });
  t.after(() => storage.close().catch(() => undefined));

  const project = projectId(["remote", "example.invalid/team/chunks"]);
  const session = sessionId(["session", "chunk-pipeline"]);
  const sourceIdValue = sourceId(["codex_rollout", "/synthetic/chunks.jsonl"]);
  const source = {
    id: sourceIdValue,
    kind: "codex_rollout",
    normalizedPath: "/synthetic/chunks.jsonl",
    formatVersion: "synthetic-v1",
    fileIdentity: {
      device: "synthetic-device",
      inode: "synthetic-inode",
      size: 20_000,
      modifiedAtMs: 1_800_000_000_000,
    },
  };
  await storage.scopes.upsertScopes([
    { kind: "project", id: project, displayName: "Chunk Pipeline" },
    { kind: "session", id: session, projectId: project },
  ]);

  const texts = [
    ["user_message", "Find the pipeline regression"],
    ["assistant_message", "I will inspect the failing command"],
    ["user_message", "Run a focused verification"],
    ["tool_call", "tool: shell\ninput: npm test", "pipeline-call"],
    [
      "tool_result",
      `${"progress line\n".repeat(40)}TypeError: DistinctivePipelineFailure at src/pipeline.ts:42\nfinal diagnostic tail`,
      "pipeline-call",
    ],
    ["user_message", "What remains to be fixed?"],
  ];
  const events = texts.map(([kind, text, toolCallId], ordinal) => ({
    id: eventId([session, String(ordinal), kind]),
    sessionId: session,
    ordinal,
    kind,
    observedAt: new Date(Date.UTC(2026, 4, 1, 0, ordinal)).toISOString(),
    text,
    contentHash: `content-${ordinal}`,
    EvidenceSource: {
      sourceId: sourceIdValue,
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
      sourceId: sourceIdValue,
      fileFingerprint: "fingerprint-one",
      committedByteOffset: 1_000,
      lastCompleteLineHash: "line-six",
    },
  );

  const policy = {
    targetTokens: 24,
    maxTokens: 40,
    maxToolOutputCharacters: 180,
  };
  const first = await syncSessionChunks(storage, session, policy);
  assert.ok(first.chunkCount >= 3);
  assert.equal(first.upsertedChunks, first.chunkCount);
  assert.equal(first.chunks.every((chunk) => chunk.tokenCount <= 40), true);
  assert.equal(
    first.chunks.some((chunk) => chunk.omissions?.length > 0),
    true,
  );

  const hits = await storage.lexicalSearch.search(
    "DistinctivePipelineFailure",
    { scope: { projectId: project, sessionId: session } },
    10,
  );
  assert.ok(hits.length >= 1);
  const selected = (await storage.evidence.getChunks([hits[0].entity.id]))[0];
  assert.ok(selected?.displayText.includes("DistinctivePipelineFailure"));
  const neighborhood = await storage.evidence.getEventNeighborhood(
    [selected.eventIds[0]],
    1,
    1,
    10,
  );
  assert.ok(neighborhood.length >= 1);

  const replay = await syncSessionChunks(storage, session, policy);
  assert.equal(replay.upsertedChunks, 0);
  assert.equal(replay.deletedChunks, 0);
  assert.equal(replay.unchangedChunks, replay.chunkCount);

  const appended = {
    ...events[0],
    id: eventId([session, "6", "assistant_message"]),
    ordinal: 6,
    kind: "assistant_message",
    observedAt: new Date(Date.UTC(2026, 4, 1, 0, 6)).toISOString(),
    text: "Only the final state transition remains.",
    contentHash: "content-6",
    EvidenceSource: {
      sourceId: sourceIdValue,
      sourceOrdinal: 6,
      byteStart: 1_000,
      byteEnd: 1_099,
      formatVersion: "synthetic-v1",
    },
  };
  await storage.evidence.commitBatch(
    { source, events: [appended] },
    {
      sourceId: sourceIdValue,
      fileFingerprint: "fingerprint-two",
      committedByteOffset: 1_100,
      lastCompleteLineHash: "line-seven",
    },
  );
  const incremental = await syncSessionChunks(storage, session, policy);
  assert.ok(incremental.unchangedChunks >= 1);
  assert.ok(incremental.upsertedChunks >= 1);
  assert.ok(incremental.deletedChunks >= 1);
  assert.equal(
    (await storage.evidence.listSessionChunks(session, 100)).length,
    incremental.chunkCount,
  );
});
