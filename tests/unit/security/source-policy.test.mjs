import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canReadSource } from "../../../dist/security/source-policy.js";

test("source policy permits only configured Codex source shapes", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-source-");
  const codexHome = join(root, ".codex");
  const rollout = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "rollout-session.jsonl",
  );
  const history = join(codexHome, "history.jsonl");
  const sessionIndex = join(codexHome, "session_index.jsonl");
  const cache = join(codexHome, "cache", "rollout-cache.jsonl");
  await mkdir(join(codexHome, "sessions", "2026", "09"), { recursive: true });
  await mkdir(join(codexHome, "cache"), { recursive: true });
  await Promise.all([
    writeFile(rollout, "{}\n"),
    writeFile(history, "{}\n"),
    writeFile(sessionIndex, "{}\n"),
    writeFile(cache, "{}\n"),
  ]);

  const config = {
    codexHomes: [codexHome],
    excludedRoots: [],
    includeHistory: true,
    includeSessionIndex: true,
  };

  assert.deepEqual(await canReadSource(rollout, config), {
    allowed: true,
    path: rollout,
    codexHome,
    sourceKind: "codex_rollout",
  });
  assert.equal((await canReadSource(history, config)).sourceKind, "codex_history");
  assert.equal(
    (await canReadSource(sessionIndex, config)).sourceKind,
    "codex_session_index",
  );
  assert.deepEqual(await canReadSource(cache, config), {
    allowed: false,
    path: cache,
    reason: "unsupported_path",
  });
});

test("source policy rejects secrets, exclusions, outside paths, and disabled optional sources", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-policy-");
  const codexHome = join(root, ".codex");
  const excluded = join(codexHome, "sessions", "private");
  const excludedRollout = join(excluded, "rollout-private.jsonl");
  const auth = join(codexHome, "auth.json");
  const history = join(codexHome, "history.jsonl");
  const outside = join(root, "rollout-outside.jsonl");
  await mkdir(excluded, { recursive: true });
  await Promise.all([
    writeFile(excludedRollout, "{}\n"),
    writeFile(auth, "seeded-secret"),
    writeFile(history, "{}\n"),
    writeFile(outside, "{}\n"),
  ]);

  const config = {
    codexHomes: [codexHome],
    excludedRoots: [excluded],
    includeHistory: false,
    includeSessionIndex: false,
  };

  assert.equal((await canReadSource(auth, config)).reason, "forbidden_name");
  assert.equal(
    (await canReadSource(excludedRollout, config)).reason,
    "excluded_root",
  );
  assert.equal((await canReadSource(outside, config)).reason, "outside_codex_home");
  assert.equal((await canReadSource(history, config)).reason, "unsupported_path");
});

test("source policy rejects a known path reached through a symbolic link", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-symlink-");
  const codexHome = join(root, ".codex");
  const realSessions = join(codexHome, "real-sessions");
  const linkedSessions = join(codexHome, "sessions");
  const realRollout = join(realSessions, "rollout-linked.jsonl");
  const linkedRollout = join(linkedSessions, "rollout-linked.jsonl");
  await mkdir(realSessions, { recursive: true });
  await writeFile(realRollout, "{}\n");

  try {
    await symlink(realSessions, linkedSessions, "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symbolic links require additional privileges on this platform");
      return;
    }
    throw error;
  }

  const decision = await canReadSource(linkedRollout, {
    codexHomes: [codexHome],
    excludedRoots: [],
    includeHistory: true,
    includeSessionIndex: true,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "symbolic_link");
});

async function makeTemporaryDirectory(testContext, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
