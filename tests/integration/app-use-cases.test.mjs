import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exportScope,
  forgetScope,
  getContextOverview,
  getEvidence,
  indexSources,
  listContextScopes,
  reindex,
  searchMemory,
} from "../../dist/app/index.js";
import {
  eventId,
  projectId,
  sessionId,
  sourceId,
} from "../../dist/contracts/ids.js";
import { syncSessionChunks, heuristicTokenizer } from "../../dist/processing/chunks/index.js";
import { syncSessionMemories } from "../../dist/processing/memory/index.js";
import {
  DefaultOutputPolicy,
  LocalAuthorizationPolicy,
} from "../../dist/security/output-policy.js";
import { openSqliteStorage } from "../../dist/storage/sqlite/index.js";

const limits = { maxItems: 20, maxBytes: 128 * 1024, maxTokens: 10_000 };
const chunkPolicy = {
  targetTokens: 40,
  maxTokens: 100,
  maxToolOutputCharacters: 2_048,
};

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-app-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("M13 use cases expose the same bounded, authorized SQLite pipeline without local paths", async (t) => {
  const directory = await temporaryDirectory(t);
  const storage = await openSqliteStorage({
    databaseFile: join(directory, "app.sqlite"),
    backupBeforeMigration: false,
  });
  t.after(() => storage.close().catch(() => undefined));

  const project = projectId(["app-project"]);
  const session = sessionId(["app-session"]);
  const twinOne = projectId(["app-twin-one"]);
  const twinTwo = projectId(["app-twin-two"]);
  const sourceValue = sourceId(["app-source"]);
  await storage.scopes.upsertScopes([
    { kind: "project", id: project, displayName: "App Project" },
    { kind: "project", id: twinOne, displayName: "Twin App" },
    { kind: "project", id: twinTwo, displayName: "Twin App" },
    { kind: "session", id: session, projectId: project, title: "App Session" },
  ]);

  const source = {
    id: sourceValue,
    kind: "codex_rollout",
    normalizedPath: "/home/private/.codex/sessions/app.jsonl",
    formatVersion: "synthetic-v1",
    fileIdentity: {
      device: "fixture",
      inode: "app",
      size: 1_000,
      modifiedAtMs: Date.parse("2026-07-04T00:00:00.000Z"),
    },
  };
  const secret = `sk-${"q".repeat(32)}`;
  const rows = [
    ["user_message", "Why does App.run fail?"],
    ["assistant_message", `TypeError: App.run failed at src/app.ts:7 with ${secret}.`],
    ["assistant_message", "We decided to validate App.run input because empty input caused the failure. TODO: add regression coverage."],
  ];
  const events = rows.map(([kind, text], ordinal) => ({
    id: eventId([session, String(ordinal)]),
    sessionId: session,
    ordinal,
    kind,
    observedAt: new Date(Date.UTC(2026, 6, ordinal + 1)).toISOString(),
    text,
    contentHash: `app-content-${ordinal}`,
    EvidenceSource: {
      sourceId: sourceValue,
      sourceOrdinal: ordinal,
      byteStart: ordinal * 100,
      byteEnd: ordinal * 100 + 99,
      formatVersion: "synthetic-v1",
    },
  }));
  await storage.evidence.commitBatch(
    { source, events },
    {
      sourceId: sourceValue,
      fileFingerprint: "app-fixture",
      committedByteOffset: 1_000,
      lastCompleteLineHash: "line-three",
    },
  );
  const chunks = await syncSessionChunks(storage, session, chunkPolicy);
  await syncSessionMemories(storage, session, {
    now: () => new Date("2026-07-10T00:00:00.000Z"),
  });

  const outputPolicy = new DefaultOutputPolicy({ limits, tokenizer: heuristicTokenizer });
  const dependencies = {
    storage,
    authorization: new LocalAuthorizationPolicy(storage.scopes),
    outputPolicy,
    budgetLimits: limits,
    tokenizer: heuristicTokenizer,
  };

  const scopes = await listContextScopes({ query: "App Project", limit: 10 }, dependencies);
  assert.equal(scopes.status, "ok");
  assert.equal(scopes.scopes[0].scope.id, project);
  assert.equal(JSON.stringify(scopes).includes("/home/private"), false);

  const ambiguous = await searchMemory({
    query: "anything",
    scopeQuery: "Twin App",
  }, {
    ...dependencies,
    cursorSecret: "app-integration-cursor-secret",
  });
  assert.equal(ambiguous.status, "ambiguous_scope");
  assert.equal(ambiguous.scopeCandidates.length, 2);

  const overview = await getContextOverview({ scope: { projectId: project } }, {
    ...dependencies,
    cursorSecret: "app-integration-cursor-secret",
  });
  assert.equal(overview.status, "ok");
  assert.ok(overview.synopses.length > 0);
  assert.ok(overview.decisions.length > 0);
  assert.ok(overview.openItems.length > 0);
  assert.equal(JSON.stringify(overview).includes(secret), false);

  const search = await searchMemory({
    query: "TypeError: App.run failed at src/app.ts:7",
    filters: { scope: { projectId: project } },
  }, {
    ...dependencies,
    cursorSecret: "app-integration-cursor-secret",
  });
  assert.equal(search.status, "ok");
  assert.equal(search.semanticStatus, "not_applicable");
  assert.ok(search.hits.length > 0);
  assert.equal(JSON.stringify(search).includes(secret), false);

  const evidence = await getEvidence({
    evidenceIds: [chunks.chunks[0].id],
    beforeEvents: 0,
    afterEvents: 0,
  }, dependencies);
  assert.equal(evidence.status, "ok");
  assert.equal(evidence.scope.projectId, project);
  assert.ok(evidence.events.length > 0);
  assert.equal(JSON.stringify(evidence).includes(secret), false);
  assert.equal(JSON.stringify(evidence).includes("/home/private"), false);

  const exported = await exportScope({ scope: { projectId: project } }, {
    ...dependencies,
    cursorSecret: "app-integration-cursor-secret",
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });
  assert.equal(exported.format, "context-bridge-pack-v1");
  assert.ok(exported.overview.decisions.length > 0);
  assert.equal(JSON.stringify(exported).includes(secret), false);

  const rebuilt = await reindex({
    scope: { projectId: project },
    chunkPolicy,
  }, {
    storage,
    memoryOptions: { now: () => new Date("2026-07-10T00:00:00.000Z") },
  });
  assert.equal(rebuilt.status, "ok");
  assert.equal(rebuilt.sessions.length, 1);
  assert.equal(rebuilt.sessions[0].status, "ok");

  const indexed = await indexSources({
    sourceConfig: { roots: ["/home/private/.codex"], includeHistory: true, includeSessionIndex: true },
  }, {
    ingestion: {
      runOnce: async () => ({
        startedAt: "2026-07-20T00:00:00.000Z",
        completedAt: "2026-07-20T00:00:01.000Z",
        reconciliation: [{ kind: "unchanged", source }],
        sources: [{
          sourceId: sourceValue,
          status: "committed",
          batches: 1,
          recordsRead: 3,
          insertedEvents: 0,
          duplicateEvents: 3,
          skippedEvents: 0,
          diagnostics: 0,
          hasMore: false,
        }],
        totals: {
          discoveredSources: 1,
          attemptedSources: 1,
          batches: 1,
          recordsRead: 3,
          insertedEvents: 0,
          duplicateEvents: 3,
          skippedEvents: 0,
          diagnostics: 0,
          laggingSources: 0,
          failedSources: 0,
        },
      }),
    },
  });
  assert.equal(indexed.status, "ok");
  assert.equal(JSON.stringify(indexed).includes("/home/private"), false);

  const forgotten = await forgetScope({ scope: { projectId: project } }, {
    scopes: storage.scopes,
    now: () => new Date("2026-07-21T00:00:00.000Z"),
  });
  assert.equal(forgotten.status, "pending");
  assert.equal(
    (await dependencies.authorization.authorizeProject(project, "search_memory")).allowed,
    false,
  );
  const excluded = await searchMemory({
    query: "App.run",
    filters: { scope: { projectId: project } },
  }, {
    ...dependencies,
    cursorSecret: "app-integration-cursor-secret",
  });
  assert.equal(excluded.status, "scope_excluded");
});
