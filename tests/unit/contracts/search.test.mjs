import assert from "node:assert/strict";
import test from "node:test";

import {
  isExactSearchIntent,
  normalizeSearchBudget,
  parseSearchCursor,
} from "../../../dist/contracts/search.js";

const limits = {
  minItems: 1,
  maxItems: 20,
  minBytes: 128,
  maxBytes: 32_000,
  minTokens: 64,
  maxTokens: 6_000,
};

test("normalizeSearchBudget defaults and clamps all public limits", () => {
  assert.deepEqual(normalizeSearchBudget(undefined, limits), {
    maxItems: 20,
    maxBytes: 32_000,
    maxTokens: 6_000,
  });

  assert.deepEqual(
    normalizeSearchBudget(
      { maxItems: 999, maxBytes: -1, maxTokens: 500.9 },
      limits,
    ),
    { maxItems: 20, maxBytes: 128, maxTokens: 500 },
  );
});

test("normalizeSearchBudget rejects contradictory server limits", () => {
  assert.throws(
    () => normalizeSearchBudget(undefined, { ...limits, minItems: 21 }),
    /invalid search budget limits/i,
  );
});

test("search cursors are non-empty, bounded, and free of control characters", () => {
  assert.equal(parseSearchCursor("v1.opaque-cursor"), "v1.opaque-cursor");
  assert.throws(() => parseSearchCursor("   "), /invalid search cursor/i);
  assert.throws(() => parseSearchCursor("cursor\nnext"), /invalid search cursor/i);
});

test("exact lookup intents can bypass semantic retrieval", () => {
  assert.equal(isExactSearchIntent("exact_identifier"), true);
  assert.equal(isExactSearchIntent("exact_error"), true);
  assert.equal(isExactSearchIntent("decision_rationale"), false);
});
