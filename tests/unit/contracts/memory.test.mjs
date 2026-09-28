import assert from "node:assert/strict";
import test from "node:test";

import { chunkId, eventId, memoryId, sessionId } from "../../../dist/contracts/ids.js";
import {
  collectMemoryEvidenceIds,
  isMemoryType,
  isTerminalMemoryStatus,
} from "../../../dist/contracts/memory.js";

test("collectMemoryEvidenceIds includes nested evidence once in first-seen order", () => {
  const firstEvent = eventId(["session-a", "1"]);
  const secondEvent = eventId(["session-a", "2"]);
  const chunk = chunkId(["session-a", "chunk-1"]);

  const memory = {
    id: memoryId(["episode", "session-a"]),
    type: "episode",
    scope: { sessionId: sessionId(["session-a"]) },
    title: "Investigated an indexing failure",
    body: "The first attempt failed and the second succeeded.",
    status: "active",
    evidenceIds: [firstEvent, chunk],
    derivation: "extractive",
    extractorVersion: "test-v1",
    derivedAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    steps: [
      {
        ordinal: 0,
        kind: "error",
        description: "The first attempt failed.",
        evidenceIds: [firstEvent, secondEvent],
      },
    ],
  };

  assert.deepEqual(collectMemoryEvidenceIds(memory), [
    firstEvent,
    chunk,
    secondEvent,
  ]);
});

test("memory type and terminal-state guards are stable", () => {
  assert.equal(isMemoryType("decision"), true);
  assert.equal(isMemoryType("transcript"), false);
  assert.equal(isTerminalMemoryStatus("superseded"), true);
  assert.equal(isTerminalMemoryStatus("conflicted"), false);
});
