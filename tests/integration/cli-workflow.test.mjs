import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../../dist/cli/index.js";
import { saveConfigAtomically } from "../../dist/config/load.js";
import { parseConfig } from "../../dist/config/schema.js";

const sessionKey = "77777777-7777-4777-8777-777777777777";

test("M15 completes init, SQLite indexing, local search, and evidence inspection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-bridge-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state-home");
  t.after(() => {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
  });
  const codexHome = join(root, "codex-home");
  const sessionDirectory = join(codexHome, "sessions", "2026", "10", "03");
  const rollout = join(sessionDirectory, `rollout-test-${sessionKey}.jsonl`);
  const configPath = join(root, "config", "config.toml");
  const dataDir = join(root, "data");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(rollout, [
    line({
      timestamp: "2026-10-03T01:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: sessionKey,
        cwd: "/synthetic/context-bridge",
        git: { repository_url: "https://example.invalid/context/bridge.git", branch: "main" },
      },
    }),
    line(message("user", "Why was SQLite selected for context storage?", "message-user", 1)),
    line(message("assistant", "We decided to use SQLite for authoritative evidence and offline lexical search.", "message-assistant", 2)),
  ].join("\n") + "\n");
  await saveConfigAtomically(parseConfig({
    version: 1,
    paths: {
      dataDir,
      cacheDir: join(root, "cache"),
      logsDir: join(root, "logs"),
      exportsDir: join(root, "exports"),
    },
  }), configPath);

  const initialized = await invoke(["init", "--codex-home", codexHome, "--config", configPath, "--json"]);
  assert.equal(initialized.exitCode, 0, initialized.stderr);
  assert.equal(initialized.value.status, "ok");
  assert.equal(initialized.value.discoveredSources, 1);
  assert.equal(initialized.value.projects.length, 1);
  assert.equal(initialized.value.projects[0].displayName, "bridge");
  assert.equal(initialized.value.projects[0].sessions, 1);
  assert.equal(initialized.value.projects[0].availability, "selected");
  const previewProjectId = initialized.value.projects[0].projectId;

  const excluded = await invoke([
    "init", "--exclude-project", previewProjectId, "--config", configPath, "--json",
  ]);
  assert.equal(excluded.exitCode, 0, excluded.stderr);
  assert.equal(excluded.value.projects[0].availability, "excluded");

  const included = await invoke([
    "init", "--include-project", previewProjectId, "--config", configPath, "--json",
  ]);
  assert.equal(included.exitCode, 0, included.stderr);
  assert.equal(included.value.projects[0].availability, "selected");

  const indexed = await invoke(["index", "--initial", "--config", configPath, "--json"]);
  assert.equal(indexed.exitCode, 0, indexed.stderr);
  assert.equal(indexed.value.ingestion.totals.insertedEvents, 2, JSON.stringify(indexed.value));
  assert.equal(indexed.value.processing.failedSessions, 0);

  const scopes = await invoke(["scopes", "--config", configPath, "--json"]);
  assert.equal(scopes.exitCode, 0, scopes.stderr);
  const project = scopes.value.scopes.find((item) => item.scope.kind === "project")?.scope;
  assert.ok(project);
  assert.equal(project.id, previewProjectId);

  const searched = await invoke([
    "search", "SQLite", "--project", project.id, "--config", configPath, "--json",
  ]);
  assert.equal(searched.exitCode, 0, searched.stderr);
  assert.ok(searched.value.hits.length > 0, JSON.stringify(searched.value));
  const evidenceId = searched.value.hits[0].evidenceIds[0];
  assert.ok(evidenceId);

  const inspected = await invoke([
    "inspect", evidenceId, "--project", project.id, "--config", configPath, "--json",
  ]);
  assert.equal(inspected.exitCode, 0, inspected.stderr);
  assert.equal(inspected.value.status, "ok");
  assert.ok(inspected.value.events.length > 0 || inspected.value.chunks.length > 0);
  assert.equal(JSON.stringify(inspected.value).includes(codexHome), false);
});

function message(role, text, id, ordinal) {
  return {
    timestamp: `2026-10-03T01:00:0${ordinal}.000Z`,
    type: "response_item",
    ordinal,
    payload: {
      type: "message",
      id,
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

function line(value) {
  return JSON.stringify(value);
}

async function invoke(argv) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    io: {
      stdout: { write(value) { stdout += value; } },
      stderr: { write(value) { stderr += value; } },
    },
  });
  return { exitCode, stderr, value: stdout.length === 0 ? undefined : JSON.parse(stdout) };
}
