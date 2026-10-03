import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../../../dist/contracts/errors.js";
import { projectId } from "../../../dist/contracts/ids.js";
import {
  DefaultOutputPolicy,
  LocalAuthorizationPolicy,
  assertMcpResultWithinBudget,
  sanitizeMcpResult,
} from "../../../dist/security/output-policy.js";

const PROJECT_ID = projectId(["output-policy"]);
const LIMITS = { maxItems: 4, maxBytes: 2_048, maxTokens: 1_024 };
const TOKENIZER = {
  count: (text) => Math.ceil(text.length / 4),
  truncate: (text, maxTokens) => text.slice(0, maxTokens * 4),
};

test("authorization checks current selection and tombstones for every read", async () => {
  let availability = "selected";
  let exclusion;
  const repository = {
    getAvailability: async () => availability,
    getExclusion: async () => exclusion,
  };
  const policy = new LocalAuthorizationPolicy(repository);

  assert.deepEqual(
    await policy.authorizeProject(PROJECT_ID, "get_overview"),
    { allowed: true },
  );

  availability = "not_selected";
  assert.deepEqual(
    await policy.authorizeScope({ projectId: PROJECT_ID }, "search_memory"),
    { allowed: false, reason: "not_selected" },
  );

  availability = "selected";
  exclusion = { status: "deletion_pending" };
  assert.deepEqual(
    await policy.authorizeScope({ projectId: PROJECT_ID }, "get_evidence"),
    { allowed: false, reason: "excluded" },
  );

  exclusion = undefined;
  availability = "deleted";
  assert.deepEqual(
    await policy.authorizeScope({ projectId: PROJECT_ID }, "export_scope"),
    { allowed: false, reason: "excluded" },
  );
});

test("output policy strips secrets and absolute local paths recursively", async () => {
  const secret = `sk-${"z".repeat(32)}`;
  const policy = new DefaultOutputPolicy({ limits: LIMITS, tokenizer: TOKENIZER });
  const input = {
    message: `Read /home/alice/private/config.toml with ${secret}`,
    hits: [
      { snippet: "Windows path C:\\Users\\alice\\secret.txt" },
      { snippet: "Quoted path '/Users/alice/My Project/secrets.txt'" },
      { snippet: "Keep a relative path src/index.ts" },
    ],
  };

  const output = await policy.prepareResult(input, LIMITS);
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("/home/alice"), false);
  assert.equal(serialized.includes("My Project"), false);
  assert.equal(serialized.includes("C:\\\\Users"), false);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.match(serialized, /\[LOCAL_PATH\]/u);
  assert.match(serialized, /src\/index\.ts/u);
});

test("MCP output enforces item, byte, and token ceilings", () => {
  assert.throws(
    () =>
      assertMcpResultWithinBudget(
        { hits: [{}, {}, {}] },
        { maxItems: 2, maxBytes: 2_048, maxTokens: 1_024 },
        LIMITS,
        TOKENIZER,
      ),
    (error) =>
      error.code === ERROR_CODES.LIMIT_EXCEEDED &&
      error.details.exceeded.includes("items"),
  );

  assert.throws(
    () =>
      assertMcpResultWithinBudget(
        { value: "a".repeat(500) },
        { maxItems: 1, maxBytes: 100, maxTokens: 10 },
        LIMITS,
        TOKENIZER,
      ),
    (error) =>
      error.code === ERROR_CODES.LIMIT_EXCEEDED &&
      error.details.exceeded.includes("bytes") &&
      error.details.exceeded.includes("tokens"),
  );
});

test("MCP sanitization rejects cycles and non-JSON values", async () => {
  const policy = { sanitizeText: async (text) => text };
  const cyclic = {};
  cyclic.self = cyclic;

  await assert.rejects(sanitizeMcpResult(cyclic, policy), /cycle/u);
  await assert.rejects(
    sanitizeMcpResult({ value: new Date() }, policy),
    /JSON-compatible/u,
  );
  await assert.rejects(
    sanitizeMcpResult({ value: Number.NaN }, policy),
    /finite numbers/u,
  );
});
