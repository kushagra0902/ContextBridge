import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkId,
  eventId,
  projectId,
  sessionId,
} from "../../../dist/contracts/ids.js";
import {
  buildExtractiveSynopsis,
  extractDecisionCandidates,
  extractOpenItemCandidates,
  validateMemoryEvidence,
} from "../../../dist/processing/memory/index.js";

const project = projectId(["memory-project"]);
const session = sessionId(["memory-session"]);
const firstEvent = eventId([session, "event-1"]);
const secondEvent = eventId([session, "event-2"]);

const chunks = [
  {
    id: chunkId([session, "chunk-1"]),
    sequence: 0,
    scope: { projectId: project, sessionId: session },
    eventIds: [firstEvent],
    displayText: [
      "User:",
      "We need a local database. What constraints remain?",
      "",
      "Assistant:",
      "We decided to use SQLite for persistence because it works offline.",
      "We rejected PostgreSQL because it requires a server.",
      "Constraint: storage must remain local.",
      "TODO: add migration tests.",
    ].join("\n"),
    embeddingText: "local database SQLite persistence offline migration tests",
    tokenCount: 20,
    fingerprint: "chunk-one",
    observedFrom: "2026-01-01T00:00:00.000Z",
    observedTo: "2026-01-01T00:01:00.000Z",
  },
  {
    id: chunkId([session, "chunk-2"]),
    sequence: 1,
    scope: { projectId: project, sessionId: session },
    eventIds: [secondEvent],
    displayText: [
      "User:",
      "What changed?",
      "",
      "Assistant:",
      "We decided to use PostgreSQL for persistence instead of SQLite because team access is now required.",
      "Next step: benchmark migration.",
    ].join("\n"),
    embeddingText: "PostgreSQL persistence instead SQLite team benchmark migration",
    tokenCount: 18,
    fingerprint: "chunk-two",
    observedFrom: "2026-01-02T00:00:00.000Z",
    observedTo: "2026-01-02T00:01:00.000Z",
  },
];

const derivedAt = "2026-01-03T00:00:00.000Z";

test("extractive synopsis cites exact chunks for goals, state, constraints and open questions", () => {
  const synopsis = buildExtractiveSynopsis(chunks, { derivedAt });
  assert.ok(synopsis);
  assert.equal(synopsis.derivation, "extractive");
  assert.equal(synopsis.status, "active");
  assert.ok(synopsis.sections.some((section) => section.name === "goal"));
  assert.ok(synopsis.sections.some((section) => section.name === "current_state"));
  assert.ok(synopsis.sections.some((section) => section.name === "constraints"));
  assert.ok(synopsis.sections.some((section) => section.name === "open_questions"));
  assert.deepEqual(new Set(synopsis.evidenceIds), new Set(chunks.map((chunk) => chunk.id)));
});

test("explicit replacement preserves both decisions and marks the older candidate superseded", () => {
  const decisions = extractDecisionCandidates(chunks, { derivedAt });
  assert.equal(decisions.length, 2);
  const sqlite = decisions.find((decision) => decision.decision.includes("SQLite for persistence"));
  const postgres = decisions.find((decision) => decision.decision.includes("PostgreSQL for persistence"));

  assert.equal(sqlite?.status, "superseded");
  assert.equal(sqlite?.supersededBy, postgres?.id);
  assert.deepEqual(postgres?.supersedes, [sqlite?.id]);
  assert.equal(postgres?.status, "candidate");
  assert.equal(postgres?.rationale, "team access is now required.");
});

test("open-item candidates remain heuristic and evidence validation rejects invented citations", () => {
  const items = extractOpenItemCandidates(chunks, { derivedAt });
  assert.ok(items.some((item) => item.itemKind === "todo"));
  assert.ok(items.some((item) => item.itemKind === "follow_up"));
  assert.equal(items.some((item) => item.itemKind === "question"), false);
  assert.equal(items.every((item) => item.status === "candidate"), true);

  const synopsis = buildExtractiveSynopsis(chunks, { derivedAt });
  const availableEvidenceIds = new Set(
    chunks.flatMap((chunk) => [chunk.id, ...chunk.eventIds]),
  );
  validateMemoryEvidence(synopsis, {
    scope: chunks[0].scope,
    availableEvidenceIds,
    knownMemoryIds: new Set([synopsis.id]),
  });
  assert.throws(
    () => validateMemoryEvidence(
      { ...synopsis, evidenceIds: [eventId([session, "invented"])] },
      {
        scope: chunks[0].scope,
        availableEvidenceIds,
        knownMemoryIds: new Set([synopsis.id]),
      },
    ),
    /unavailable or foreign evidence/i,
  );
});
