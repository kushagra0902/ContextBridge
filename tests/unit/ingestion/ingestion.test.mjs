import assert from "node:assert/strict";
import test from "node:test";

import { eventId, sessionId, sourceId } from "../../../dist/contracts/ids.js";
import {
  decideCursorTransition,
  deduplicateEvents,
  reconcileSources,
  scanOnce,
} from "../../../dist/ingestion/index.js";

test("cursor transitions require an explicit reader reset before moving backwards", () => {
  const id = sourceId(["ingestion", "cursor"]);
  const previous = {
    sourceId: id,
    fileFingerprint: "fingerprint",
    committedByteOffset: 100,
  };

  assert.deepEqual(
    decideCursorTransition(
      previous,
      { ...previous, committedByteOffset: 50 },
      [],
    ),
    { allowed: false, reason: "unexplained_backward_move" },
  );
  assert.deepEqual(
    decideCursorTransition(
      previous,
      { ...previous, committedByteOffset: 50 },
      [{ code: "CURSOR_RESET_TRUNCATED", byteStart: 0, byteEnd: 100 }],
    ),
    { allowed: true, mode: "replay" },
  );
});

test("event dedupe collapses identical stable IDs and rejects collisions", () => {
  const source = sourceId(["ingestion", "dedupe"]);
  const session = sessionId(["ingestion", "dedupe"]);
  const event = {
    id: eventId([session, "one"]),
    sessionId: session,
    ordinal: 1,
    kind: "user_message",
    text: "same",
    contentHash: "hash",
    EvidenceSource: {
      sourceId: source,
      sourceOrdinal: 1,
      byteStart: 0,
      byteEnd: 10,
      formatVersion: "test-v1",
    },
  };

  assert.deepEqual(deduplicateEvents([event, event]), {
    events: [event],
    duplicateEvents: 1,
  });
  assert.throws(
    () => deduplicateEvents([event, { ...event, text: "different" }]),
    /collision/i,
  );
});

test("source reconciliation preserves missing history and identifies file changes", () => {
  const unchanged = source("unchanged", "/codex/unchanged.jsonl", 1, 10, 10);
  const appendedBefore = source("appended", "/codex/appended.jsonl", 2, 10, 10);
  const missing = source("missing", "/codex/missing.jsonl", 3, 10, 10);
  const movedBefore = source("moved-before", "/codex/old.jsonl", 4, 10, 10);
  const appendedAfter = {
    ...appendedBefore,
    fileIdentity: { ...appendedBefore.fileIdentity, size: 20, modifiedAtMs: 20 },
  };
  const movedAfter = {
    ...source("moved-after", "/codex/new.jsonl", 4, 10, 10),
    fileIdentity: movedBefore.fileIdentity,
  };

  assert.deepEqual(
    reconcileSources(
      [unchanged, appendedBefore, missing, movedBefore],
      [unchanged, appendedAfter, movedAfter],
    ).map((entry) => entry.kind),
    ["unchanged", "appended", "moved", "missing"],
  );
});

test("scan rejects an adapter that reports more data without cursor progress", async () => {
  const input = source("stuck", "/codex/stuck.jsonl", 9, 100, 10);
  const cursor = {
    sourceId: input.id,
    fileFingerprint: "fingerprint",
    committedByteOffset: 10,
  };
  const adapter = {
    async discover() {
      return [input];
    },
    async readBatch() {
      return {
        source: input,
        records: [],
        diagnostics: [],
        proposedCursor: cursor,
        hasMore: true,
      };
    },
    async normalize() {
      return [];
    },
  };

  await assert.rejects(
    scanOnce(adapter, input, cursor, { maxBytes: 100, maxRecords: 10 }),
    /reader_made_no_progress/,
  );
});

function source(key, path, inode, size, modifiedAtMs) {
  return {
    id: sourceId(["ingestion", key]),
    kind: "codex_rollout",
    normalizedPath: path,
    formatVersion: "test-v1",
    fileIdentity: {
      device: "device",
      inode: String(inode),
      size,
      modifiedAtMs,
    },
  };
}
