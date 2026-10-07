import type { EventId, ChunkId } from "../contracts/ids.js";
import { isStableId } from "../contracts/ids.js";
import type { ScopeAddress } from "../contracts/scope.js";
import { scopeAddress } from "../contracts/scope.js";
import type { SearchBudget } from "../contracts/search.js";
import { SEARCH_SCHEMA_VERSION } from "../contracts/search.js";
import {
  expandEvidence,
  resolveScope,
  type ExpandedEvidenceResult,
} from "../retrieval/index.js";
import {
  assertFinalBudget,
  effectiveBudget,
  reserveEnvelopeBudget,
  type AppReadDependencies,
} from "./shared.js";

export interface GetEvidenceInput {
  readonly evidenceIds: readonly (EventId | ChunkId)[];
  readonly scope?: ScopeAddress;
  readonly beforeEvents?: number;
  readonly afterEvents?: number;
  readonly budget?: Partial<SearchBudget>;
}

export interface GetEvidenceResult extends ExpandedEvidenceResult {
  readonly schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  readonly status: "ok" | "partial" | "not_found" | "ambiguous_scope" | "scope_excluded";
  readonly scope?: ScopeAddress;
}

export async function getEvidence(
  input: GetEvidenceInput,
  dependencies: AppReadDependencies,
): Promise<GetEvidenceResult> {
  if (input.evidenceIds.length < 1 || input.evidenceIds.length > 5) {
    throw new RangeError("getEvidence accepts from 1 to 5 evidence IDs");
  }
  for (const id of input.evidenceIds) {
    if (!isStableId(id, "event") && !isStableId(id, "chunk")) throw new TypeError("Invalid evidence ID");
  }
  const budget = effectiveBudget(input.budget, dependencies.budgetLimits);
  const scope = input.scope ?? await inferEvidenceScope(input.evidenceIds, dependencies);
  if (scope === undefined) {
    const result = emptyEvidence("not_found");
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  if (scope === "ambiguous") {
    const result = emptyEvidence("ambiguous_scope");
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  const resolution = await resolveScope({ explicitScope: scope }, dependencies.storage.scopes);
  if (resolution.status !== "resolved") {
    const result = emptyEvidence(resolution.status === "excluded" ? "scope_excluded" : "not_found", scope);
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  const resolved = scopeAddress(resolution.scope);
  const authorization = await dependencies.authorization.authorizeScope(resolved, "get_evidence");
  if (!authorization.allowed) {
    const result = emptyEvidence(authorization.reason === "excluded" ? "scope_excluded" : "not_found", resolved);
    await assertFinalBudget(result, budget, dependencies.outputPolicy);
    return result;
  }
  const envelope = emptyEvidence("ok", resolved);
  const evidenceBudget = reserveEnvelopeBudget(budget, envelope, dependencies.tokenizer, 256);
  const expanded = await expandEvidence({
    evidenceIds: input.evidenceIds,
    beforeEvents: boundedNeighbors(input.beforeEvents ?? 2),
    afterEvents: boundedNeighbors(input.afterEvents ?? 2),
    budget: evidenceBudget,
  }, {
    evidence: dependencies.storage.evidence,
    scopes: dependencies.storage.scopes,
    outputPolicy: dependencies.outputPolicy,
    ...(dependencies.tokenizer === undefined ? {} : { tokenizer: dependencies.tokenizer }),
  }, { scope: resolved });
  const status = expanded.chunks.length === 0 && expanded.events.length === 0
    ? "not_found"
    : expanded.truncation.truncated || expanded.unavailableEvidenceIds.length > 0
      ? "partial"
      : "ok";
  const result: GetEvidenceResult = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status,
    scope: resolved,
    ...expanded,
  };
  await assertFinalBudget(result, budget, dependencies.outputPolicy);
  return result;
}

async function inferEvidenceScope(
  ids: readonly (EventId | ChunkId)[],
  dependencies: AppReadDependencies,
): Promise<ScopeAddress | "ambiguous" | undefined> {
  const chunkIds = ids.filter((id): id is ChunkId => isStableId(id, "chunk"));
  const eventIds = ids.filter((id): id is EventId => isStableId(id, "event"));
  const [chunks, events] = await Promise.all([
    dependencies.storage.evidence.getChunks(chunkIds),
    dependencies.storage.evidence.getEvents(eventIds),
  ]);
  const projects = new Set<string>();
  for (const chunk of chunks) if (chunk.scope.projectId !== undefined) projects.add(chunk.scope.projectId);
  for (const event of events) {
    const session = await dependencies.storage.scopes.getSession(event.sessionId);
    if (session !== undefined) projects.add(session.projectId);
  }
  if (projects.size === 0) return undefined;
  if (projects.size > 1) return "ambiguous";
  return { projectId: [...projects][0] as ScopeAddress["projectId"] };
}

function emptyEvidence(
  status: GetEvidenceResult["status"],
  scope?: ScopeAddress,
): GetEvidenceResult {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    status,
    ...(scope === undefined ? {} : { scope }),
    chunks: [],
    events: [],
    unavailableEvidenceIds: [],
    truncation: { truncated: false, limitsReached: [] },
  };
}

function boundedNeighbors(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 20) {
    throw new RangeError("Evidence neighbors must be from 0 to 20");
  }
  return value;
}
