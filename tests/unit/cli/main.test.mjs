import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../../../dist/cli/index.js";

const projectId = `ku::project:${"a".repeat(64)}`;

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    },
    read: () => ({ stdout, stderr }),
  };
}

function application(overrides = {}) {
  return {
    initialize: async () => ({ status: "ok" }),
    listSources: async () => ({ status: "ok", sources: [] }),
    index: async () => ({ status: "ok" }),
    doctor: async () => ({ status: "ok" }),
    reindex: async () => ({ status: "ok", sessions: [] }),
    forget: async () => ({ status: "pending" }),
    exportScope: async () => ({ status: "ok" }),
    service: async () => ({ status: "unsupported" }),
    serveStdio: async () => undefined,
    serveHttp: async () => undefined,
    listContextScopes: async () => ({ status: "empty", scopes: [] }),
    getContextOverview: async () => ({ status: "empty" }),
    searchMemory: async () => ({ status: "empty", hits: [] }),
    getEvidence: async () => ({ status: "not_found", events: [], chunks: [] }),
    close: async () => undefined,
    ...overrides,
  };
}

test("CLI maps search flags to the shared use case and emits stable JSON", async () => {
  const output = capture();
  let received;
  let closed = false;
  let options;
  const exitCode = await runCli([
    "search", "why sqlite", "--project", projectId, "--limit", "3",
    "--json", "--config", "/tmp/context-bridge-test.toml",
  ], {
    io: output.io,
    createApplication: async (value) => {
      options = value;
      return application({
        searchMemory: async (input) => {
          received = input;
          return { status: "empty", hits: [] };
        },
        close: async () => { closed = true; },
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(options, { configPath: "/tmp/context-bridge-test.toml" });
  assert.equal(received.query, "why sqlite");
  assert.deepEqual(received.filters.scope, { projectId });
  assert.deepEqual(received.budget, { maxItems: 3 });
  assert.equal(closed, true);
  assert.deepEqual(JSON.parse(output.read().stdout), { status: "empty", hits: [] });
  assert.equal(output.read().stderr, "");
});

test("CLI maps explicit init project selections", async () => {
  const output = capture();
  const otherProjectId = `ku::project:${"b".repeat(64)}`;
  let received;
  const exitCode = await runCli([
    "init",
    "--codex-home", "/tmp/codex-a",
    "--codex-home", "/tmp/codex-b",
    "--include-project", projectId,
    "--exclude-project", otherProjectId,
    "--json",
  ], {
    io: output.io,
    createApplication: async () => application({
      initialize: async (input) => {
        received = input;
        return { status: "ok" };
      },
    }),
  });

  assert.equal(exitCode, 0, output.read().stderr);
  assert.deepEqual(received, {
    codexHomes: ["/tmp/codex-a", "/tmp/codex-b"],
    includeProjectIds: [projectId],
    excludeProjectIds: [otherProjectId],
  });
});

test("CLI requires explicit confirmation for forget", async () => {
  const output = capture();
  let called = false;
  const exitCode = await runCli(["forget", "--project", projectId, "--json"], {
    io: output.io,
    createApplication: async () => application({
      forget: async () => { called = true; return { status: "complete" }; },
    }),
  });
  assert.equal(exitCode, 2);
  assert.equal(called, false);
  assert.match(output.read().stderr, /requires --yes/);
});

test("CLI does not leak unexpected error details", async () => {
  const output = capture();
  const exitCode = await runCli(["doctor", "--json"], {
    io: output.io,
    createApplication: async () => application({
      doctor: async () => { throw new Error("seeded-secret-must-not-leak"); },
    }),
  });
  assert.equal(exitCode, 1);
  assert.doesNotMatch(output.read().stderr, /seeded-secret/);
  assert.match(output.read().stderr, /COMMAND_FAILED/);
});
