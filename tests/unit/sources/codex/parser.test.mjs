import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseHistoryLine } from "../../../../dist/sources/codex/history-parser.js";
import { parseRolloutLine } from "../../../../dist/sources/codex/rollout-parser.js";
import {
  loadSessionIndex,
  parseSessionIndexLine,
} from "../../../../dist/sources/codex/session-index.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "codex");

test("rollout parser recognizes approved evidence and excludes internal variants", async () => {
  const lines = (await readFile(join(FIXTURES, "rollout-v1.jsonl"), "utf8"))
    .trimEnd()
    .split("\n");
  const records = lines.map((line) => parseRolloutLine(line, "codex-jsonl-v1"));
  assert.equal(records.every((result) => result.ok), true);

  assert.equal(records[0].record.kind, "session_meta");
  assert.equal(records[0].record.git.branch, "feature/synthetic");
  assert.equal(records[0].record.git.commitHash, "abcdef1234567890");
  assert.equal(
    records[0].record.git.repositoryUrl,
    "https://example.invalid/team/project.git",
  );
  assert.equal(records[0].record.git.repositoryUrl.includes("synthetic-token"), false);
  assert.deepEqual(
    records.slice(1).map((result) => result.record.kind),
    [
      "message",
      "message",
      "message",
      "ignored",
      "tool_call",
      "tool_result",
      "ignored",
      "ignored",
    ],
  );
  assert.equal(records[4].record.reason, "mirror_record");
  assert.equal(records[7].record.reason, "internal_record");
  assert.equal(records[8].record.reason, "forbidden_role");
});

test("rollout parser reports safe error codes without returning raw content", () => {
  const seeded = "seeded-private-input";
  const result = parseRolloutLine(`{${seeded}`, "codex-jsonl-v1");
  assert.deepEqual(result, { ok: false, code: "INVALID_JSON" });
  assert.equal(JSON.stringify(result).includes(seeded), false);
});

test("session metadata removes SCP-style remote usernames", () => {
  const result = parseRolloutLine(
    JSON.stringify({
      type: "session_meta",
      payload: {
        session_id: "synthetic-session",
        git: {
          repository_url: "synthetic-token@example.invalid:team/repository.git",
        },
      },
    }),
    "codex-jsonl-v1",
  );
  assert.equal(result.ok, true);
  assert.equal(
    result.record.git.repositoryUrl,
    "example.invalid:team/repository.git",
  );
  assert.equal(result.record.git.repositoryUrl.includes("synthetic-token"), false);
});

test("rollout parser handles current custom-tool and mixed-content variants", async () => {
  const lines = (await readFile(join(FIXTURES, "rollout-v2.jsonl"), "utf8"))
    .trimEnd()
    .split("\n");
  const records = lines.map((line) => parseRolloutLine(line, "codex-jsonl-v1"));
  assert.equal(records.every((result) => result.ok), true);
  assert.deepEqual(
    records.map((result) => result.record.kind),
    [
      "session_meta",
      "message",
      "tool_call",
      "tool_result",
      "ignored",
      "ignored",
      "ignored",
    ],
  );
  assert.equal(records[1].record.text, "Describe the synthetic image");
  assert.equal(records[1].record.unsupportedContentItems, 1);
  assert.equal(records[2].record.toolCallId, "custom-call-1");
  assert.equal(records[4].record.reason, "mirror_record");
  assert.equal(records[5].record.reason, "internal_record");
  assert.equal(records[6].record.reason, "internal_record");
});

test("history parser distinguishes transcript evidence from metadata", async () => {
  const lines = (await readFile(join(FIXTURES, "history-v1.jsonl"), "utf8"))
    .trimEnd()
    .split("\n");
  const evidence = parseHistoryLine(lines[0]);
  const metadata = parseHistoryLine(lines[1]);

  assert.equal(evidence.ok, true);
  assert.equal(evidence.record.kind, "evidence");
  assert.equal(evidence.record.role, "user");
  assert.equal(metadata.ok, true);
  assert.equal(metadata.record.kind, "metadata");
});

test("session index loads bounded title metadata and never transcript evidence", async () => {
  const path = join(FIXTURES, "session-index-v1.jsonl");
  const loaded = await loadSessionIndex(path);
  assert.equal(loaded.entries.length, 2);
  assert.deepEqual(loaded.diagnostics, []);
  assert.equal(loaded.truncated, false);
  assert.equal(loaded.entries[0].title, "Synthetic session");
  assert.equal("text" in loaded.entries[0], false);

  assert.deepEqual(parseSessionIndexLine("not-json"), {
    ok: false,
    code: "INVALID_JSON",
  });
});
