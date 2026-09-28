import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensurePrivateDirectories,
  resolveAppDataPaths,
  resolveCodexHomes,
} from "../../../dist/config/paths.js";

test("resolveAppDataPaths follows Linux XDG locations and overrides", () => {
  const paths = resolveAppDataPaths(
    { exportsDir: "~/shared-exports" },
    {
      platform: "linux",
      homeDir: "/home/tester",
      env: {
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_CACHE_HOME: "/xdg/cache",
        XDG_STATE_HOME: "/xdg/state",
      },
    },
  );

  assert.equal(paths.configFile, "/xdg/config/context-bridge/config.toml");
  assert.equal(paths.databaseFile, "/xdg/data/context-bridge/context-bridge.sqlite");
  assert.equal(paths.modelCacheDir, "/xdg/cache/context-bridge/models");
  assert.equal(paths.logsDir, "/xdg/state/context-bridge/logs");
  assert.equal(paths.exportsDir, "/home/tester/shared-exports");
});

test("resolveAppDataPaths uses Windows roaming and local application data", () => {
  const paths = resolveAppDataPaths(
    {},
    {
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {
        APPDATA: "C:\\Roaming",
        LOCALAPPDATA: "C:\\Local",
      },
    },
  );

  assert.equal(paths.configFile, "C:\\Roaming\\ContextBridge\\config.toml");
  assert.equal(
    paths.databaseFile,
    "C:\\Local\\ContextBridge\\context-bridge.sqlite",
  );
  assert.equal(paths.modelCacheDir, "C:\\Local\\ContextBridge\\cache\\models");
});

test("resolveAppDataPaths uses macOS Application Support, Caches, and Logs", () => {
  const paths = resolveAppDataPaths(
    {},
    {
      platform: "darwin",
      homeDir: "/Users/tester",
      env: {},
    },
  );

  assert.equal(
    paths.configFile,
    "/Users/tester/Library/Application Support/ContextBridge/config.toml",
  );
  assert.equal(
    paths.databaseFile,
    "/Users/tester/Library/Application Support/ContextBridge/context-bridge.sqlite",
  );
  assert.equal(
    paths.modelCacheDir,
    "/Users/tester/Library/Caches/ContextBridge/models",
  );
  assert.equal(paths.logsDir, "/Users/tester/Library/Logs/ContextBridge");
});

test("ensurePrivateDirectories creates private application-owned directories", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-paths-");
  const paths = resolveAppDataPaths(
    {},
    {
      platform: process.platform,
      homeDir: root,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
      },
    },
  );

  const states = await ensurePrivateDirectories(paths);
  const expectedDirectories = new Set([
    paths.configDir,
    paths.dataDir,
    paths.objectsDir,
    paths.vectorDir,
    paths.cacheDir,
    paths.modelCacheDir,
    paths.stateDir,
    paths.logsDir,
    paths.exportsDir,
  ]);
  assert.equal(states.length, expectedDirectories.size);

  for (const state of states) {
    const details = await stat(state.path);
    assert.equal(details.isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal(details.mode & 0o777, 0o700);
    }
  }
});

test("resolveCodexHomes returns usable homes and diagnostic states", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-codex-");
  const existing = join(root, "codex-home");
  const missing = join(root, "missing-home");
  await mkdir(existing);

  const resolution = await resolveCodexHomes({
    platform: process.platform,
    homeDir: root,
    env: {},
    configuredHomes: [existing, existing, missing],
  });

  assert.equal(resolution.source, "configured");
  assert.deepEqual(resolution.homes, [existing]);
  assert.deepEqual(resolution.diagnostics, [
    { code: "CODEX_HOME_NOT_FOUND", path: missing },
  ]);

  const unavailable = await resolveCodexHomes({
    platform: process.platform,
    homeDir: join(tmpdir(), "context-bridge-definitely-missing"),
    env: {},
  });
  assert.equal(unavailable.homes.length, 0);
  assert.equal(
    unavailable.diagnostics.at(-1)?.code,
    "NO_AVAILABLE_CODEX_HOME",
  );
});

async function makeTemporaryDirectory(testContext, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
