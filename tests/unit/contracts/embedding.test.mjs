import assert from "node:assert/strict";
import test from "node:test";

import {
  embeddingSpacesAreCompatible,
  isRunnableEmbeddingJob,
  validateEmbeddingVector,
} from "../../../dist/contracts/embedding.js";

const baseSpace = {
  id: "space-v1",
  provider: "local_transformers",
  modelId: "test-model",
  modelRevision: "revision-1",
  dimension: 3,
  distanceMetric: "cosine",
  normalization: "l2",
  tokenizerVersion: "tokenizer-v1",
  preprocessingVersion: "prepare-v1",
  redactionVersion: "redact-v1",
  documentPrefix: "passage: ",
  queryPrefix: "query: ",
  status: "active",
  createdAt: "2026-09-23T10:00:00.000Z",
};

test("embedding compatibility includes every geometry and text-preparation field", () => {
  assert.equal(
    embeddingSpacesAreCompatible(baseSpace, {
      ...baseSpace,
      id: "shadow-space",
      status: "building",
    }),
    true,
  );

  assert.equal(
    embeddingSpacesAreCompatible(baseSpace, {
      ...baseSpace,
      tokenizerVersion: "tokenizer-v2",
    }),
    false,
  );
});

test("embedding vectors must match the manifest", () => {
  assert.doesNotThrow(() => {
    validateEmbeddingVector(new Float32Array([0.1, 0.2, 0.3]), baseSpace);
  });
  assert.throws(
    () => validateEmbeddingVector(new Float32Array([0.1, 0.2]), baseSpace),
    /dimension mismatch/i,
  );
  assert.throws(
    () => validateEmbeddingVector(new Float32Array([0.1, Number.NaN, 0.3]), baseSpace),
    /finite numbers/i,
  );
});

test("only pending and due retry jobs are runnable", () => {
  const now = new Date("2026-09-23T10:00:00.000Z");
  const job = {
    id: "job-1",
    entity: { kind: "chunk", id: "chunk-1" },
    spaceId: "space-v1",
    desiredFingerprint: "fingerprint-1",
    operation: "upsert",
    state: "retry",
    attempts: 1,
    retryAt: "2026-09-23T09:59:00.000Z",
    createdAt: "2026-09-23T09:00:00.000Z",
    updatedAt: "2026-09-23T09:30:00.000Z",
  };

  assert.equal(isRunnableEmbeddingJob(job, now), true);
  assert.equal(
    isRunnableEmbeddingJob(
      { ...job, retryAt: "2026-09-23T10:01:00.000Z" },
      now,
    ),
    false,
  );
  assert.equal(isRunnableEmbeddingJob({ ...job, state: "failed" }, now), false);
});
