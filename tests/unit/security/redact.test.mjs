import assert from "node:assert/strict";
import test from "node:test";

import {
  RedactionLimitError,
  redactText,
} from "../../../dist/security/redact.js";

test("redactText removes seeded built-in and user-defined secrets", async () => {
  const openAiKey = `sk-${"a".repeat(32)}`;
  const githubKey = `ghp_${"b".repeat(36)}`;
  const text = [
    `OpenAI ${openAiKey}`,
    `GitHub ${githubKey}`,
    "password=hunter-hunter",
    "customer code INTERNAL-4821",
    "ticket SEC-9988",
  ].join("\n");

  const result = await redactText(text, [
    { id: "customer", kind: "literal", value: "INTERNAL-4821" },
    { id: "ticket", kind: "regex", pattern: "SEC-[0-9]{4}", flags: "u" },
  ]);

  for (const secret of [
    openAiKey,
    githubKey,
    "hunter-hunter",
    "INTERNAL-4821",
    "SEC-9988",
  ]) {
    assert.equal(result.text.includes(secret), false);
  }
  assert.equal(result.redactionCount, 5);
  assert.equal(result.spans.length, 5);
  for (const span of result.spans) {
    assert.equal(result.text.slice(span.start, span.end), "[REDACTED]");
  }
});

test("invalid user regex is rejected without exposing input", async () => {
  const result = await redactText("ordinary safe text", [
    { id: "broken", kind: "regex", pattern: "(" },
  ]);

  assert.equal(result.text, "ordinary safe text");
  assert.deepEqual(result.warnings, [
    { code: "RULE_REJECTED", ruleId: "broken" },
  ]);
});

test("redaction input and rule execution are bounded", async () => {
  await assert.rejects(
    redactText("too long", [], { maxInputCharacters: 3 }),
    RedactionLimitError,
  );

  await assert.rejects(
    redactText(
      "x x x x",
      [{ id: "many", kind: "literal", value: "x" }],
      { maxMatches: 2 },
    ),
    RedactionLimitError,
  );
});
