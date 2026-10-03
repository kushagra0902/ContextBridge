import assert from "node:assert/strict";
import test from "node:test";

import {
  projectId,
  sessionId,
  workstreamId,
} from "../../../../dist/contracts/ids.js";
import {
  projectIdFromRemote,
  resolveProject,
} from "../../../../dist/sources/git/project-mapper.js";
import { normalizeGitRemote } from "../../../../dist/sources/git/remote.js";

const SESSION_ID = sessionId(["project-mapper-session"]);
const CREATED_AT = "2026-01-01T00:00:00.000Z";

test("explicit session mapping has highest precedence", async () => {
  const target = {
    projectId: projectId(["manual-project"]),
    workstreamId: workstreamId(["manual-workstream"]),
  };
  const result = await resolveProject(
    {
      sessionId: SESSION_ID,
      git: { repositoryUrl: "https://github.com/example/inferred.git" },
    },
    [mapping({ kind: "session", sessionId: SESSION_ID }, target)],
  );

  assert.equal(result.status, "mapped");
  assert.deepEqual(result.mapping.target, target);
  assert.equal(result.mapping.method, "explicit");
  assert.equal(result.mapping.confidence, "exact");
  assert.equal(result.mapping.reason, "explicit_session");
});

test("conflicting mappings at the same precedence return ambiguity", async () => {
  const result = await resolveProject(
    { sessionId: SESSION_ID },
    [
      mapping(
        { kind: "session", sessionId: SESSION_ID },
        { projectId: projectId(["first"]) },
      ),
      mapping(
        { kind: "session", sessionId: SESSION_ID },
        { projectId: projectId(["second"]) },
      ),
    ],
  );

  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.equal(
    result.candidates.every((candidate) => candidate.reason === "explicit_session"),
    true,
  );
});

test("explicit remote and repository-root mappings precede inference", async () => {
  const remote = normalized("https://github.com/example/mapped.git");
  const remoteTarget = projectId(["remote-override"]);
  const remoteResult = await resolveProject(
    {
      sessionId: SESSION_ID,
      git: { repositoryUrl: "git@github.com:example/mapped.git" },
    },
    [
      mapping(
        { kind: "git_remote", normalizedRemote: remote.canonical },
        { projectId: remoteTarget },
      ),
    ],
  );
  assert.equal(remoteResult.status, "mapped");
  assert.equal(remoteResult.mapping.target.projectId, remoteTarget);
  assert.equal(remoteResult.mapping.reason, "explicit_git_remote");

  const rootTarget = projectId(["root-override"]);
  const rootResult = await resolveProject(
    {
      sessionId: SESSION_ID,
      repository: repository("/workspace/project", []),
    },
    [
      mapping(
        { kind: "repository_root", normalizedPath: "/workspace/project" },
        { projectId: rootTarget },
      ),
    ],
  );
  assert.equal(rootResult.status, "mapped");
  assert.equal(rootResult.mapping.target.projectId, rootTarget);
  assert.equal(rootResult.mapping.reason, "explicit_repository_root");
});

test("two worktrees with the same remote map to one project", async () => {
  const remote = normalized("https://github.com/example/product.git");
  const first = await resolveProject(
    {
      sessionId: sessionId(["worktree-one"]),
      repository: repository("/worktrees/one", [{ name: "origin", remote }]),
    },
    [],
  );
  const second = await resolveProject(
    {
      sessionId: sessionId(["worktree-two"]),
      repository: repository("/worktrees/two", [{ name: "origin", remote }]),
    },
    [],
  );

  assert.equal(first.status, "mapped");
  assert.equal(second.status, "mapped");
  assert.equal(first.mapping.target.projectId, second.mapping.target.projectId);
  assert.equal(first.mapping.method, "git_remote");
});

test("repositories with similar names but different remotes stay separate", async () => {
  const first = await resolveProject(
    {
      sessionId: sessionId(["host-one"]),
      git: { repositoryUrl: "https://git-one.example/team/product.git" },
    },
    [],
  );
  const second = await resolveProject(
    {
      sessionId: sessionId(["host-two"]),
      git: { repositoryUrl: "https://git-two.example/team/product.git" },
    },
    [],
  );

  assert.equal(first.status, "mapped");
  assert.equal(second.status, "mapped");
  assert.notEqual(first.mapping.target.projectId, second.mapping.target.projectId);
});

test("unrelated repositories without remotes use distinct canonical roots", async () => {
  const first = await resolveProject(
    {
      sessionId: sessionId(["root-one"]),
      repository: repository("/workspace/one/product", []),
    },
    [],
  );
  const second = await resolveProject(
    {
      sessionId: sessionId(["root-two"]),
      repository: repository("/workspace/two/product", []),
    },
    [],
  );
  assert.equal(first.status, "mapped");
  assert.equal(second.status, "mapped");
  assert.notEqual(first.mapping.target.projectId, second.mapping.target.projectId);
  assert.equal(first.mapping.method, "repository_root");
});

test("historical remote metadata wins over changed repository state", async () => {
  const historical = "https://github.com/example/historical.git";
  const current = normalized("https://github.com/example/current.git");
  const result = await resolveProject(
    {
      sessionId: SESSION_ID,
      git: { repositoryUrl: historical, branch: "old-branch" },
      repository: repository("/repository", [{ name: "origin", remote: current }]),
    },
    [],
  );

  assert.equal(result.status, "mapped");
  assert.equal(
    result.mapping.target.projectId,
    projectIdFromRemote(normalized(historical).canonical),
  );
  assert.equal(result.mapping.reason, "session_git_remote");
});

test("longest explicit cwd prefix wins before inferred remote identity", async () => {
  const broad = projectId(["broad"]);
  const specific = projectId(["specific"]);
  const result = await resolveProject(
    {
      sessionId: SESSION_ID,
      cwd: "/workspace/team/product/packages/api",
      git: { repositoryUrl: "https://github.com/example/inferred.git" },
      repository: repository("/workspace/team/product", []),
    },
    [
      mapping({ kind: "cwd_prefix", normalizedPath: "/workspace" }, { projectId: broad }),
      mapping(
        { kind: "cwd_prefix", normalizedPath: "/workspace/team/product" },
        { projectId: specific },
      ),
    ],
  );

  assert.equal(result.status, "mapped");
  assert.equal(result.mapping.target.projectId, specific);
  assert.equal(result.mapping.reason, "explicit_cwd_prefix");
});

test("multiple primary remote identities are returned as ambiguous", async () => {
  const result = await resolveProject(
    {
      sessionId: SESSION_ID,
      repository: repository("/repository", [
        { name: "origin", remote: normalized("https://example.com/team/one.git") },
        { name: "origin", remote: normalized("https://example.com/team/two.git") },
      ]),
    },
    [],
  );

  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
});

test("missing historical cwd remains unmapped", async () => {
  const result = await resolveProject(
    {
      sessionId: SESSION_ID,
      cwd: "/deleted/repository",
      repository: { status: "not_found", diagnostics: [] },
    },
    [],
  );

  assert.deepEqual(result, {
    status: "unmapped",
    sessionId: SESSION_ID,
    reason: "cwd_not_found",
  });
});

function normalized(value) {
  const result = normalizeGitRemote(value);
  assert.equal(result.ok, true);
  return result.remote;
}

function repository(root, remotes) {
  return {
    status: "ok",
    repository: {
      root,
      commonDirectory: `${root}/.git`,
      remotes,
      ...(remotes[0] === undefined ? {} : { primaryRemote: remotes[0] }),
      branch: "feature/does-not-change-project",
      headCommit: "a".repeat(40),
    },
    diagnostics: [],
  };
}

function mapping(selector, target) {
  return {
    selector,
    target,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}
