import assert from "node:assert/strict";
import test from "node:test";

import { projectId } from "../../../dist/contracts/ids.js";
import {
  isExcluded,
  parseIgnoreRules,
} from "../../../dist/security/ignore-rules.js";

const PROJECT_ID = projectId(["ignore-test"]);

test("ignore rules use last-match semantics and support project-relative globs", () => {
  const parsed = parseIgnoreRules(`
# generated material
*.log
build/
!build/keep.log
private/**
`);

  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(decision(parsed, "logs/run.log").excluded, true);
  assert.equal(decision(parsed, "build/output.js").excluded, true);
  assert.deepEqual(decision(parsed, "build/keep.log"), {
    excluded: false,
    reason: "ignore_rule",
    matchedLine: 5,
  });
  assert.equal(decision(parsed, "private/a/b.txt").excluded, true);
  assert.equal(decision(parsed, "src/index.ts").excluded, false);
});

test("explicit user selection takes precedence over ignore files", () => {
  const parsed = parseIgnoreRules("secrets/**\n");

  assert.deepEqual(
    isExcluded(
      {
        projectId: PROJECT_ID,
        relativePath: "secrets/key.txt",
        explicitSelection: "include",
      },
      parsed,
    ),
    { excluded: false, reason: "explicit_include" },
  );
  assert.deepEqual(
    isExcluded(
      {
        projectId: PROJECT_ID,
        relativePath: "src/index.ts",
        explicitSelection: "exclude",
      },
      parsed,
    ),
    { excluded: true, reason: "explicit_exclude" },
  );
});

test("unsafe ignore patterns are diagnosed and unsafe evaluation paths fail closed", () => {
  const parsed = parseIgnoreRules("/absolute\n../parent\n!\n[unsupported]\n");
  assert.deepEqual(
    parsed.diagnostics.map((entry) => entry.code),
    [
      "ABSOLUTE_PATTERN",
      "PARENT_TRAVERSAL",
      "EMPTY_NEGATION",
      "UNSUPPORTED_PATTERN",
    ],
  );
  assert.throws(
    () => decision(parsed, "../outside.txt"),
    /safe project-relative path/u,
  );
});

function decision(parsed, relativePath) {
  return isExcluded({ projectId: PROJECT_ID, relativePath }, parsed);
}
