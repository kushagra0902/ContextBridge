import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CompressedObjectStore,
  collectOrphanObjects,
} from "../../../dist/storage/objects/index.js";

test("compressed object store deduplicates, verifies, and garbage-collects by SQLite reference set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-bridge-objects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CompressedObjectStore({
    rootDirectory: root,
    maxObjectBytes: 1024,
  });

  const retained = await store.put("redacted retained output");
  const duplicate = await store.put("redacted retained output");
  const orphan = await store.put("redacted orphan output");
  assert.equal(retained.id, duplicate.id);
  assert.equal(duplicate.created, false);
  assert.equal(
    Buffer.from(await store.get(retained.id)).toString("utf8"),
    "redacted retained output",
  );

  const dryRun = await collectOrphanObjects(
    store,
    new Set([retained.id]),
    {
      now: new Date(Date.now() + 10_000),
      minimumAgeMs: 0,
      dryRun: true,
    },
  );
  assert.deepEqual(dryRun.orphaned, [orphan.id]);
  assert.deepEqual(dryRun.deleted, []);

  const swept = await collectOrphanObjects(
    store,
    new Set([retained.id]),
    { now: new Date(Date.now() + 10_000), minimumAgeMs: 0 },
  );
  assert.deepEqual(swept.deleted, [orphan.id]);
  assert.equal(await store.has(retained.id), true);
  assert.equal(await store.has(orphan.id), false);
});

test("compressed object store enforces uncompressed size and object IDs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-bridge-objects-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CompressedObjectStore({ rootDirectory: root, maxObjectBytes: 8 });
  await assert.rejects(store.put("123456789"), /exceeds 8 bytes/i);
  await assert.rejects(
    store.get("obj:sha256:not-a-digest"),
    /invalid object ID/i,
  );
});

test("compressed object store rejects a symbolic-link digest shard", async (t) => {
  if (platform() === "win32") {
    t.skip("directory symlink creation is privilege-dependent on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "context-bridge-objects-link-"));
  const outside = await mkdtemp(join(tmpdir(), "context-bridge-objects-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const value = "redacted output";
  const digest = createHash("sha256").update(value).digest("hex");
  await mkdir(root, { recursive: true });
  await symlink(outside, join(root, digest.slice(0, 2)), "dir");
  const store = new CompressedObjectStore({ rootDirectory: root });
  await assert.rejects(store.put(value), /shard must be a real directory/i);
});
