import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGitRemote } from "../../../../dist/sources/git/remote.js";

test("HTTPS, SSH URL, and SCP remotes share one canonical identity", () => {
  const values = [
    "https://github.com/Example/Context-Bridge.git",
    "ssh://git@github.com/Example/Context-Bridge.git",
    "git@github.com:Example/Context-Bridge.git",
  ].map(normalizeGitRemote);

  assert.equal(values.every((result) => result.ok), true);
  assert.deepEqual(
    values.map((result) => result.remote.canonical),
    [
      "github.com/example/context-bridge",
      "github.com/example/context-bridge",
      "github.com/example/context-bridge",
    ],
  );
});

test("remote normalization strips credentials and preserves meaningful ports", () => {
  const credentialed = normalizeGitRemote(
    "https://synthetic-token:synthetic-password@example.com/Team/Repo.git",
  );
  assert.equal(credentialed.ok, true);
  assert.equal(credentialed.remote.canonical, "example.com/Team/Repo");
  assert.equal(credentialed.remote.provenance.credentialsStripped, true);
  assert.equal(
    credentialed.remote.provenance.sanitized.includes("synthetic"),
    false,
  );

  const customPort = normalizeGitRemote(
    "ssh://git@example.com:2222/Team/Repo.git",
  );
  assert.equal(customPort.ok, true);
  assert.equal(customPort.remote.canonical, "example.com:2222/Team/Repo");
});

test("remote normalization rejects local, ambiguous, and secret-bearing forms", () => {
  assert.deepEqual(normalizeGitRemote("/home/user/repository"), {
    ok: false,
    reason: "local_path",
  });
  assert.deepEqual(normalizeGitRemote("file:///home/user/repository"), {
    ok: false,
    reason: "unsupported_protocol",
  });
  assert.deepEqual(
    normalizeGitRemote("https://example.com/team/repo.git?token=secret"),
    { ok: false, reason: "query_or_fragment" },
  );
  assert.equal(normalizeGitRemote("not-a-remote").ok, false);
});

test("different hosts and paths remain different repository identities", () => {
  const first = normalizeGitRemote("https://example.com/team/service.git");
  const second = normalizeGitRemote("https://example.net/team/service.git");
  const third = normalizeGitRemote("https://example.com/other/service.git");
  assert.equal(first.ok && second.ok && third.ok, true);
  assert.notEqual(first.remote.canonical, second.remote.canonical);
  assert.notEqual(first.remote.canonical, third.remote.canonical);
});
