import type { ScopeAddress } from "../contracts/scope.js";
import { scopeAddress } from "../contracts/scope.js";
import type { SearchBudget, SearchResultStatus } from "../contracts/search.js";
import { SEARCH_SCHEMA_VERSION } from "../contracts/search.js";
import { resolveScope } from "../retrieval/index.js";
import {
  getContextOverview,
  type GetContextOverviewDependencies,
  type GetContextOverviewResult,
} from "./get-overview.js";
import {
  assertFinalBudget,
  collectFreshness,
  effectiveBudget,
  reserveEnvelopeBudget,
} from "./shared.js";

export interface ExportScopeInput {
  readonly scope: ScopeAddress;
  readonly budget?: Partial<SearchBudget>;
}

export interface ExportScopeDependencies extends GetContextOverviewDependencies {
  readonly now?: () => Date;
}

export interface ExportScopeResult {
  readonly format: "context-bridge-pack-v1";
  readonly exportedAt: string;
  readonly status: SearchResultStatus;
  readonly overview: GetContextOverviewResult;
}

/** Creates a bounded, redacted, provenance-linked context pack. */
export async function exportScope(
  input: ExportScopeInput,
  dependencies: ExportScopeDependencies,
): Promise<ExportScopeResult> {
  const budget = effectiveBudget(input.budget, dependencies.budgetLimits);
  const exportedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const resolution = await resolveScope({ explicitScope: input.scope }, dependencies.storage.scopes);
  const freshness = await collectFreshness(dependencies.storage, dependencies.vectorIndex);
  if (resolution.status !== "resolved") {
    const status: SearchResultStatus = resolution.status === "excluded" ? "scope_excluded" : "not_found";
    const overview = emptyExportOverview(status, freshness, input.scope);
    const result = { format: "context-bridge-pack-v1" as const, exportedAt, status, overview };
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  const scope = scopeAddress(resolution.scope);
  const authorization = await dependencies.authorization.authorizeScope(scope, "export_scope");
  if (!authorization.allowed) {
    const status: SearchResultStatus = authorization.reason === "excluded" ? "scope_excluded" : "not_found";
    const overview = emptyExportOverview(status, freshness, scope);
    const result = { format: "context-bridge-pack-v1" as const, exportedAt, status, overview };
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  const childBudget = reserveEnvelopeBudget(
    budget,
    { format: "context-bridge-pack-v1", exportedAt, overview: null },
    dependencies.tokenizer,
    128,
  );
  const overview = await getContextOverview({ scope, budget: childBudget }, {
    ...dependencies,
    budgetLimits: childBudget,
  });
  const result: ExportScopeResult = {
    format: "context-bridge-pack-v1",
    exportedAt,
    status: overview.status,
    overview,
  };
  await assertFinalBudget(result, budget, dependencies.outputPolicy);
  return result;
}

function emptyExportOverview(
  status: SearchResultStatus,
  freshness: GetContextOverviewResult["freshness"],
  scope: ScopeAddress,
): GetContextOverviewResult {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status,
    scope,
    synopses: [],
    decisions: [],
    openItems: [],
    freshness,
    truncation: { truncated: false, limitsReached: [] },
  };
}
