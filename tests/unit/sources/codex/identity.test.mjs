import assert from "node:assert/strict";
import test from "node:test";

import {
  codexEventId,
  codexSourceId,
  sourceFingerprint,
  sourceSessionId,
} from "../../../../dist/sources/codex/identity.js";

test("Codex source, session, event, and file identities are deterministic", () => {
  const path =
    "/tmp/.codex/sessions/2026/01/02/rollout-2026-01-02T03-04-05-11111111-1111-4111-8111-111111111111.jsonl";
  const id = codexSourceId("codex_rollout", path);
  const source = {
    id,
    kind: "codex_rollout",
    normalizedPath: path,
  };
  const fromFilename = sourceSessionId(source);
  const fromMetadata = sourceSessionId(
    source,
    "11111111-1111-4111-8111-111111111111",
  );

  assert.equal(fromFilename, fromMetadata);
  assert.equal(
    codexEventId(fromFilename, "user_message", "record-1"),
    codexEventId(fromFilename, "user_message", "record-1"),
  );
  assert.notEqual(
    codexEventId(fromFilename, "user_message", "record-1"),
    codexEventId(fromFilename, "assistant_message", "record-1"),
  );

  const beforeAppend = sourceFingerprint(path, {
    device: "1",
    inode: "2",
    size: 100,
    modifiedAtMs: 1,
  });
  const afterAppend = sourceFingerprint(path, {
    device: "1",
    inode: "2",
    size: 200,
    modifiedAtMs: 2,
  });
  const replacement = sourceFingerprint(path, {
    device: "1",
    inode: "3",
    size: 200,
    modifiedAtMs: 2,
  });
  assert.equal(beforeAppend, afterAppend);
  assert.notEqual(beforeAppend, replacement);
});

test("child-agent rollout filenames retain their owning session identity", () => {
  const parent = "11111111-1111-4111-8111-111111111111";
  const child = "22222222-2222-4222-8222-222222222222";
  const path = `/tmp/rollout-date-${parent}_${child}.jsonl`;
  const source = {
    id: codexSourceId("codex_rollout", path),
    kind: "codex_rollout",
    normalizedPath: path,
  };

  assert.equal(sourceSessionId(source), sourceSessionId(source, parent));
  assert.notEqual(sourceSessionId(source), sourceSessionId(source, child));
});
