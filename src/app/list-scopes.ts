import type { ScopeRef } from "../contracts/scope.js";
import { scopeAddress } from "../contracts/scope.js";
import type { SearchBudget, SearchTruncation } from "../contracts/search.js";
import {
  assertFinalBudget,
  boundJsonItems,
  effectiveBudget,
  type AppReadDependencies,
} from "./shared.js";

export interface ListContextScopesInput {
  readonly query?: string;
  readonly limit?: number;
  readonly budget?: Partial<SearchBudget>;
}

export interface ContextScopeSummary {
  readonly scope: ScopeRef;
  readonly matchedBy: "explicit_id" | "explicit_mapping" | "alias" | "project_identity" | "metadata" | "name";
  readonly score: number;
  readonly aliases: readonly string[];
}

export interface ListContextScopesResult {
  readonly status: "ok" | "empty";
  readonly scopes: readonly ContextScopeSummary[];
  readonly ambiguous: boolean;
  readonly truncation: SearchTruncation;
}

export async function listContextScopes(
  input: ListContextScopesInput,
  dependencies: AppReadDependencies,
): Promise<ListContextScopesResult> {
  const limit = boundedLimit(input.limit ?? 20);
  const budget = effectiveBudget(input.budget, dependencies.budgetLimits);
  const candidates = await dependencies.storage.scopes.listCandidates(input.query, limit + 1);
  const allowed: ContextScopeSummary[] = [];
  for (const candidate of candidates) {
    if (candidate.availability !== "selected") continue;
    const address = scopeAddress(candidate.scope);
    const decision = await dependencies.authorization.authorizeScope(address, "list_scopes");
    if (!decision.allowed) continue;
    allowed.push({
      scope: await sanitizeScope(candidate.scope, dependencies),
      matchedBy: candidate.matchedBy,
      score: candidate.score,
      aliases: await Promise.all(candidate.aliases.map((alias) => dependencies.outputPolicy.sanitizeText(alias))),
    });
  }
  const top = allowed[0];
  const second = allowed[1];
  const ambiguous = top !== undefined && second !== undefined && top.score - second.score <= 0.05;
  const bounded = boundJsonItems(
    allowed.slice(0, limit),
    budget,
    dependencies.tokenizer,
    (scopes, truncation) => ({ status: scopes.length === 0 ? "empty" : "ok", scopes, ambiguous, truncation }),
  );
  const result: ListContextScopesResult = {
    status: bounded.items.length === 0 ? "empty" : "ok",
    scopes: bounded.items,
    ambiguous,
    truncation: {
      truncated: bounded.truncation.truncated || allowed.length > limit,
      limitsReached: allowed.length > limit && !bounded.truncation.limitsReached.includes("items")
        ? [...bounded.truncation.limitsReached, "items"]
        : bounded.truncation.limitsReached,
    },
  };
  await assertFinalBudget(result, budget, dependencies.outputPolicy);
  return result;
}

async function sanitizeScope(
  scope: ScopeRef,
  dependencies: AppReadDependencies,
): Promise<ScopeRef> {
  if (scope.kind === "project") {
    return {
      ...scope,
      displayName: await dependencies.outputPolicy.sanitizeText(scope.displayName),
      ...(scope.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: await dependencies.outputPolicy.sanitizeText(scope.lastActivityAt) }),
    };
  }
  if (scope.kind === "workstream") {
    return {
      ...scope,
      displayName: await dependencies.outputPolicy.sanitizeText(scope.displayName),
      ...(scope.branch === undefined ? {} : { branch: await dependencies.outputPolicy.sanitizeText(scope.branch) }),
      ...(scope.issueId === undefined ? {} : { issueId: await dependencies.outputPolicy.sanitizeText(scope.issueId) }),
      ...(scope.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: await dependencies.outputPolicy.sanitizeText(scope.lastActivityAt) }),
    };
  }
  return {
    ...scope,
    ...(scope.title === undefined ? {} : { title: await dependencies.outputPolicy.sanitizeText(scope.title) }),
    ...(scope.branch === undefined ? {} : { branch: await dependencies.outputPolicy.sanitizeText(scope.branch) }),
    ...(scope.headCommit === undefined ? {} : { headCommit: await dependencies.outputPolicy.sanitizeText(scope.headCommit) }),
    ...(scope.startedAt === undefined ? {} : { startedAt: await dependencies.outputPolicy.sanitizeText(scope.startedAt) }),
    ...(scope.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: await dependencies.outputPolicy.sanitizeText(scope.lastActivityAt) }),
  };
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new RangeError("Scope list limit must be from 1 to 20");
  }
  return value;
}
