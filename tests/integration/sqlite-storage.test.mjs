import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chunkId,
  eventId,
  projectId,
  sessionId,
  sourceId,
  vectorId,
} from "../../dist/contracts/ids.js";
import {
  openDatabase,
  openSqliteStorage,
} from "../../dist/storage/sqlite/index.js";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixture() {
  const project = projectId(["remote", "example.test/acme/widgets"]);
  const session = sessionId(["session", "one"]);
  const source = sourceId(["codex_rollout", "/synthetic/rollout.jsonl"]);
  const firstEvent = eventId([session, "0", "first"]);
  const secondEvent = eventId([session, "1", "second"]);
  return {
    project,
    session,
    source: {
      id: source,
      kind: "codex_rollout",
      normalizedPath: "/synthetic/rollout.jsonl",
      formatVersion: "rollout-v1",
      fileIdentity: {
        device: "synthetic-device",
        inode: "synthetic-inode",
        size: 500,
        modifiedAtMs: 1_700_000_000_000,
      },
    },
    event: {
      id: firstEvent,
      sessionId: session,
      ordinal: 0,
      kind: "assistant_message",
      observedAt: "2026-01-01T00:00:00.000Z",
      text: "TypeError: Widget.run failed at src/widget.ts:9",
      contentHash: "content-one",
      EvidenceSource: {
        sourceId: source,
        sourceOrdinal: 0,
        byteStart: 0,
        byteEnd: 100,
        formatVersion: "rollout-v1",
      },
    },
    secondEvent,
  };
}

test("SQLite upgrades v1 databases with deterministic chunk sequence storage", async (t) => {
  const root = await temporaryDirectory(t);
  const databaseFile = join(root, "upgrade.sqlite");
  const initial = openDatabase({ databaseFile }).database;
  initial.exec(
    await readFile(
      join(process.cwd(), "src", "storage", "sqlite", "migrations", "001_initial.sql"),
      "utf8",
    ),
  );
  initial
    .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
    .run(1, "initial", "2026-01-01T00:00:00.000Z");
  initial.close();

  const storage = await openSqliteStorage({
    databaseFile,
    backupBeforeMigration: false,
  });
  assert.equal(storage.startup.migration.previousVersion, 1);
  assert.equal(storage.startup.migration.currentVersion, 2);
  assert.deepEqual(storage.startup.migration.applied, [2]);
  await storage.close();

  const upgraded = openDatabase({ databaseFile }).database;
  const columns = upgraded.prepare("PRAGMA table_info(chunks)").all();
  assert.equal(columns.some((column) => column.name === "sequence"), true);
  upgraded.close();
});

test("SQLite storage migrates, commits evidence and cursor atomically, maintains FTS, and reopens", async (t) => {
  const root = await temporaryDirectory(t);
  const databaseFile = join(root, "context-bridge.sqlite");
  const data = fixture();
  let storage = await openSqliteStorage({ databaseFile });
  t.after(async () => storage.close().catch(() => undefined));

  assert.equal(storage.startup.migration.currentVersion, 2);
  assert.equal(storage.startup.capabilities.fts5, true);

  await storage.scopes.upsertScopes([
    {
      kind: "project",
      id: data.project,
      displayName: "Widgets",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    },
    {
      kind: "session",
      id: data.session,
      projectId: data.project,
      title: "Fix widget failure",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  const cursor = {
    sourceId: data.source.id,
    fileFingerprint: "fingerprint-one",
    committedByteOffset: 100,
    lastCompleteLineHash: "line-one",
  };
  const first = await storage.evidence.commitBatch(
    { source: data.source, events: [data.event] },
    cursor,
  );
  assert.deepEqual(
    { inserted: first.insertedEvents, duplicate: first.duplicateEvents },
    { inserted: 1, duplicate: 0 },
  );

  const replay = await storage.evidence.commitBatch(
    { source: data.source, events: [data.event] },
    cursor,
  );
  assert.deepEqual(
    { inserted: replay.insertedEvents, duplicate: replay.duplicateEvents },
    { inserted: 0, duplicate: 1 },
  );

  const chunk = {
    id: chunkId([data.session, "chunk", "one"]),
    sequence: 0,
    scope: { projectId: data.project, sessionId: data.session },
    eventIds: [data.event.id],
    displayText: data.event.text,
    embeddingText: data.event.text,
    tokenCount: 10,
    fingerprint: "chunk-fingerprint-one",
    observedFrom: data.event.observedAt,
    observedTo: data.event.observedAt,
  };
  await storage.derivedData.commit({
    upsertChunks: [chunk],
    deleteChunkIds: [],
    upsertMemories: [],
    deleteMemoryIds: [],
    embeddingJobs: [],
  });

  const exact = await storage.lexicalSearch.search(
    "Widget.run",
    { scope: { projectId: data.project } },
    10,
  );
  assert.equal(exact.length, 1);
  assert.equal(exact[0].entity.id, chunk.id);
  assert.equal(exact[0].channel, "exact");

  const updatedChunk = {
    ...chunk,
    displayText: "ReplacementSymbol completed successfully",
    embeddingText: "ReplacementSymbol completed successfully",
    fingerprint: "chunk-fingerprint-two",
  };
  await storage.derivedData.commit({
    upsertChunks: [updatedChunk],
    deleteChunkIds: [],
    upsertMemories: [],
    deleteMemoryIds: [],
    embeddingJobs: [],
  });
  assert.equal(
    (await storage.lexicalSearch.search(
      "Widget.run",
      { scope: { projectId: data.project } },
      10,
    )).length,
    0,
  );
  assert.equal(
    (await storage.lexicalSearch.search(
      "ReplacementSymbol",
      { scope: { projectId: data.project } },
      10,
    )).length,
    1,
  );

  const cursorBeforeFailure = await storage.sources.getCursor(data.source.id);
  const invalidEvent = {
    ...data.event,
    id: data.secondEvent,
    ordinal: 1,
    contentHash: "content-two",
  };
  const wrongSource = sourceId(["wrong-source"]);
  const invalidSecondEvent = {
    ...invalidEvent,
    id: eventId([data.session, "2", "invalid"]),
    ordinal: 2,
    EvidenceSource: { ...invalidEvent.EvidenceSource, sourceId: wrongSource },
  };
  await assert.rejects(
    storage.evidence.commitBatch(
      { source: data.source, events: [invalidEvent, invalidSecondEvent] },
      {
        ...cursor,
        committedByteOffset: 300,
        lastCompleteLineHash: "line-three",
      },
    ),
    /event source does not match/i,
  );
  assert.deepEqual(await storage.sources.getCursor(data.source.id), cursorBeforeFailure);
  assert.deepEqual(await storage.evidence.getEvents([invalidEvent.id]), []);

  await storage.scopes.upsertExclusion({
    scope: { projectId: data.project },
    reason: "user_excluded",
    blocksIngestion: true,
    status: "excluded",
    excludedAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(
    (await storage.lexicalSearch.search("ReplacementSymbol", {}, 10)).length,
    0,
  );
  assert.deepEqual(await storage.evidence.getChunks([chunk.id]), []);
  assert.equal(
    await storage.scopes.removeExclusion({ projectId: data.project }),
    true,
  );

  await storage.close();
  storage = await openSqliteStorage({ databaseFile });
  assert.deepEqual(await storage.evidence.getEvents([data.event.id]), [data.event]);
  assert.deepEqual(await storage.sources.getCursor(data.source.id), cursor);
  assert.equal(storage.startup.migration.applied.length, 0);

  await storage.derivedData.commit({
    upsertChunks: [],
    deleteChunkIds: [chunk.id],
    upsertMemories: [],
    deleteMemoryIds: [],
    embeddingJobs: [],
  });
  assert.equal(
    (await storage.lexicalSearch.search("ReplacementSymbol", {}, 10)).length,
    0,
  );
});

test("embedding ledger claims leases and rejects stale acknowledgements", async (t) => {
  const root = await temporaryDirectory(t);
  const storage = await openSqliteStorage({
    databaseFile: join(root, "embedding.sqlite"),
  });
  t.after(() => storage.close());
  const data = fixture();
  const entity = { kind: "chunk", id: chunkId([data.session, "embedding"]) };
  const space = {
    id: "space-local-v1",
    provider: "local_transformers",
    modelId: "synthetic-model",
    modelRevision: "revision-1",
    dimension: 3,
    distanceMetric: "cosine",
    normalization: "l2",
    tokenizerVersion: "tokenizer-1",
    preprocessingVersion: "preprocess-1",
    redactionVersion: "redaction-1",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await storage.embeddingJobs.upsertSpace(space);
  assert.deepEqual(await storage.embeddingJobs.getActiveSpace(), space);

  const firstJob = {
    id: "embedding-job-one",
    entity,
    spaceId: space.id,
    desiredFingerprint: "desired-one",
    operation: "upsert",
    state: "pending",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await storage.embeddingJobs.enqueue([firstJob]);
  const [claimed] = await storage.embeddingJobs.claim({
    limit: 1,
    workerId: "worker-one",
    now: new Date("2026-01-01T00:01:00.000Z"),
    leaseDurationMs: 60_000,
  });
  assert.equal(claimed.state, "processing");
  assert.equal(claimed.attempts, 1);
  assert.equal(
    await storage.embeddingJobs.acknowledge(
      firstJob.id,
      "wrong-fingerprint",
      vectorId([entity.id, space.id]),
    ),
    false,
  );

  const secondJob = {
    ...firstJob,
    id: "embedding-job-two",
    desiredFingerprint: "desired-two",
    createdAt: "2026-01-01T00:01:30.000Z",
    updatedAt: "2026-01-01T00:01:30.000Z",
  };
  await storage.embeddingJobs.enqueue([secondJob]);
  assert.equal(
    await storage.embeddingJobs.acknowledge(
      firstJob.id,
      firstJob.desiredFingerprint,
      vectorId([entity.id, space.id]),
    ),
    false,
  );

  const [claimedSecond] = await storage.embeddingJobs.claim({
    limit: 1,
    workerId: "worker-two",
    now: new Date("2026-01-01T00:02:00.000Z"),
    leaseDurationMs: 60_000,
  });
  assert.equal(claimedSecond.id, secondJob.id);
  const vector = vectorId([entity.id, space.id]);
  assert.equal(
    await storage.embeddingJobs.acknowledge(
      secondJob.id,
      secondJob.desiredFingerprint,
      vector,
    ),
    true,
  );
  const records = await storage.embeddingJobs.getRecords([entity], space.id);
  assert.equal(records.length, 1);
  assert.deepEqual(
    {
      entity: records[0].entity,
      spaceId: records[0].spaceId,
      fingerprint: records[0].fingerprint,
      vectorId: records[0].vectorId,
    },
    {
      entity,
      spaceId: space.id,
      fingerprint: secondJob.desiredFingerprint,
      vectorId: vector,
    },
  );
  assert.equal(Number.isFinite(Date.parse(records[0].indexedAt)), true);

  await storage.embeddingJobs.enqueue([{
    ...secondJob,
    id: "embedding-job-three",
    desiredFingerprint: "desired-three",
    state: "pending",
    createdAt: "2026-01-01T00:03:00.000Z",
    updatedAt: "2026-01-01T00:03:00.000Z",
  }]);
  assert.deepEqual(await storage.embeddingJobs.getRecords([entity], space.id), []);
});
