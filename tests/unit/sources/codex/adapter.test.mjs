import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CodexSourceAdapter } from "../../../../dist/sources/codex/adapter.js";
import {
  CODEX_FORMAT_VERSION,
  codexSourceId,
  fileIdentityFromStats,
} from "../../../../dist/sources/codex/identity.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "codex");

test("adapter parses, redacts, normalizes, and collapses mirrored messages", async () => {
  const path = join(FIXTURES, "rollout-v1.jsonl");
  const source = await sourceRef(path, "codex_rollout");
  const adapter = new CodexSourceAdapter();
  const batch = await adapter.readBatch(source, undefined, {
    maxBytes: 1_048_576,
    maxRecords: 100,
  });

  assert.deepEqual(batch.diagnostics, []);
  assert.deepEqual(
    batch.records.map((record) => record.recordType),
    [
      "session_meta",
      "message",
      "message",
      "message",
      "tool_call",
      "tool_result",
    ],
  );

  const events = [];
  for (const record of batch.records) {
    events.push(...(await adapter.normalize(record)));
  }
  assert.deepEqual(
    events.map((event) => event.kind),
    ["user_message", "assistant_message", "tool_call", "tool_result"],
  );
  assert.equal(events.some((event) => event.text.includes("sk-")), false);
  assert.equal(events[0].redactions.length, 1);
  assert.equal(events.every((event) => event.EvidenceSource.sourceId === source.id), true);
  assert.equal(events.every((event) => event.EvidenceSource.byteEnd > event.EvidenceSource.byteStart), true);

  const atEnd = await adapter.readBatch(batch.source, batch.proposedCursor, {
    maxBytes: 1_048_576,
    maxRecords: 100,
  });
  assert.deepEqual(atEnd.records, []);
  assert.equal(atEnd.hasMore, false);
});

test("adapter advances past malformed rows with content-free diagnostics", async () => {
  const path = join(FIXTURES, "malformed.jsonl");
  const source = await sourceRef(path, "codex_rollout");
  const adapter = new CodexSourceAdapter();
  const batch = await adapter.readBatch(source, undefined, {
    maxBytes: 1_048_576,
    maxRecords: 100,
  });

  assert.equal(batch.records.length, 1);
  assert.deepEqual(batch.diagnostics.map((entry) => entry.code), ["MALFORMED_JSON"]);
  assert.equal(JSON.stringify(batch.diagnostics).includes("payload"), false);
  assert.equal(batch.proposedCursor.committedByteOffset, source.fileIdentity.size);
});

test("session index records never normalize into transcript evidence", async () => {
  const path = join(FIXTURES, "session-index-v1.jsonl");
  const source = await sourceRef(path, "codex_session_index");
  const adapter = new CodexSourceAdapter();
  const batch = await adapter.readBatch(source, undefined, {
    maxBytes: 1_048_576,
    maxRecords: 100,
  });

  assert.equal(batch.records.length, 2);
  for (const record of batch.records) {
    assert.deepEqual(await adapter.normalize(record), []);
  }
});

async function sourceRef(path, kind) {
  const details = await stat(path);
  return {
    id: codexSourceId(kind, path),
    kind,
    normalizedPath: path,
    formatVersion: CODEX_FORMAT_VERSION,
    fileIdentity: fileIdentityFromStats(details),
  };
}
