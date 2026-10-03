import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverCodexSources } from "../../../../dist/sources/codex/discover.js";

test("discovery returns only approved rollout and optional metadata sources", async (t) => {
  const root = await temporaryDirectory(t);
  const home = join(root, ".codex");
  const sessions = join(home, "sessions", "2026", "01", "02");
  const rollout = join(sessions, "rollout-synthetic.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "cache"));
  await Promise.all([
    writeFile(rollout, "{}\n"),
    writeFile(join(home, "history.jsonl"), "{}\n"),
    writeFile(join(home, "session_index.jsonl"), "{}\n"),
    writeFile(join(home, "auth.json"), "synthetic credential"),
    writeFile(join(home, "cache", "rollout-cache.jsonl"), "{}\n"),
  ]);

  const result = await discoverCodexSources([home]);
  assert.deepEqual(
    result.sources.map((source) => source.kind).sort(),
    ["codex_history", "codex_rollout", "codex_session_index"],
  );
  assert.equal(
    result.sources.some((source) => source.normalizedPath.endsWith("auth.json")),
    false,
  );
  assert.equal(
    result.sources.some((source) => source.normalizedPath.includes("cache")),
    false,
  );
  assert.equal(result.sources.every((source) => source.fileIdentity.size > 0), true);
});

test("discovery reports missing homes and enforces excluded roots", async (t) => {
  const root = await temporaryDirectory(t);
  const home = join(root, ".codex");
  const excluded = join(home, "sessions", "private");
  await mkdir(excluded, { recursive: true });
  await writeFile(join(excluded, "rollout-private.jsonl"), "{}\n");

  const result = await discoverCodexSources([home, join(root, "missing")], {
    includeHistory: false,
    includeSessionIndex: false,
    excludedRoots: [excluded],
  });
  assert.deepEqual(result.sources, []);
  assert.equal(
    result.diagnostics.some((entry) => entry.code === "HOME_NOT_FOUND"),
    true,
  );
  assert.equal(
    result.diagnostics.some(
      (entry) =>
        entry.code === "SOURCE_REJECTED" && entry.reason === "excluded_root",
    ),
    true,
  );
});

async function temporaryDirectory(testContext) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-discover-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
