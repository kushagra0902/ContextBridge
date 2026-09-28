import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigFileError,
  loadConfig,
  parseConfigToml,
  saveConfigAtomically,
  stringifyConfig,
} from "../../../dist/config/load.js";
import { parseConfig } from "../../../dist/config/schema.js";

test("configuration TOML round-trips through strict validation", () => {
  const config = parseConfig({
    version: 1,
    sources: { pollingIntervalMs: 60_000 },
    retrieval: { maxItems: 8, searchMaxTokens: 4_000 },
  });

  assert.deepEqual(parseConfigToml(stringifyConfig(config)), config);
});

test("saveConfigAtomically writes a private file that loadConfig reads", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-config-");
  const configPath = join(root, "nested", "config.toml");
  const config = parseConfig({
    version: 1,
    sources: { pollingIntervalMs: 45_000 },
    paths: { dataDir: join(root, "state") },
  });

  assert.equal(await saveConfigAtomically(config, configPath), configPath);
  assert.deepEqual(await loadConfig(configPath), config);
  assert.deepEqual(
    (await readdir(join(root, "nested"))).filter((name) => name.endsWith(".tmp")),
    [],
  );

  if (process.platform !== "win32") {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }
});

test("loadConfig returns defaults for a missing configuration", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-missing-");
  const config = await loadConfig(join(root, "missing.toml"));
  assert.equal(config.version, 1);
  assert.equal(config.embeddings.enabled, false);
});

test("loadConfig reports TOML, schema, and size failures without contents", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-invalid-");
  const parsePath = join(root, "parse.toml");
  const schemaPath = join(root, "schema.toml");
  const largePath = join(root, "large.toml");
  await writeFile(parsePath, "version = [");
  await writeFile(schemaPath, 'version = 1\napiKey = "forbidden"\n');
  await writeFile(largePath, "x".repeat(1_048_577));

  await assert.rejects(
    loadConfig(parsePath),
    (error) =>
      error instanceof ConfigFileError && error.code === "CONFIG_PARSE_FAILED",
  );
  await assert.rejects(
    loadConfig(schemaPath),
    (error) =>
      error instanceof ConfigFileError &&
      error.code === "CONFIG_VALIDATION_FAILED" &&
      error.issues?.some((issue) => issue.includes("Unrecognized key")),
  );
  await assert.rejects(
    loadConfig(largePath),
    (error) =>
      error instanceof ConfigFileError && error.code === "CONFIG_TOO_LARGE",
  );
});

async function makeTemporaryDirectory(testContext, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
