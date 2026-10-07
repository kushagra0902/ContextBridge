import assert from "node:assert/strict";
import test from "node:test";

import { projectId } from "../../../dist/contracts/ids.js";
import { forgetScope, indexSources } from "../../../dist/app/index.js";

test("forgetScope tombstones before purge and only marks complete after every store confirms cleanup", async () => {
  const project = projectId(["forget-app-unit"]);
  const ref = { kind: "project", id: project, displayName: "Forget Fixture" };
  let exclusion;
  const writes = [];
  let tombstoneObservedByPurge = false;
  const scopes = {
    get: async () => ref,
    getExclusion: async () => exclusion,
    upsertExclusion: async (value) => {
      exclusion = value;
      writes.push(value);
    },
  };
  const result = await forgetScope({ scope: { projectId: project } }, {
    scopes,
    now: () => new Date(writes.length === 0
      ? "2026-08-01T00:00:00.000Z"
      : "2026-08-01T00:00:01.000Z"),
    purge: {
      purgeScope: async () => {
        tombstoneObservedByPurge = exclusion?.status === "deletion_pending";
        return { sqlite: true, objects: true, vectors: true, caches: true, backups: true };
      },
    },
  });
  assert.equal(tombstoneObservedByPurge, true);
  assert.equal(result.status, "complete");
  assert.deepEqual(writes.map((write) => write.status), ["deletion_pending", "deleted"]);
  assert.equal(writes[1].physicalDeletionCompletedAt, "2026-08-01T00:00:01.000Z");
});

test("indexSources returns content-free summaries instead of source paths", async () => {
  const source = {
    id: "ku::source:" + "a".repeat(64),
    kind: "codex_rollout",
    normalizedPath: "/home/person/.codex/sessions/private.jsonl",
    formatVersion: "fixture",
    fileIdentity: { size: 0, modifiedAtMs: 0 },
  };
  const result = await indexSources({
    sourceConfig: { roots: ["/home/person/.codex"], includeHistory: true, includeSessionIndex: true },
  }, {
    ingestion: {
      runOnce: async () => ({
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
        reconciliation: [{ kind: "new", source }],
        sources: [],
        totals: {
          discoveredSources: 1,
          attemptedSources: 0,
          batches: 0,
          recordsRead: 0,
          insertedEvents: 0,
          duplicateEvents: 0,
          skippedEvents: 0,
          diagnostics: 0,
          laggingSources: 0,
          failedSources: 0,
        },
      }),
    },
  });
  assert.equal(JSON.stringify(result).includes("/home/person"), false);
  assert.equal(result.reconciliation[0].sourceId, source.id);
});
