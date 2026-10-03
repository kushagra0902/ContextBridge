import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractBearerToken,
  loadOrCreateLocalSecret,
  validateLocalRequest,
  verifyLocalToken,
} from "../../../dist/security/local-auth.js";

test("local secret is stable, private, and verifiable", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-auth-");
  const secretPath = join(root, "state", "local-auth.secret");

  const first = await loadOrCreateLocalSecret(secretPath);
  const second = await loadOrCreateLocalSecret(secretPath);
  assert.equal(first, second);
  assert.match(first, /^cb1\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(verifyLocalToken(first, second), true);
  assert.equal(verifyLocalToken(`${first}x`, second), false);

  if (process.platform !== "win32") {
    const details = await stat(secretPath);
    assert.equal(details.mode & 0o777, 0o600);
  }
});

test("local request authentication enforces host, origin, and bearer token", async () => {
  const secret = `cb1.${"a".repeat(43)}`;
  assert.deepEqual(
    await validateLocalRequest(
      {
        host: "127.0.0.1:43110",
        origin: "http://localhost:3000",
        authorization: `Bearer ${secret}`,
      },
      secret,
      { allowedOrigins: ["http://localhost:3000"] },
    ),
    { allowed: true },
  );
  assert.deepEqual(
    await validateLocalRequest(
      { host: "192.168.1.10:43110", authorization: `Bearer ${secret}` },
      secret,
    ),
    { allowed: false, reason: "invalid_host" },
  );
  assert.deepEqual(
    await validateLocalRequest(
      {
        host: "localhost:43110",
        origin: "https://example.com",
        authorization: `Bearer ${secret}`,
      },
      secret,
    ),
    { allowed: false, reason: "invalid_origin" },
  );
  assert.deepEqual(
    await validateLocalRequest(
      { host: "[::1]:43110", authorization: "Bearer wrong-token-value" },
      secret,
    ),
    { allowed: false, reason: "invalid_token" },
  );
  assert.equal(extractBearerToken(`Bearer ${secret}`), secret);
  assert.equal(extractBearerToken(`Basic ${secret}`), undefined);
});

test("local secret loader rejects symbolic-link secret files", async (t) => {
  const root = await makeTemporaryDirectory(t, "context-bridge-auth-link-");
  const state = join(root, "state");
  const target = join(root, "target.secret");
  const link = join(state, "local-auth.secret");
  await loadOrCreateLocalSecret(join(state, "bootstrap.secret"));
  await writeFile(target, `cb1.${"b".repeat(43)}\n`);
  try {
    await symlink(target, link, "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symbolic links require additional privileges on this platform");
      return;
    }
    throw error;
  }

  await assert.rejects(
    loadOrCreateLocalSecret(link),
    (error) => error.code === "INVALID_SECRET_FILE",
  );
});

async function makeTemporaryDirectory(testContext, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
