import assert from "node:assert/strict";
import test from "node:test";

import {
  projectId,
  sessionId,
  workstreamId,
} from "../../../dist/contracts/ids.js";
import {
  isResolvedScope,
  normalizeScopeAlias,
  sameScope,
  scopeAddress,
  scopeContains,
} from "../../../dist/contracts/scope.js";

const projectA = projectId(["git.example.com", "team/project-a"]);
const projectB = projectId(["git.example.com", "team/project-b"]);
const workstreamA = workstreamId([projectA, "feature/search"]);
const sessionA = sessionId(["session-a"]);

test("scopeAddress produces the canonical hierarchy for every scope kind", () => {
  assert.deepEqual(
    scopeAddress({ kind: "project", id: projectA, displayName: "Project A" }),
    { projectId: projectA },
  );

  assert.deepEqual(
    scopeAddress({
      kind: "workstream",
      id: workstreamA,
      projectId: projectA,
      displayName: "Search",
    }),
    { projectId: projectA, workstreamId: workstreamA },
  );

  assert.deepEqual(
    scopeAddress({
      kind: "session",
      id: sessionA,
      projectId: projectA,
      workstreamId: workstreamA,
    }),
    {
      projectId: projectA,
      workstreamId: workstreamA,
      sessionId: sessionA,
    },
  );
});

test("scope containment never crosses projects or narrower boundaries", () => {
  const projectScope = { projectId: projectA };
  const workstreamScope = { projectId: projectA, workstreamId: workstreamA };
  const sessionScope = { ...workstreamScope, sessionId: sessionA };

  assert.equal(scopeContains(projectScope, sessionScope), true);
  assert.equal(scopeContains(workstreamScope, sessionScope), true);
  assert.equal(scopeContains(sessionScope, workstreamScope), false);
  assert.equal(
    scopeContains(projectScope, { projectId: projectB, sessionId: sessionA }),
    false,
  );
  assert.equal(sameScope(workstreamScope, { ...workstreamScope }), true);
  assert.equal(sameScope(projectScope, workstreamScope), false);
});

test("scope aliases normalize deterministically and reject unsafe values", () => {
  assert.equal(normalizeScopeAlias("  Payment   API  "), "payment api");
  assert.equal(normalizeScopeAlias("Ｐａｙｍｅｎｔ"), "payment");
  assert.throws(() => normalizeScopeAlias("   "), /invalid scope alias/i);
  assert.throws(() => normalizeScopeAlias("project\nname"), /invalid scope alias/i);
});

test("isResolvedScope narrows resolution results", () => {
  assert.equal(
    isResolvedScope({
      status: "resolved",
      scope: { kind: "project", id: projectA, displayName: "Project A" },
      matchedBy: "explicit_id",
    }),
    true,
  );
  assert.equal(
    isResolvedScope({ status: "not_found", reason: "No matching scope" }),
    false,
  );
});
