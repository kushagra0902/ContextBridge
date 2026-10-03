// This file defines the interfaces for how the application talks 
// to the other databases, embedding stores, vector databases, tokenizer etc.
// In other words it provides allowed formats for communication between different modules. 

import type {
  EmbeddingCapability,
  EmbeddingJob,
  EmbeddingJobId,
  EmbeddingRecord,
  EmbeddingSpace,
  VectorFilter,
  VectorHealth,
  VectorHit,
  VectorRow,
} from "./embedding.js";

import type { CanonicalEvent, EvidenceChunk } from "./evidence.js";

import type {
  ChunkId,
  EventId,
  MemoryId,
  ProjectId,
  SourceId,
  SessionId,
  VectorId,
} from "./ids.js";

import type { MemoryRecord, MemoryType } from "./memory.js";

import type {
  RankedCandidate,
  SearchBudget,
  SearchFilters,
  SearchScope,
} from "./search.js";

import type {
  ExplicitScopeMapping,
  ScopeAddress,
  ScopeAlias,
  ScopeCandidate,
  ScopeExclusion,
  ScopeAvailability,
  ScopeRef,
  SessionRef,
} from "./scope.js";

import type { SourceCursor, SourceRef } from "./source.js";

export type { SourceAdapter } from "./source.js";

export interface Clock {
  now(): Date;
}

export interface Tokenizer {
  count(text: string): number;
  truncate(text: string, maxTokens: number): string;
}

export interface CanonicalBatch {
  readonly source: SourceRef;
  readonly events: readonly CanonicalEvent[];
}

export interface CommitResult {
  readonly insertedEvents: number;
  readonly duplicateEvents: number;
  readonly committedCursor: SourceCursor;
}

export interface CommitBatchOptions {
  /**
   * Replay permits a verified rotation/truncation scan to replace the cursor
   * with an earlier offset. Normal append commits remain strictly monotonic.
   */
  readonly cursorMode?: "append" | "replay";
}

export interface SourceStateRepository {
  listSources(): Promise<readonly SourceRef[]>;
  upsertSources(sources: readonly SourceRef[]): Promise<void>;
  getCursor(sourceId: SourceId): Promise<SourceCursor | undefined>;
}

export interface EvidenceRepository {
  /** Events and their source cursor must commit atomically. */
  commitBatch(
    batch: CanonicalBatch,
    nextCursor: SourceCursor,
    options?: CommitBatchOptions,
  ): Promise<CommitResult>;
  getEvents(ids: readonly EventId[]): Promise<readonly CanonicalEvent[]>;
  getChunks(ids: readonly ChunkId[]): Promise<readonly EvidenceChunk[]>;
  listSessionEvents(
    sessionId: SessionId,
    afterOrdinal: number | undefined,
    limit: number,
  ): Promise<readonly CanonicalEvent[]>;
  getEventNeighborhood(
    ids: readonly EventId[],
    before: number,
    after: number,
    limit: number,
  ): Promise<readonly CanonicalEvent[]>;
}

export interface MemoryRepository {
  get(ids: readonly MemoryId[]): Promise<readonly MemoryRecord[]>;
  findByScope(
    scope: SearchScope,
    types?: readonly MemoryType[],
  ): Promise<readonly MemoryRecord[]>;
}

export interface ScopeRepository {
  get(scope: ScopeAddress): Promise<ScopeRef | undefined>;
  getSession(sessionId: SessionId): Promise<SessionRef | undefined>;
  listCandidates(
    query: string | undefined,
    limit: number,
  ): Promise<readonly ScopeCandidate[]>;
  findAliases(
    normalizedAlias: string,
    limit: number,
  ): Promise<readonly ScopeAlias[]>;
  getExplicitMappings(
    sessionId?: SessionId,
  ): Promise<readonly ExplicitScopeMapping[]>;
  getExclusion(scope: ScopeAddress): Promise<ScopeExclusion | undefined>;
  getAvailability(scope: ScopeAddress): Promise<ScopeAvailability>;
  upsertScopes(scopes: readonly ScopeRef[]): Promise<void>;
  upsertAliases(aliases: readonly ScopeAlias[]): Promise<void>;
  upsertExplicitMappings(
    mappings: readonly ExplicitScopeMapping[],
  ): Promise<void>;
  upsertExclusion(exclusion: ScopeExclusion): Promise<void>;
  removeExclusion(scope: ScopeAddress): Promise<boolean>;
}

/**
 * One SQLite transaction applies derived rows, their lexical indexes, and
 * their embedding jobs. Empty arrays make rebuild/delete batches explicit.
 */
export interface DerivedDataBatch {
  readonly upsertChunks: readonly EvidenceChunk[];
  readonly deleteChunkIds: readonly ChunkId[];
  readonly upsertMemories: readonly MemoryRecord[];
  readonly deleteMemoryIds: readonly MemoryId[];
  readonly embeddingJobs: readonly EmbeddingJob[];
}

export interface DerivedDataCommitResult {
  readonly upsertedChunks: number;
  readonly deletedChunks: number;
  readonly upsertedMemories: number;
  readonly deletedMemories: number;
  readonly enqueuedEmbeddingJobs: number;
}

export interface DerivedDataRepository {
  commit(batch: DerivedDataBatch): Promise<DerivedDataCommitResult>;
}

export interface LexicalSearchRepository {
  search(
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<readonly RankedCandidate[]>;
}

export interface EmbeddingJobRepository {
  upsertSpace(space: EmbeddingSpace): Promise<void>;
  getSpace(spaceId: EmbeddingSpace["id"]): Promise<EmbeddingSpace | undefined>;
  getActiveSpace(): Promise<EmbeddingSpace | undefined>;
  enqueue(jobs: readonly EmbeddingJob[]): Promise<void>;
  claim(input: EmbeddingJobClaim): Promise<readonly EmbeddingJob[]>;
  requeueExpiredLeases(now: Date): Promise<number>;
  acknowledge(
    jobId: EmbeddingJobId,
    indexedFingerprint: string,
    vectorId: VectorId,
  ): Promise<boolean>;
  retry(jobId: EmbeddingJobId, retryAt: Date, errorCode: string): Promise<void>;
  fail(jobId: EmbeddingJobId, errorCode: string): Promise<void>;
  getRecords(
    entities: readonly EmbeddingJob["entity"][],
    spaceId: EmbeddingSpace["id"],
  ): Promise<readonly EmbeddingRecord[]>;
}

export interface EmbeddingJobClaim {
  readonly limit: number;
  readonly workerId: string;
  readonly now: Date;
  readonly leaseDurationMs: number;
}

export interface EmbeddingProvider {
  manifest(): EmbeddingSpace;
  capability(): Promise<EmbeddingCapability>;
  embedDocuments(texts: readonly string[]): Promise<readonly Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  close?(): Promise<void>;
}

export interface VectorIndex {
  upsert(rows: readonly VectorRow[]): Promise<void>;
  delete(ids: readonly VectorId[]): Promise<void>;
  search(
    vector: Float32Array,
    filter: VectorFilter,
    limit: number,
  ): Promise<readonly VectorHit[]>;
  getFingerprints(
    ids: readonly VectorId[],
  ): Promise<ReadonlyMap<VectorId, string>>;
  optimize(): Promise<void>;
  health(): Promise<VectorHealth>;
  close?(): Promise<void>;
}

export type ReadOperation =
  | "list_scopes"
  | "get_overview"
  | "search_memory"
  | "get_evidence"
  | "export_scope";

export type AccessDenialReason =
  | "excluded"
  | "not_selected"
  | "policy";

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AccessDenialReason };

export interface AuthorizationPolicy {
  authorizeScope(
    scope: SearchScope,
    operation: ReadOperation,
  ): Promise<AccessDecision>;
  authorizeProject(
    projectId: ProjectId,
    operation: ReadOperation,
  ): Promise<AccessDecision>;
}

export interface OutputPolicy {
  sanitizeText(text: string): Promise<string>;
  assertWithinBudget(text: string, budget: SearchBudget): void;
}

/** Repositories exposed by the authoritative SQLite storage adapter. */
export interface Storage {
  readonly sources: SourceStateRepository;
  readonly scopes: ScopeRepository;
  readonly evidence: EvidenceRepository;
  readonly memories: MemoryRepository;
  readonly derivedData: DerivedDataRepository;
  readonly lexicalSearch: LexicalSearchRepository;
  readonly embeddingJobs: EmbeddingJobRepository;
  close(): Promise<void>;
}
