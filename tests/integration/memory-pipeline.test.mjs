import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  eventId,
  projectId,
  sessionId,
  sourceId,
} from "../../dist/contracts/ids.js";
import { collectMemoryEvidenceIds } from "../../dist/contracts/memory.js";
import { syncSessionChunks } from "../../dist/processing/chunks/index.js";
import { syncSessionMemories } from "../../dist/processing/memory/index.js";
import { openSqliteStorage } from "../../dist/storage/sqlite/index.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("chunks become evidence-backed searchable memories with stable incremental updates", async (t) => {
  const directory = await temporaryDirectory(t);
  const storage = await openSqliteStorage({
    databaseFile: join(directory, "pipeline.sqlite"),
    backupBeforeMigration: false,
  });
  t.after(() => storage.close().catch(() => undefined));

  const project = projectId(["remote", "example.invalid/team/memory"]);
  const session = sessionId(["session", "memory-pipeline"]);
  const sourceValue = sourceId(["codex_rollout", "/synthetic/memory.jsonl"]);
  const source = {
    id: sourceValue,
    kind: "codex_rollout",
    normalizedPath: "/synthetic/memory.jsonl",
    formatVersion: "synthetic-v1",
    fileIdentity: {
      device: "synthetic-device",
      inode: "synthetic-inode",
      size: 20_000,
      modifiedAtMs: 1_800_000_000_000,
    },
  };
  await storage.scopes.upsertScopes([
    { kind: "project", id: project, displayName: "Memory Pipeline" },
    { kind: "session", id: session, projectId: project },
  ]);

  const records = [
    ["user_message", "Choose local persistence. What constraints remain?"],
    [
      "assistant_message",
      "We decided to use SQLite for persistence because it works offline. " +
        "We rejected PostgreSQL because it needs a server. TODO: test migrations.",
    ],
    ["user_message", "The project now needs team access. What should change?"],
    [
      "assistant_message",
      "We decided to use PostgreSQL for persistence instead of SQLite because team access is required. " +
        "Next step: benchmark the migration.",
    ],
  ];
  const events = records.map(([kind, text], ordinal) => ({
    id: eventId([session, String(ordinal), kind]),
    sessionId: session,
    ordinal,
    kind,
    observedAt: new Date(Date.UTC(2026, 2, ordinal + 1)).toISOString(),
    text,
    contentHash: `content-${ordinal}`,
    EvidenceSource: {
      sourceId: sourceValue,
      sourceOrdinal: ordinal,
      byteStart: ordinal * 200,
      byteEnd: ordinal * 200 + 199,
      formatVersion: "synthetic-v1",
    },
  }));
  await storage.evidence.commitBatch(
    { source, events },
    {
      sourceId: sourceValue,
      fileFingerprint: "memory-one",
      committedByteOffset: 1_000,
      lastCompleteLineHash: "line-four",
    },
  );
  const chunkPolicy = {
    targetTokens: 30,
    maxTokens: 80,
    maxToolOutputCharacters: 1_024,
  };
  await syncSessionChunks(storage, session, chunkPolicy);

  const first = await syncSessionMemories(storage, session, {
    now: () => new Date("2026-03-10T00:00:00.000Z"),
  });
  assert.ok(first.memoryCount >= 5);
  assert.equal(first.upsertedMemories, first.memoryCount);
  const decisions = first.memories.filter((memory) => memory.type === "decision");
  assert.equal(decisions.length, 2);
  const older = decisions.find((memory) => memory.decision.includes("SQLite for persistence"));
  const newer = decisions.find((memory) => memory.decision.includes("PostgreSQL for persistence"));
  assert.equal(older?.status, "superseded");
  assert.equal(older?.supersededBy, newer?.id);
  assert.deepEqual(newer?.supersedes, [older?.id]);

  const persisted = await storage.memories.findByScope(
    { projectId: project, sessionId: session },
  );
  assert.equal(persisted.length, first.memoryCount);
  for (const memory of persisted) {
    const chunkIds = collectMemoryEvidenceIds(memory).filter((id) => id.includes(":chunk:"));
    assert.equal((await storage.evidence.getChunks(chunkIds)).length, chunkIds.length);
  }
  const hits = await storage.lexicalSearch.search(
    "PostgreSQL persistence",
    { scope: { projectId: project, sessionId: session } },
    20,
  );
  assert.equal(hits.some((hit) => hit.entity.kind === "memory"), true);

  const replay = await syncSessionMemories(storage, session, {
    now: () => new Date("2026-03-11T00:00:00.000Z"),
  });
  assert.equal(replay.upsertedMemories, 0);
  assert.equal(replay.deletedMemories, 0);
  assert.equal(replay.unchangedMemories, replay.memoryCount);

  const appended = {
    ...events[0],
    id: eventId([session, "4", "assistant_message"]),
    ordinal: 4,
    kind: "assistant_message",
    observedAt: "2026-03-05T00:00:00.000Z",
    text: "Follow-up: document the PostgreSQL migration risks.",
    contentHash: "content-4",
    EvidenceSource: {
      sourceId: sourceValue,
      sourceOrdinal: 4,
      byteStart: 1_000,
      byteEnd: 1_199,
      formatVersion: "synthetic-v1",
    },
  };
  await storage.evidence.commitBatch(
    { source, events: [appended] },
    {
      sourceId: sourceValue,
      fileFingerprint: "memory-two",
      committedByteOffset: 1_200,
      lastCompleteLineHash: "line-five",
    },
  );
  await syncSessionChunks(storage, session, chunkPolicy);
  const incremental = await syncSessionMemories(storage, session, {
    now: () => new Date("2026-03-12T00:00:00.000Z"),
  });
  assert.ok(incremental.unchangedMemories >= 1);
  assert.ok(incremental.upsertedMemories >= 2);

  const failedOptional = await syncSessionMemories(storage, session, {
    now: () => new Date("2026-03-13T00:00:00.000Z"),
    extractor: {
      manifest: () => ({
        id: "synthetic-optional",
        version: "synthetic-model-v1",
        kind: "local",
        schemaVersion: 1,
      }),
      extract: async () => {
        throw new Error("seeded-private-provider-error");
      },
    },
  });
  assert.deepEqual(failedOptional.diagnostics, [{
    code: "OPTIONAL_EXTRACTOR_FAILED",
    extractorId: "synthetic-optional",
  }]);
  assert.equal(failedOptional.upsertedMemories, 0);
  assert.ok(
    (await storage.lexicalSearch.search(
      "PostgreSQL persistence",
      { scope: { projectId: project, sessionId: session } },
      20,
    )).length > 0,
  );
});
