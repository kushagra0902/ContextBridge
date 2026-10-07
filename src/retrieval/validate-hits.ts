import { createHash } from "node:crypto";

import type { EmbeddingRecord } from "../contracts/embedding.js";
import type { EvidenceChunk } from "../contracts/evidence.js";
import type { MemoryRecord } from "../contracts/memory.js";
import { collectMemoryEvidenceIds } from "../contracts/memory.js";
import type {
  EmbeddingJobRepository,
  EvidenceRepository,
  MemoryRepository,
  ScopeRepository,
} from "../contracts/ports.js";
import type {
  SearchFilters,
  SearchHit,
  SearchScope,
} from "../contracts/search.js";
import { scopeContains } from "../contracts/scope.js";
import type { FusedCandidate } from "./fuse.js";
import type { SemanticCandidate } from "./semantic.js";

export interface HitValidationDependencies {
  readonly evidence: EvidenceRepository;
  readonly memories: MemoryRepository;
  readonly embeddingJobs?: EmbeddingJobRepository;
  readonly scopes?: ScopeRepository;
}

export interface HitValidationInput {
  readonly candidates: readonly FusedCandidate[];
  readonly scope: SearchScope;
  readonly filters?: Omit<SearchFilters, "scope">;
  readonly semanticSpaceId?: string;
}

/** Re-hydrates candidates from SQLite and drops stale, missing, or foreign rows. */
export async function validateHits(
  input: HitValidationInput,
  dependencies: HitValidationDependencies,
): Promise<readonly SearchHit[]> {
  if (input.candidates.length > 1_000) throw new RangeError("At most 1000 candidates can be validated");
  const chunkIds = input.candidates.flatMap((candidate) => candidate.entity.kind === "chunk" ? [candidate.entity.id] : []);
  const memoryIds = input.candidates.flatMap((candidate) => candidate.entity.kind === "memory" ? [candidate.entity.id] : []);
  const [chunks, memories] = await Promise.all([
    dependencies.evidence.getChunks(chunkIds),
    dependencies.memories.get(memoryIds),
  ]);
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const ledger = await semanticLedger(input, dependencies);
  const hits: SearchHit[] = [];

  for (const fused of input.candidates) {
    if (fused.entity.kind === "chunk") {
      const chunk = chunkById.get(fused.entity.id);
      if (chunk === undefined) continue;
      const scope = chunkScope(chunk);
      if (
        scope === undefined ||
        !scopeContains(input.scope, scope) ||
        !passesTime(chunk.observedTo ?? chunk.observedFrom, input.filters) ||
        !passesPaths(`${chunk.displayText}\n${chunk.embeddingText}`, input.filters) ||
        !(await passesBranch(scope, input.filters, dependencies.scopes))
      ) continue;
      if ((input.filters?.memoryTypes?.length ?? 0) > 0) continue;
      const valid = validSources(fused, chunk.fingerprint, scope, input.scope, ledger, input.semanticSpaceId);
      if (valid.length === 0) continue;
      hits.push({
        entity: fused.entity,
        type: "chunk",
        scope,
        snippet: chunk.displayText,
        matches: matchesOf(valid),
        evidenceIds: chunk.eventIds,
        ...(chunk.observedTo ?? chunk.observedFrom) === undefined ? {} : { observedAt: chunk.observedTo ?? chunk.observedFrom },
        currentness: (chunk.observedTo ?? chunk.observedFrom) === undefined ? "unknown_currentness" : "historical_unverified",
        fusedScore: validatedScore(fused, valid),
      });
      continue;
    }

    const memory = memoryById.get(fused.entity.id);
    if (memory === undefined) continue;
    const scope = memoryScope(memory);
    const observedAt = memory.observedTo ?? memory.observedFrom ?? memory.updatedAt;
    if (
      scope === undefined ||
      !scopeContains(input.scope, scope) ||
      !passesTime(observedAt, input.filters) ||
      !passesPaths(`${memory.title}\n${memory.body}`, input.filters) ||
      !(await passesBranch(scope, input.filters, dependencies.scopes))
    ) continue;
    if (input.filters?.memoryTypes !== undefined && !input.filters.memoryTypes.includes(memory.type)) continue;
    const valid = validSources(fused, memoryFingerprint(memory), scope, input.scope, ledger, input.semanticSpaceId);
    if (valid.length === 0) continue;
    hits.push({
      entity: fused.entity,
      type: memory.type,
      scope,
      title: memory.title,
      snippet: memory.body,
      matches: matchesOf(valid),
      evidenceIds: collectMemoryEvidenceIds(memory),
      observedAt,
      currentness: memory.status === "superseded" ? "superseded" : "historical_unverified",
      fusedScore: validatedScore(fused, valid),
    });
  }
  return hits.sort((left, right) => right.fusedScore - left.fusedScore || left.entity.id.localeCompare(right.entity.id));
}

function validSources(
  fused: FusedCandidate,
  fingerprint: string,
  hydratedScope: SearchScope,
  requestedScope: SearchScope,
  ledger: ReadonlyMap<string, EmbeddingRecord>,
  semanticSpaceId: string | undefined,
) {
  return fused.candidates.flatMap((candidate, index) => {
    if (!scopeContains(requestedScope, candidate.scope) || !scopeContains(candidate.scope, hydratedScope)) return [];
    let valid = candidate.channel !== "semantic";
    if (candidate.channel === "semantic") {
      if (semanticSpaceId === undefined || !isSemanticCandidate(candidate) || candidate.spaceId !== semanticSpaceId) return [];
      const record = ledger.get(entityKey(candidate));
      valid = record !== undefined && candidate.fingerprint !== undefined &&
        record.spaceId === semanticSpaceId && record.fingerprint === candidate.fingerprint &&
        record.vectorId === candidate.vectorId;
    } else if (candidate.fingerprint !== undefined && candidate.fingerprint !== fingerprint) {
      valid = false;
    }
    return valid ? [{ candidate, contribution: fused.contributions[index] ?? 0 }] : [];
  });
}

async function semanticLedger(
  input: HitValidationInput,
  dependencies: HitValidationDependencies,
): Promise<ReadonlyMap<string, EmbeddingRecord>> {
  const semantic = input.candidates.flatMap((fused) => fused.candidates.filter(isSemanticCandidate));
  if (semantic.length === 0 || input.semanticSpaceId === undefined || dependencies.embeddingJobs === undefined) return new Map();
  const records = await dependencies.embeddingJobs.getRecords(
    semantic.map((candidate) => candidate.embeddingEntity),
    input.semanticSpaceId,
  );
  return new Map(records.map((record) => [entityKey(record), record]));
}

function isSemanticCandidate(candidate: FusedCandidate["candidates"][number]): candidate is SemanticCandidate {
  return candidate.channel === "semantic" && "vectorId" in candidate && "spaceId" in candidate;
}

function matchesOf(candidates: ReturnType<typeof validSources>) {
  return candidates.map((candidate) => ({
    channel: candidate.candidate.channel,
    rank: candidate.candidate.rank,
    ...(candidate.candidate.rawScore === undefined ? {} : { rawScore: candidate.candidate.rawScore }),
  }));
}

function validatedScore(
  fused: FusedCandidate,
  candidates: ReturnType<typeof validSources>,
): number {
  const sharedBoost = Math.max(0, fused.fusedScore - fused.contributions.reduce((sum, value) => sum + value, 0));
  return candidates.reduce((sum, value) => sum + value.contribution, 0) + sharedBoost;
}

function chunkScope(chunk: EvidenceChunk): SearchScope | undefined {
  return chunk.scope.projectId === undefined ? undefined : {
    projectId: chunk.scope.projectId,
    ...(chunk.scope.workstreamId === undefined ? {} : { workstreamId: chunk.scope.workstreamId }),
    sessionId: chunk.scope.sessionId,
  };
}

function memoryScope(memory: MemoryRecord): SearchScope | undefined {
  return memory.scope.projectId === undefined ? undefined : {
    projectId: memory.scope.projectId,
    ...(memory.scope.workstreamId === undefined ? {} : { workstreamId: memory.scope.workstreamId }),
    ...(memory.scope.sessionId === undefined ? {} : { sessionId: memory.scope.sessionId }),
  };
}

function memoryFingerprint(memory: MemoryRecord): string {
  return createHash("sha256").update(memory.title).update("\0").update(memory.body)
    .update("\0").update(memory.extractorVersion).digest("hex");
}

function passesTime(observedAt: string | undefined, filters: HitValidationInput["filters"]): boolean {
  if (filters?.timeRange?.from !== undefined && (observedAt === undefined || observedAt < filters.timeRange.from)) return false;
  if (filters?.timeRange?.to !== undefined && (observedAt === undefined || observedAt > filters.timeRange.to)) return false;
  return true;
}

function passesPaths(text: string, filters: HitValidationInput["filters"]): boolean {
  const paths = filters?.paths;
  if (paths === undefined || paths.length === 0) return true;
  const normalized = text.normalize("NFKC").toLowerCase();
  return paths.some((path) => normalized.includes(path.normalize("NFKC").trim().toLowerCase()));
}

async function passesBranch(
  scope: SearchScope,
  filters: HitValidationInput["filters"],
  scopes: ScopeRepository | undefined,
): Promise<boolean> {
  if (filters?.branch === undefined) return true;
  if (scope.sessionId === undefined || scopes === undefined) return false;
  const session = await scopes.getSession(scope.sessionId);
  return session?.branch === filters.branch;
}

function entityKey(value: { readonly entity: { readonly kind: string; readonly id: string } }): string {
  return `${value.entity.kind}\0${value.entity.id}`;
}
