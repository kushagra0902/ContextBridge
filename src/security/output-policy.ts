// This for valdiating and authenticating that the caller actually has the access to the 
// data that is beign sent. 

// Two major parts:
// LocalAuthorizationPolicy: "Even if authenticated, may they read THIS project/scope?"


import { Buffer } from "node:buffer";

import {
  ContextBridgeError,
  ERROR_CODES,
} from "../contracts/errors.js";
import type {
  AccessDecision,
  AuthorizationPolicy,
  OutputPolicy,
  ReadOperation,
  ScopeRepository,
  Tokenizer,
} from "../contracts/ports.js";
import type {
  SearchBudget,
  SearchBudgetLimits,
  SearchScope,
} from "../contracts/search.js";
import { normalizeSearchBudget } from "../contracts/search.js";
import type { ProjectId } from "../contracts/ids.js";
import type { ScopeAddress } from "../contracts/scope.js";
import { redactText, type UserRedactionRule } from "./redact.js";

export interface OutputPolicyOptions {
  readonly limits: SearchBudgetLimits;
  readonly tokenizer?: Tokenizer;
  readonly redactionRules?: readonly UserRedactionRule[];
  readonly redactionPlaceholder?: string;
}

export interface SanitizeMcpOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

/**
 * Central scope gate for every read path. SQLite availability and exclusion
 * records are checked at request time so stale FTS or vector hits cannot
 * bypass a tombstone.
 */
export class LocalAuthorizationPolicy implements AuthorizationPolicy {
  constructor(private readonly scopes: ScopeRepository) {}

  authorizeScope(
    scope: SearchScope,
    _operation: ReadOperation,
  ): Promise<AccessDecision> {
    return this.authorizeAddress(scope);
  }

  authorizeProject(
    projectId: ProjectId,
    _operation: ReadOperation,
  ): Promise<AccessDecision> {
    return this.authorizeAddress({ projectId });
  }

  private async authorizeAddress(
    scope: ScopeAddress,
  ): Promise<AccessDecision> {
    const [exclusion, availability] = await Promise.all([
      this.scopes.getExclusion(scope),
      this.scopes.getAvailability(scope),
    ]);

    if (exclusion !== undefined) {
      return { allowed: false, reason: "excluded" };
    }

    switch (availability) {
      case "selected":
        return { allowed: true };
      case "not_selected":
        return { allowed: false, reason: "not_selected" };
      case "excluded":
      case "deletion_pending":
      case "deleted":
        return { allowed: false, reason: "excluded" };
    }
  }
}

export class DefaultOutputPolicy implements OutputPolicy {
  private readonly limits: SearchBudgetLimits;
  private readonly tokenizer: Tokenizer | undefined;
  private readonly redactionRules: readonly UserRedactionRule[];
  private readonly redactionPlaceholder: string | undefined;

  constructor(options: OutputPolicyOptions) {
    validateBudgetLimits(options.limits);
    this.limits = options.limits;
    this.tokenizer = options.tokenizer;
    this.redactionRules = options.redactionRules ?? [];
    this.redactionPlaceholder = options.redactionPlaceholder;
  }

  async sanitizeText(text: string): Promise<string> {
    const redacted = await redactText(text, this.redactionRules, {
      ...(this.redactionPlaceholder === undefined
        ? {}
        : { placeholder: this.redactionPlaceholder }),
    });
    return redactAbsolutePaths(redacted.text);
  }

  assertWithinBudget(text: string, budget: SearchBudget): void {
    const effective = normalizeSearchBudget(budget, this.limits);
    assertMeasuredBudget(
      {
        items: 1,
        bytes: Buffer.byteLength(text),
        tokens: countTokens(text, this.tokenizer),
      },
      effective,
    );
  }

  async sanitizeResult<T>(
    value: T,
    options: SanitizeMcpOptions = {},
  ): Promise<T> {
    return sanitizeMcpResult(value, this, options);
  }

  assertResultWithinBudget(value: unknown, budget: SearchBudget): void {
    assertMcpResultWithinBudget(value, budget, this.limits, this.tokenizer);
  }

  async prepareResult<T>(
    value: T,
    budget: SearchBudget,
    options: SanitizeMcpOptions = {},
  ): Promise<T> {
    const sanitized = await this.sanitizeResult(value, options);
    this.assertResultWithinBudget(sanitized, budget);
    return sanitized;
  }
}

/** Recursively sanitizes all strings while preserving a JSON-compatible shape. */
export async function sanitizeMcpResult<T>(
  value: T,
  policy: Pick<OutputPolicy, "sanitizeText">,
  options: SanitizeMcpOptions = {},
): Promise<T> {
  const maxDepth = options.maxDepth ?? 32;
  const maxNodes = options.maxNodes ?? 20_000;
  if (
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > 128 ||
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    maxNodes > 1_000_000
  ) {
    throw new RangeError("Invalid MCP sanitization limits");
  }

  const ancestors = new Set<object>();
  let nodes = 0;

  const visit = async (current: unknown, depth: number): Promise<unknown> => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) {
      throw new ContextBridgeError(
        ERROR_CODES.LIMIT_EXCEEDED,
        "MCP result exceeds structural limits",
        { maxDepth, maxNodes },
      );
    }
    if (typeof current === "string") {
      return policy.sanitizeText(current);
    }
    if (current === null || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError("MCP results must contain only finite numbers");
      }
      return current;
    }
    if (Array.isArray(current)) {
      assertNoCycle(current, ancestors);
      ancestors.add(current);
      const result = await Promise.all(
        current.map((item) => visit(item, depth + 1)),
      );
      ancestors.delete(current);
      return result;
    }
    if (isPlainRecord(current)) {
      assertNoCycle(current, ancestors);
      ancestors.add(current);
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(current)) {
        const sanitizedKey = await policy.sanitizeText(key);
        if (Object.hasOwn(result, sanitizedKey)) {
          throw new TypeError("MCP result keys collide after sanitization");
        }
        result[sanitizedKey] = await visit(child, depth + 1);
      }
      ancestors.delete(current);
      return result;
    }
    throw new TypeError("MCP results must contain only JSON-compatible values");
  };

  return (await visit(value, 0)) as T;
}

export function assertMcpResultWithinBudget(
  value: unknown,
  requestedBudget: SearchBudget,
  limits: SearchBudgetLimits,
  tokenizer?: Tokenizer,
): void {
  validateBudgetLimits(limits);
  const budget = normalizeSearchBudget(requestedBudget, limits);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("MCP result must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new TypeError("MCP result must be JSON serializable");
  }

  assertMeasuredBudget(
    {
      items: countResultItems(value),
      bytes: Buffer.byteLength(serialized),
      tokens: countTokens(serialized, tokenizer),
    },
    budget,
  );
}

export function redactAbsolutePaths(text: string): string {
  return text
    .replace(
      /([`"'])(?:file:\/{2,3}|[A-Za-z]:[\\/]|\\\\|\/)[^`"'<>\r\n]+\1/giu,
      "$1[LOCAL_PATH]$1",
    )
    .replace(/\bfile:\/{2,3}[^\s"'<>]+/giu, "[LOCAL_PATH]")
    .replace(/(?:^|(?<=[\s("'=]))[A-Za-z]:[\\/](?:[^\s"'<>|]+[\\/]?)+/gu, "[LOCAL_PATH]")
    .replace(/(?:^|(?<=[\s("'=]))\\\\[^\s\\/"'<>|]+[\\/][^\s"'<>|]+/gu, "[LOCAL_PATH]")
    .replace(/(?:^|(?<=[\s("'=]))\/(?:[^\s\/"'<>|]+\/)*[^\s"'<>|]*/gu, "[LOCAL_PATH]");
}

function assertNoCycle(value: object, ancestors: ReadonlySet<object>): void {
  if (ancestors.has(value)) {
    throw new TypeError("MCP result contains a cycle");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function countResultItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isPlainRecord(value)) {
    for (const key of ["hits", "items", "events", "scopes", "results"] as const) {
      if (Array.isArray(value[key])) {
        return value[key].length;
      }
    }
  }
  return 1;
}

function countTokens(text: string, tokenizer: Tokenizer | undefined): number {
  const count = tokenizer?.count(text) ?? Buffer.byteLength(text);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Tokenizer returned an invalid token count");
  }
  return count;
}

function assertMeasuredBudget(
  measured: { readonly items: number; readonly bytes: number; readonly tokens: number },
  budget: SearchBudget,
): void {
  const exceeded: string[] = [];
  if (measured.items > budget.maxItems) exceeded.push("items");
  if (measured.bytes > budget.maxBytes) exceeded.push("bytes");
  if (measured.tokens > budget.maxTokens) exceeded.push("tokens");
  if (exceeded.length > 0) {
    throw new ContextBridgeError(
      ERROR_CODES.LIMIT_EXCEEDED,
      "Output exceeds the response budget",
      {
        exceeded,
        measured,
        budget,
      },
    );
  }
}

function validateBudgetLimits(limits: SearchBudgetLimits): void {
  normalizeSearchBudget(undefined, limits);
}
