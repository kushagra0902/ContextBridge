import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { inspectRepository } from "../../../../dist/sources/git/repository.js";

const execFileAsync = promisify(execFile);

test("repository inspection reads root, branch, commit, common directory, and remotes", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("Git executable is unavailable");
    return;
  }

  const root = await temporaryDirectory(t);
  const repository = join(root, "repository");
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await writeFile(join(repository, "README.md"), "synthetic repository\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Context Bridge Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "synthetic initial commit",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "remote",
    "add",
    "origin",
    "git@github.com:Example/Repository.git",
  ]);
  const nested = join(repository, "src", "nested");
  await mkdir(nested, { recursive: true });

  const result = await inspectRepository(nested);
  assert.equal(result.status, "ok");
  assert.equal(result.repository.root, await realpath(repository));
  assert.equal(result.repository.commonDirectory, await realpath(join(repository, ".git")));
  assert.equal(result.repository.branch, "main");
  assert.match(result.repository.headCommit, /^[0-9a-f]{40}$/u);
  assert.equal(
    result.repository.primaryRemote.remote.canonical,
    "github.com/example/repository",
  );
  assert.deepEqual(result.diagnostics, []);

  const worktree = join(root, "linked-worktree");
  await execFileAsync("git", [
    "-C",
    repository,
    "worktree",
    "add",
    "-b",
    "feature/linked",
    worktree,
  ]);
  const linked = await inspectRepository(worktree);
  assert.equal(linked.status, "ok");
  assert.notEqual(linked.repository.root, result.repository.root);
  assert.equal(linked.repository.commonDirectory, result.repository.commonDirectory);
  assert.equal(
    linked.repository.primaryRemote.remote.canonical,
    result.repository.primaryRemote.remote.canonical,
  );
});

test("repository inspection returns explicit states for missing and non-repository paths", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, "ordinary-directory");
  await mkdir(directory);

  assert.equal((await inspectRepository(join(root, "missing"))).status, "not_found");
  if (await gitAvailable()) {
    assert.equal((await inspectRepository(directory)).status, "not_repository");
  }
  assert.equal(
    (await inspectRepository(directory, { gitBinary: join(root, "missing-git") }))
      .status,
    "git_unavailable",
  );
});

async function gitAvailable() {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function temporaryDirectory(testContext) {
  const directory = await mkdtemp(join(tmpdir(), "context-bridge-git-"));
  testContext.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
