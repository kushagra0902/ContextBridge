import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../../../dist/config/defaults.js";
import {
  ConfigVersionError,
  parseConfig,
} from "../../../dist/config/schema.js";

test("parseConfig supplies the documented bounded defaults", () => {
  assert.deepEqual(parseConfig({ version: 1 }), DEFAULT_CONFIG);
});

test("parseConfig migrates the unversioned pre-release shape", () => {
  const config = parseConfig({
    sources: { pollingIntervalMs: 45_000 },
  });

  assert.equal(config.version, 1);
  assert.equal(config.sources.pollingIntervalMs, 45_000);
  assert.equal(config.sources.maxRecordsPerBatch, 500);
});

test("strict schemas reject unknown and contradictory settings", () => {
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        embeddings: { apiKey: "must-not-live-in-toml" },
      }),
    /unrecognized key/i,
  );
  assert.throws(
    () => parseConfig({ version: 1, apiKey: "must-not-live-in-toml" }),
    /unrecognized key/i,
  );
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        processing: { chunkTargetTokens: 1_000, chunkMaxTokens: 500 },
      }),
    /chunkTargetTokens cannot exceed chunkMaxTokens/i,
  );
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        embeddings: {
          enabled: true,
          provider: "local_transformers",
        },
      }),
    /pinned modelId/i,
  );
});

test("remote embeddings require a pinned model and HTTPS endpoint", () => {
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        embeddings: {
          enabled: true,
          provider: "remote",
          modelId: "provider/model",
          modelRevision: "sha256:revision",
          remoteEndpoint: "https://token@example.test/embeddings",
        },
      }),
    /contain no credentials/i,
  );

  assert.throws(
    () =>
      parseConfig({
        version: 1,
        embeddings: {
          enabled: true,
          provider: "remote",
          modelId: "provider/model",
          modelRevision: "sha256:revision",
          remoteEndpoint: "http://example.test/embeddings",
        },
      }),
    /HTTPS/i,
  );

  const config = parseConfig({
    version: 1,
    embeddings: {
      enabled: true,
      provider: "remote",
      modelId: "provider/model",
      modelRevision: "sha256:revision",
      remoteEndpoint: "https://example.test/embeddings",
    },
  });
  assert.equal(config.embeddings.enabled, true);
});

test("future configuration versions fail explicitly", () => {
  assert.throws(
    () => parseConfig({ version: 2 }),
    (error) => error instanceof ConfigVersionError && error.version === 2,
  );
});
