import type {
  MemoryDerivation,
  MemoryEvidenceId,
  MemoryRecord,
  MemoryStatus,
  MemoryType,
} from "../contracts/memory.js";
import { collectMemoryEvidenceIds } from "../contracts/memory.js";
import type { ScopeAddress } from "../contracts/scope.js";
import { scopeAddress, scopeContains } from "../contracts/scope.js";
import type {
  CurrentnessStatus,
  SearchBudget,
  SearchHit,
  SearchResultStatus,
  SearchTruncation,
} from "../contracts/search.js";
import { SEARCH_SCHEMA_VERSION } from "../contracts/search.js";
import { packSearchHits, resolveScope } from "../retrieval/index.js";
import {
  assertFinalBudget,
  collectFreshness,
  effectiveBudget,
  reserveEnvelopeBudget,
  type AppReadDependencies,
} from "./shared.js";

const OVERVIEW_TYPES: readonly MemoryType[] = [
  "session_synopsis",
  "workstream_synopsis",
  "project_synopsis",
  "decision",
  "open_item",
];

export interface GetContextOverviewInput {
  readonly scope: ScopeAddress;
  readonly budget?: Partial<SearchBudget>;
}

export interface ContextOverviewItem {
  readonly id: MemoryRecord["id"];
  readonly type: MemoryType;
  readonly title: string;
  readonly summary: string;
  readonly status: MemoryStatus;
  readonly derivation: MemoryDerivation;
  readonly evidenceIds: readonly MemoryEvidenceId[];
  readonly observedFrom?: string;
  readonly observedTo?: string;
  readonly currentness: CurrentnessStatus;
}

export interface GetContextOverviewResult {
  readonly schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  readonly status: SearchResultStatus;
  readonly scope?: ScopeAddress;
  readonly synopses: readonly ContextOverviewItem[];
  readonly decisions: readonly ContextOverviewItem[];
  readonly openItems: readonly ContextOverviewItem[];
  readonly freshness: Awaited<ReturnType<typeof collectFreshness>>;
  readonly truncation: SearchTruncation;
}

export interface GetContextOverviewDependencies extends AppReadDependencies {
  readonly cursorSecret: string;
}

export async function getContextOverview(
  input: GetContextOverviewInput,
  dependencies: GetContextOverviewDependencies,
): Promise<GetContextOverviewResult> {
  const budget = effectiveBudget(input.budget, dependencies.budgetLimits);
  const freshness = await collectFreshness(dependencies.storage, dependencies.vectorIndex);
  const resolution = await resolveScope({ explicitScope: input.scope }, dependencies.storage.scopes);
  if (resolution.status !== "resolved") {
    const status: SearchResultStatus = resolution.status === "excluded" ? "scope_excluded" : "not_found";
    const result = emptyOverview(status, freshness, input.scope);
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  const scope = scopeAddress(resolution.scope);
  const authorization = await dependencies.authorization.authorizeScope(scope, "get_overview");
  if (!authorization.allowed) {
    const result = emptyOverview(
      authorization.reason === "excluded" ? "scope_excluded" : "not_found",
      freshness,
      scope,
    );
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }

  const memories = (await dependencies.storage.memories.findByScope(scope, OVERVIEW_TYPES))
    .filter((memory) => memoryScopeInside(memory, scope))
    .sort(compareOverviewMemory);
  const hits = memories.map<SearchHit>((memory, index) => ({
    entity: { kind: "memory", id: memory.id },
    type: memory.type,
    scope: memoryScope(memory)!,
    title: memory.title,
    snippet: memory.body,
    matches: [{ channel: "structured", rank: index + 1 }],
    evidenceIds: collectMemoryEvidenceIds(memory),
    ...(memory.observedTo ?? memory.observedFrom ?? memory.updatedAt) === undefined
      ? {}
      : { observedAt: memory.observedTo ?? memory.observedFrom ?? memory.updatedAt },
    currentness: currentnessOf(memory),
    fusedScore: 1 / (index + 1),
  }));
  const envelope = emptyOverview("ok", freshness, scope);
  const itemBudget = reserveEnvelopeBudget(budget, envelope, dependencies.tokenizer);
  const packed = await packSearchHits(hits, {
    budget: itemBudget,
    cursorSecret: dependencies.cursorSecret,
    contextKey: JSON.stringify({ operation: "overview", scope, freshness }),
    outputPolicy: dependencies.outputPolicy,
    ...(dependencies.tokenizer === undefined ? {} : { tokenizer: dependencies.tokenizer }),
  });
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const items = packed.hits.flatMap((hit) => {
    if (hit.entity.kind !== "memory") return [];
    const memory = byId.get(hit.entity.id);
    if (memory === undefined) return [];
    return [{
      id: memory.id,
      type: memory.type,
      title: hit.title ?? "",
      summary: hit.snippet,
      status: memory.status,
      derivation: memory.derivation,
      evidenceIds: hit.evidenceIds,
      ...(memory.observedFrom === undefined ? {} : { observedFrom: memory.observedFrom }),
      ...(memory.observedTo === undefined ? {} : { observedTo: memory.observedTo }),
      currentness: hit.currentness,
    } satisfies ContextOverviewItem];
  });
  const sourceAbsent = freshness.sourceLastSeenAt === undefined;
  const status: SearchResultStatus = items.length === 0
    ? (sourceAbsent ? "no_source" : freshness.stale ? "stale_index" : "empty")
    : (packed.truncation.truncated || freshness.stale ? "partial" : "ok");
  const result: GetContextOverviewResult = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status,
    scope,
    synopses: items.filter((item) => item.type.endsWith("_synopsis")),
    decisions: items.filter((item) => item.type === "decision"),
    openItems: items.filter((item) => item.type === "open_item"),
    freshness,
    truncation: packed.truncation,
  };
  await assertFinalBudget(result, budget, dependencies.outputPolicy);
  return result;
}

function emptyOverview(
  status: SearchResultStatus,
  freshness: Awaited<ReturnType<typeof collectFreshness>>,
  scope?: ScopeAddress,
): GetContextOverviewResult {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status,
    ...(scope === undefined ? {} : { scope }),
    synopses: [],
    decisions: [],
    openItems: [],
    freshness,
    truncation: { truncated: false, limitsReached: [] },
  };
}

function memoryScope(memory: MemoryRecord): ScopeAddress | undefined {
  return memory.scope.projectId === undefined ? undefined : {
    projectId: memory.scope.projectId,
    ...(memory.scope.workstreamId === undefined ? {} : { workstreamId: memory.scope.workstreamId }),
    ...(memory.scope.sessionId === undefined ? {} : { sessionId: memory.scope.sessionId }),
  };
}

function memoryScopeInside(memory: MemoryRecord, boundary: ScopeAddress): boolean {
  const scope = memoryScope(memory);
  return scope !== undefined && scopeContains(boundary, scope);
}

function currentnessOf(memory: MemoryRecord): CurrentnessStatus {
  return memory.status === "superseded" ? "superseded" : "historical_unverified";
}

function compareOverviewMemory(left: MemoryRecord, right: MemoryRecord): number {
  const type = overviewRank(left.type) - overviewRank(right.type);
  if (type !== 0) return type;
  if (left.type === "decision" || left.type === "open_item") {
    const terminal = Number(isHistorical(left)) - Number(isHistorical(right));
    if (terminal !== 0) return terminal;
  }
  return (right.observedTo ?? right.observedFrom ?? right.updatedAt)
    .localeCompare(left.observedTo ?? left.observedFrom ?? left.updatedAt) || left.id.localeCompare(right.id);
}

function overviewRank(type: MemoryType): number {
  if (type.endsWith("_synopsis")) return 0;
  if (type === "decision") return 1;
  if (type === "open_item") return 2;
  return 3;
}

function isHistorical(memory: MemoryRecord): boolean {
  return memory.status === "superseded" || memory.status === "resolved" || memory.status === "dismissed";
}
