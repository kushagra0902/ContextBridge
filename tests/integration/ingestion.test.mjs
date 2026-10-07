import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sessionId } from "../../dist/contracts/ids.js";
import { IngestionScheduler } from "../../dist/ingestion/index.js";
import { CodexSourceAdapter } from "../../dist/sources/codex/adapter.js";
import { openSqliteStorage } from "../../dist/storage/sqlite/index.js";

const SESSION_KEY = "11111111-1111-4111-8111-111111111111";

test("incremental ingestion converges across partial lines, restart, rotation, and truncation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-bridge-ingestion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "01", "02");
  const rollout = join(sessions, `rollout-test-${SESSION_KEY}.jsonl`);
  await mkdir(sessions, { recursive: true });
  await writeFile(
    rollout,
    `${line(sessionMeta())}\n${line(message("first", "msg-first", 1))}\n`,
  );

  const storage = await openSqliteStorage({
    databaseFile: join(root, "ingestion.sqlite"),
  });
  t.after(() => storage.close().catch(() => undefined));
  const config = {
    roots: [codexHome],
    includeHistory: false,
    includeSessionIndex: false,
  };
  let scheduler = createScheduler(storage);
  const canonicalSession = sessionId(["codex", SESSION_KEY]);

  const initial = await scheduler.runOnce(config);
  assert.equal(initial.totals.insertedEvents, 1, JSON.stringify(initial));
  assert.equal(initial.totals.failedSources, 0);
  const mappedSession = await storage.scopes.getSession(canonicalSession);
  assert.equal(mappedSession?.kind, "session");
  assert.equal(mappedSession?.branch, undefined);
  assert.equal(
    (await storage.scopes.get({ projectId: mappedSession.projectId }))?.kind,
    "project",
  );

  const partial = line(message("second", "msg-second", 2));
  await appendFile(rollout, partial);
  const pending = await scheduler.runOnce(config);
  assert.equal(pending.totals.insertedEvents, 0);

  await appendFile(rollout, "\n");
  const completed = await scheduler.runOnce(config);
  assert.equal(completed.totals.insertedEvents, 1);

  scheduler = createScheduler(storage);
  const restarted = await scheduler.runOnce(config);
  assert.equal(restarted.totals.insertedEvents, 0);
  assert.equal(restarted.totals.failedSources, 0);

  await rename(rollout, `${rollout}.old`);
  await writeFile(
    rollout,
    `${line(sessionMeta())}\n${line(message("third", "msg-third", 3))}\n`,
  );
  const rotated = await scheduler.runOnce(config);
  assert.equal(rotated.totals.insertedEvents, 1);
  assert.equal(rotated.totals.failedSources, 0);
  assert.equal(
    rotated.reconciliation.some((entry) => entry.kind === "rotated"),
    true,
  );

  await writeFile(
    rollout,
    `${line(sessionMeta())}\n${line(message("fourth", "msg-fourth", 4))}\n`,
  );
  const truncated = await scheduler.runOnce(config);
  assert.equal(truncated.totals.insertedEvents, 1);
  assert.equal(truncated.totals.failedSources, 0);

  const events = await storage.evidence.listSessionEvents(
    canonicalSession,
    undefined,
    100,
  );
  assert.deepEqual(
    events.map((event) => event.text),
    ["first", "second", "third", "fourth"],
  );
});

test("incremental ingestion honors mapped session exclusions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-bridge-exclusion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "01", "02");
  const rollout = join(sessions, `rollout-test-${SESSION_KEY}.jsonl`);
  await mkdir(sessions, { recursive: true });
  await writeFile(
    rollout,
    `${line(sessionMeta())}\n${line(message("visible", "msg-visible", 1))}\n`,
  );
  const storage = await openSqliteStorage({
    databaseFile: join(root, "exclusion.sqlite"),
  });
  t.after(() => storage.close().catch(() => undefined));
  const scheduler = createScheduler(storage);
  const config = {
    roots: [codexHome],
    includeHistory: false,
    includeSessionIndex: false,
  };
  const canonicalSession = sessionId(["codex", SESSION_KEY]);

  assert.equal((await scheduler.runOnce(config)).totals.insertedEvents, 1);
  const mapped = await storage.scopes.getSession(canonicalSession);
  assert.ok(mapped);
  const address = { projectId: mapped.projectId, sessionId: mapped.id };
  await storage.scopes.upsertExclusion({
    scope: address,
    reason: "user_excluded",
    blocksIngestion: true,
    status: "excluded",
    excludedAt: "2026-01-02T03:05:00.000Z",
    updatedAt: "2026-01-02T03:05:00.000Z",
  });
  await appendFile(
    rollout,
    `${line(message("blocked", "msg-blocked", 2))}\n`,
  );

  const excluded = await scheduler.runOnce(config);
  assert.equal(excluded.totals.insertedEvents, 0);
  assert.equal(excluded.totals.skippedEvents, 1);
  assert.deepEqual(
    await storage.evidence.listSessionEvents(canonicalSession, undefined, 100),
    [],
  );

  assert.equal(await storage.scopes.removeExclusion(address), true);
  await appendFile(
    rollout,
    `${line(message("visible again", "msg-visible-again", 3))}\n`,
  );
  assert.equal((await scheduler.runOnce(config)).totals.insertedEvents, 1);
  assert.deepEqual(
    (await storage.evidence.listSessionEvents(canonicalSession, undefined, 100))
      .map((event) => event.text),
    ["visible", "visible again"],
  );
});

test("session index titles enrich mapped sessions for ChatGPT mentions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-bridge-session-title-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions", "2026", "01", "02");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-test-${SESSION_KEY}.jsonl`),
    `${line(sessionMeta())}\n${line(message("visible", "msg-title", 1))}\n`,
  );
  await writeFile(join(codexHome, "session_index.jsonl"), `${line({
    id: SESSION_KEY,
    thread_name: "Investigate SQLite cursor behavior",
    updated_at: "2026-01-02T04:00:00.000Z",
  })}\n`);
  const storage = await openSqliteStorage({ databaseFile: join(root, "title.sqlite") });
  t.after(() => storage.close().catch(() => undefined));
  const scheduler = createScheduler(storage);
  await scheduler.runOnce({ roots: [codexHome], includeHistory: false, includeSessionIndex: true });

  const session = await storage.scopes.getSession(sessionId(["codex", SESSION_KEY]));
  assert.equal(session?.title, "Investigate SQLite cursor behavior");
});

function createScheduler(storage) {
  return new IngestionScheduler({
    adapter: new CodexSourceAdapter(),
    storage,
    readLimit: { maxBytes: 4_096, maxRecords: 1 },
    maxBatchesPerSource: 100,
    baseBackoffMs: 1,
    maxBackoffMs: 10,
  });
}

function sessionMeta() {
  return {
    timestamp: "2026-01-02T03:04:05.000Z",
    type: "session_meta",
    ordinal: 0,
    payload: {
      session_id: SESSION_KEY,
      cwd: "/synthetic/project",
      git: { repository_url: "https://example.invalid/team/project.git" },
    },
  };
}

function message(text, id, ordinal) {
  return {
    timestamp: `2026-01-02T03:04:${String(5 + ordinal).padStart(2, "0")}.000Z`,
    type: "response_item",
    ordinal,
    payload: {
      type: "message",
      id,
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

function line(value) {
  return JSON.stringify(value);
}
