import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexSourceId } from "../../../../dist/sources/codex/identity.js";
import { readCompleteLines } from "../../../../dist/sources/codex/rollout-reader.js";

test("reader advances only across complete lines and resumes after append", async (t) => {
  const root = await temporaryDirectory(t);
  const path = join(root, "rollout-test.jsonl");
  await writeFile(path, "first\npartial");

  const first = await readCompleteLines(path, undefined, 1_024, 10);
  assert.deepEqual(first.lines.map((line) => line.text), ["first"]);
  assert.equal(first.nextByteOffset, Buffer.byteLength("first\n"));
  assert.equal(first.pendingPartialLine, true);
  assert.equal(first.hasMore, false);

  await appendFile(path, " line\n");
  const cursor = {
    sourceId: codexSourceId("codex_rollout", path),
    fileFingerprint: first.fileFingerprint,
    committedByteOffset: first.nextByteOffset,
    lastCompleteLineHash: first.lastCompleteLineHash,
  };
  const second = await readCompleteLines(path, cursor, 1_024, 10);
  assert.deepEqual(second.lines.map((line) => line.text), ["partial line"]);
  assert.equal(second.pendingPartialLine, false);
});

test("reader reports more data when the record limit stops a full buffer", async (t) => {
  const root = await temporaryDirectory(t);
  const path = join(root, "rollout-record-limit.jsonl");
  await writeFile(path, "one\ntwo\n");

  const first = await readCompleteLines(path, undefined, 1_024, 1);

  assert.deepEqual(first.lines.map((line) => line.text), ["one"]);
  assert.equal(first.hasMore, true);
  assert.equal(first.pendingPartialLine, false);
});

test("reader resets safely after truncation, replacement, or cursor mismatch", async (t) => {
  const root = await temporaryDirectory(t);
  const path = join(root, "rollout-reset.jsonl");
  await writeFile(path, "one\ntwo\n");
  const initial = await readCompleteLines(path, undefined, 1_024, 10);
  const sourceId = codexSourceId("codex_rollout", path);
  const cursor = {
    sourceId,
    fileFingerprint: initial.fileFingerprint,
    committedByteOffset: initial.nextByteOffset,
    lastCompleteLineHash: initial.lastCompleteLineHash,
  };

  const mismatched = await readCompleteLines(
    path,
    { ...cursor, lastCompleteLineHash: "0".repeat(64) },
    1_024,
    10,
  );
  assert.equal(mismatched.diagnostics[0].code, "CURSOR_RESET_MISMATCH");
  assert.deepEqual(mismatched.lines.map((line) => line.text), ["one", "two"]);

  await writeFile(path, "new\n");
  const truncated = await readCompleteLines(path, cursor, 1_024, 10);
  assert.equal(truncated.diagnostics[0].code, "CURSOR_RESET_TRUNCATED");
  assert.deepEqual(truncated.lines.map((line) => line.text), ["new"]);

  const truncatedCursor = {
    sourceId,
    fileFingerprint: truncated.fileFingerprint,
    committedByteOffset: truncated.nextByteOffset,
    lastCompleteLineHash: truncated.lastCompleteLineHash,
  };
  await rename(path, `${path}.old`);
  await writeFile(path, "replacement\n");
  const replaced = await readCompleteLines(path, truncatedCursor, 1_024, 10);
  assert.equal(replaced.diagnostics[0].code, "CURSOR_RESET_ROTATED");
  assert.deepEqual(replaced.lines.map((line) => line.text), ["replacement"]);
});

test("reader skips a newline-terminated record larger than the batch budget", async (t) => {
  const root = await temporaryDirectory(t);
  const path = join(root, "rollout-large.jsonl");
  await writeFile(path, "123456789\nnext\n");

  const first = await readCompleteLines(path, undefined, 4, 10);
  assert.deepEqual(first.lines, []);
  assert.equal(first.diagnostics[0].code, "OVERSIZED_RECORD");
  assert.equal(first.nextByteOffset, Buffer.byteLength("123456789\n"));
  assert.equal(first.hasMore, true);
});

test("reader resumes after a skipped record larger than the cursor validation window", async (t) => {
  const root = await temporaryDirectory(t);
  const path = join(root, "rollout-very-large.jsonl");
  const oversized = "x".repeat(4 * 1_024 * 1_024 + 1);
  await writeFile(path, `${oversized}\nnext\n`);

  const first = await readCompleteLines(path, undefined, 1_024, 10);
  assert.deepEqual(first.lines, []);
  assert.equal(first.diagnostics[0].code, "OVERSIZED_RECORD");
  assert.equal(first.nextByteOffset, Buffer.byteLength(`${oversized}\n`));
  assert.equal(first.hasMore, true);

  const cursor = {
    sourceId: codexSourceId("codex_rollout", path),
    fileFingerprint: first.fileFingerprint,
    committedByteOffset: first.nextByteOffset,
    lastCompleteLineHash: first.lastCompleteLineHash,
  };
  const second = await readCompleteLines(path, cursor, 1_024, 10);

  assert.deepEqual(second.diagnostics, []);
  assert.deepEqual(second.lines.map((line) => line.text), ["next"]);
  assert.equal(second.nextByteOffset, Buffer.byteLength(`${oversized}\nnext\n`));
  assert.equal(second.hasMore, false);
});

test("reader leaves an oversized partial record behind the cursor", async (t) => {
  const root = await temporaryDirectory(t);
  const path = join(root, "rollout-large-partial.jsonl");
  await writeFile(path, "123456789");

  const read = await readCompleteLines(path, undefined, 4, 10);
  assert.deepEqual(read.lines, []);
  assert.deepEqual(read.diagnostics, []);
  assert.equal(read.nextByteOffset, 0);
  assert.equal(read.pendingPartialLine, true);
  assert.equal(read.hasMore, false);
});

async function temporaryDirectory(testContext) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-reader-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
