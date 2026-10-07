import assert from "node:assert/strict";
import test from "node:test";

import { eventId, projectId, sessionId, sourceId } from "../../../dist/contracts/ids.js";
import {
  analyzeEventBoundaries,
  buildChunks,
  fingerprintChunk,
  heuristicTokenizer,
} from "../../../dist/processing/chunks/index.js";

const session = sessionId(["chunk-test-session"]);
const project = projectId(["chunk-test-project"]);
const source = sourceId(["chunk-test-source"]);

function event(ordinal, kind, text, toolCallId) {
  return {
    id: eventId([session, String(ordinal), kind, text]),
    sessionId: session,
    ordinal,
    kind,
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, ordinal)).toISOString(),
    text,
    contentHash: `hash-${ordinal}`,
    EvidenceSource: {
      sourceId: source,
      sourceOrdinal: ordinal,
      formatVersion: "synthetic-v1",
    },
    ...(toolCallId === undefined ? {} : { toolCallId }),
  };
}

test("turn boundaries keep a delayed tool call and result in one ordered group", () => {
  const events = [
    event(0, "user_message", "Run the check"),
    event(1, "tool_call", "tool: shell\ninput: test", "call-1"),
    event(2, "user_message", "This boundary must not split the pending call"),
    event(3, "tool_result", "all checks passed", "call-1"),
    event(4, "user_message", "Now summarize"),
  ];
  const analysis = analyzeEventBoundaries([...events].reverse());

  assert.equal(analysis.toolPairs.length, 1);
  assert.deepEqual(
    analysis.groups.map((group) => group.events.map((item) => item.ordinal)),
    [[0, 1, 2, 3], [4]],
  );
  assert.deepEqual(analysis.unmatchedToolCalls, []);
  assert.deepEqual(analysis.unmatchedToolResults, []);
});

test("chunk builder caps long tool output, preserves errors and provenance, and is deterministic", () => {
  const output = [
    "command output begins",
    ...Array.from({ length: 20 }, () => "unchanged progress line"),
    "TypeError: DistinctivePipelineFailure at src/pipeline.ts:42",
    "tail sentinel after failure",
  ].join("\n");
  const events = [
    event(0, "user_message", "Please diagnose the pipeline failure"),
    event(1, "assistant_message", "I will run the focused check"),
    event(2, "tool_call", "tool: shell\ninput: npm test", "call-2"),
    event(3, "tool_result", output, "call-2"),
    event(4, "assistant_message", "The failure points to the pipeline module"),
  ];
  const policy = {
    scope: { projectId: project, sessionId: session },
    targetTokens: 24,
    maxTokens: 36,
    maxToolOutputCharacters: 180,
    tokenizer: heuristicTokenizer,
  };

  const first = buildChunks(events, policy);
  const replay = buildChunks(events, policy);

  assert.deepEqual(replay, first);
  assert.ok(first.chunks.length >= 2);
  assert.equal(first.chunks.every((chunk) => chunk.tokenCount <= 36), true);
  assert.equal(
    first.chunks.some((chunk) => chunk.displayText.includes("DistinctivePipelineFailure")),
    true,
  );
  assert.equal(
    first.chunks.some((chunk) =>
      chunk.omissions?.some((marker) => marker.reason === "repetitive_output" || marker.reason === "output_limit")
    ),
    true,
  );
  assert.deepEqual(
    new Set(first.eventLinks.map((link) => link.eventId)),
    new Set(events.map((item) => item.id)),
  );
});

test("chunk fingerprints change with text, membership, or processing versions", () => {
  const firstEvent = event(0, "user_message", "first").id;
  const secondEvent = event(1, "assistant_message", "second").id;
  const base = {
    embeddingText: "stable text",
    eventIds: [firstEvent],
    chunkerVersion: "chunker-v1",
    redactionVersion: "redaction-v1",
  };
  const fingerprint = fingerprintChunk(base);

  assert.equal(fingerprintChunk(base), fingerprint);
  assert.notEqual(fingerprintChunk({ ...base, embeddingText: "changed text" }), fingerprint);
  assert.notEqual(fingerprintChunk({ ...base, eventIds: [firstEvent, secondEvent] }), fingerprint);
  assert.notEqual(fingerprintChunk({ ...base, chunkerVersion: "chunker-v2" }), fingerprint);
});
