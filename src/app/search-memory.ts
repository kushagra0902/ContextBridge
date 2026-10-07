import type {
  SemanticRetrievalDependencies,
  SemanticRetrievalResult,
} from "../retrieval/index.js";
import {
  classifyQuery,
  diversifyHits,
  fuseCandidates,
  orderByChronology,
  packSearchHits,
  resolveScope,
  retrieveLexical,
  retrieveSemantic,
  validateHits,
} from "../retrieval/index.js";
import type {
  SearchBudget,
  SearchCursor,
  SearchFilters,
  SearchIntent,
  SearchResult,
  SearchResultStatus,
} from "../contracts/search.js";
import {
  SEARCH_SCHEMA_VERSION,
  isExactSearchIntent,
} from "../contracts/search.js";
import { scopeAddress } from "../contracts/scope.js";
import type { ScopeAddress } from "../contracts/scope.js";
import {
  assertFinalBudget,
  collectFreshness,
  effectiveBudget,
  reserveEnvelopeBudget,
  type AppReadDependencies,
} from "./shared.js";

export interface SearchMemoryInput {
  readonly query: string;
  readonly intent?: SearchIntent;
  readonly scopeQuery?: string;
  readonly filters?: SearchFilters;
  readonly budget?: Partial<SearchBudget>;
  readonly cursor?: SearchCursor;
}

export interface AmbiguousSearchScope {
  readonly scope: ScopeAddress;
  readonly kind: "project" | "workstream" | "session";
  readonly label: string;
  readonly score: number;
}

export interface SearchMemoryResult extends SearchResult {
  readonly intent: SearchIntent;
  readonly scopeCandidates?: readonly [
    AmbiguousSearchScope,
    AmbiguousSearchScope,
    ...AmbiguousSearchScope[],
  ];
}

export interface SearchMemoryDependencies extends AppReadDependencies {
  readonly cursorSecret: string;
  readonly candidateLimitPerChannel?: number;
  readonly semantic?: SemanticRetrievalDependencies;
}

export async function searchMemory(
  input: SearchMemoryInput,
  dependencies: SearchMemoryDependencies,
): Promise<SearchMemoryResult> {
  const intent = input.intent ?? classifyQuery(input.query);
  const budget = effectiveBudget(input.budget, dependencies.budgetLimits);
  const vectorIndex = dependencies.semantic?.vectorIndex ?? dependencies.vectorIndex;
  const freshness = await collectFreshness(dependencies.storage, vectorIndex);
  const resolution = await resolveScope({
    ...(input.scopeQuery === undefined ? {} : { query: input.scopeQuery }),
    ...(input.filters?.scope === undefined ? {} : { explicitScope: input.filters.scope }),
  }, dependencies.storage.scopes);

  if (resolution.status === "ambiguous") {
    const candidates = await Promise.all(resolution.candidates.map(async (candidate) => ({
      scope: scopeAddress(candidate.scope),
      kind: candidate.scope.kind,
      label: await dependencies.outputPolicy.sanitizeText(scopeLabel(candidate.scope)),
      score: candidate.score,
    })));
    const result: SearchMemoryResult = {
      schemaVersion: SEARCH_SCHEMA_VERSION,
      status: "ambiguous_scope",
      intent,
      hits: [],
      freshness,
      semanticStatus: "not_applicable",
      truncation: { truncated: false, limitsReached: [] },
      scopeCandidates: candidates as [AmbiguousSearchScope, AmbiguousSearchScope, ...AmbiguousSearchScope[]],
    };
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  if (resolution.status === "excluded") {
    const result = emptyResult("scope_excluded", intent, freshness, "not_applicable", scopeAddress(resolution.scope));
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  if (resolution.status === "not_found") {
    const result = emptyResult(
      input.filters?.scope === undefined && freshness.sourceLastSeenAt === undefined
        ? "no_source"
        : "not_found",
      intent,
      freshness,
      "not_applicable",
    );
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }

  const scope = scopeAddress(resolution.scope);
  const authorization = await dependencies.authorization.authorizeScope(scope, "search_memory");
  if (!authorization.allowed) {
    const result = emptyResult(
      authorization.reason === "excluded" ? "scope_excluded" : "not_found",
      intent,
      freshness,
      "not_applicable",
      scope,
    );
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }

  const filters = withoutScope(input.filters);
  const candidateLimit = boundedCandidateLimit(dependencies.candidateLimitPerChannel ?? 50);
  const lexicalPromise = retrieveLexical({
    query: input.query,
    intent,
    scope,
    filters,
    limit: candidateLimit,
  }, {
    lexicalSearch: dependencies.storage.lexicalSearch,
    memories: dependencies.storage.memories,
    evidence: dependencies.storage.evidence,
  });
  const semanticPromise: Promise<SemanticRetrievalResult> = isExactSearchIntent(intent)
    ? Promise.resolve({ status: "not_applicable" as const, candidates: [] })
    : retrieveSemantic({
        query: input.query,
        scope,
        filters,
        limit: candidateLimit,
      }, dependencies.semantic ?? {});
  const [lexical, semantic] = await Promise.all([lexicalPromise, semanticPromise]);
  const fused = fuseCandidates([lexical, semantic.candidates], {
    intent,
    explicitScope: input.filters?.scope !== undefined,
    limit: candidateLimit * 2,
  });
  const hydrated = await validateHits({
    candidates: fused,
    scope,
    filters,
    ...(semantic.spaceId === undefined ? {} : { semanticSpaceId: semantic.spaceId }),
  }, {
    evidence: dependencies.storage.evidence,
    memories: dependencies.storage.memories,
    embeddingJobs: dependencies.storage.embeddingJobs,
    scopes: dependencies.storage.scopes,
  });
  const ordered = diversifyHits(orderByChronology(hydrated, intent), candidateLimit);
  const sourceAbsent = freshness.sourceLastSeenAt === undefined;
  const provisionalStatus = resultStatus(ordered.length, semantic.status, freshness.stale, false, sourceAbsent);
  const envelope = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status: provisionalStatus,
    intent,
    scope,
    hits: [],
    freshness,
    semanticStatus: semantic.status,
    truncation: { truncated: false, limitsReached: [] },
  };
  const hitBudget = reserveEnvelopeBudget(budget, envelope, dependencies.tokenizer);
  const packed = await packSearchHits(ordered, {
    budget: hitBudget,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    cursorSecret: dependencies.cursorSecret,
    contextKey: JSON.stringify({ query: input.query, intent, scope, filters, freshness }),
    outputPolicy: dependencies.outputPolicy,
    ...(dependencies.tokenizer === undefined ? {} : { tokenizer: dependencies.tokenizer }),
  });
  const status = resultStatus(
    packed.hits.length,
    semantic.status,
    freshness.stale,
    packed.truncation.truncated,
    sourceAbsent,
  );
  const result: SearchMemoryResult = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status,
    intent,
    scope,
    hits: packed.hits,
    freshness,
    semanticStatus: semantic.status,
    truncation: packed.truncation,
    ...(packed.continuation === undefined ? {} : { continuation: packed.continuation }),
  };
  await assertFinalBudget(result, budget, dependencies.outputPolicy);
  return result;
}

function emptyResult(
  status: SearchResultStatus,
  intent: SearchIntent,
  freshness: SearchResult["freshness"],
  semanticStatus: SearchResult["semanticStatus"],
  scope?: ScopeAddress,
): SearchMemoryResult {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status,
    intent,
    ...(scope === undefined ? {} : { scope }),
    hits: [],
    freshness,
    semanticStatus,
    truncation: { truncated: false, limitsReached: [] },
  };
}

function resultStatus(
  hitCount: number,
  semanticStatus: SearchResult["semanticStatus"],
  stale: boolean,
  truncated: boolean,
  sourceAbsent: boolean,
): SearchResultStatus {
  if (hitCount === 0) {
    if (sourceAbsent) return "no_source";
    if (stale) return "stale_index";
    if (semanticStatus === "indexing") return "indexing";
    return "empty";
  }
  if (truncated || stale || semanticStatus === "indexing" || semanticStatus === "unavailable") return "partial";
  return "ok";
}

function withoutScope(filters: SearchFilters | undefined): Omit<SearchFilters, "scope"> {
  if (filters === undefined) return {};
  const { scope: _scope, ...remaining } = filters;
  return remaining;
}

function scopeLabel(scope: Parameters<typeof scopeAddress>[0]): string {
  if (scope.kind === "project" || scope.kind === "workstream") return scope.displayName;
  return scope.title ?? scope.id;
}

function boundedCandidateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new RangeError("Candidate limit must be from 1 to 200");
  }
  return value;
}
