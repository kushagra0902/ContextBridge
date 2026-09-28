import type {
  ChunkId,
  MemoryId,
  ProjectId,
  SessionId,
  VectorId,
  WorkstreamId,
} from "./ids.js";

export type EmbeddingSpaceId = string; // similar dimension and compatible vectors in same space so that can be compared.
export type EmbeddingJobId = string; 

export type EmbeddingProviderKind = "local_transformers" | "remote"; // who has created the embedding. ie some local running transformer/model or remote model. 
export type EmbeddingDistanceMetric = "cosine" | "dot" | "l2"; // simple distance metric used for that embeddings
export type EmbeddingNormalization = "none" | "l2";
export type EmbeddingSpaceStatus =
  | "building"
  | "active"
  | "retiring"
  | "retired"
  | "failed";

export interface EmbeddingSpace {
  readonly id: EmbeddingSpaceId;
  readonly provider: EmbeddingProviderKind;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dimension: number;
  readonly distanceMetric: EmbeddingDistanceMetric;
  readonly normalization: EmbeddingNormalization;
  readonly tokenizerVersion: string;
  readonly preprocessingVersion: string;
  readonly redactionVersion: string;
  readonly documentPrefix?: string;
  readonly queryPrefix?: string;
  readonly status: EmbeddingSpaceStatus;
  readonly createdAt: string;
}

export type EmbeddableMemoryType = "decision" | "episode" | "open_item";

/**
 * Only coherent chunks and evidence-backed derived records are embedded.
 * Broad project/workstream synopses are intentionally excluded in v1.
 */
export type EmbeddableEntity =
  | { readonly kind: "chunk"; readonly id: ChunkId }
  | {
      readonly kind: "memory";
      readonly id: MemoryId;
      readonly memoryType: EmbeddableMemoryType;
    };

export type EmbeddingOperation = "upsert" | "delete";
export type EmbeddingJobState =
  | "pending"
  | "processing"
  | "retry"
  | "ready"
  | "failed"
  | "cancelled";

export interface EmbeddingJob {
  readonly id: EmbeddingJobId;
  readonly entity: EmbeddableEntity;
  readonly spaceId: EmbeddingSpaceId;
  readonly desiredFingerprint: string;
  readonly operation: EmbeddingOperation;
  readonly state: EmbeddingJobState;
  readonly attempts: number;
  readonly retryAt?: string;
  readonly errorCode?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VectorScopeMetadata {
  readonly projectId: ProjectId;
  readonly workstreamId?: WorkstreamId;
  readonly sessionId?: SessionId;
}

export interface VectorRow {
  readonly id: VectorId;
  readonly entity: EmbeddableEntity;
  readonly spaceId: EmbeddingSpaceId;
  readonly fingerprint: string;
  readonly scope: VectorScopeMetadata;
  readonly observedAt?: string;
  readonly embedding: Float32Array;
}

export interface VectorFilter extends VectorScopeMetadata {
  readonly spaceId: EmbeddingSpaceId;
  readonly entityKinds?: readonly EmbeddableEntity["kind"][];
  readonly observedFrom?: string;
  readonly observedTo?: string;
}

export interface VectorHit {
  readonly id: VectorId;
  readonly entity: EmbeddableEntity;
  readonly spaceId: EmbeddingSpaceId;
  readonly fingerprint: string;
  readonly distance: number;
  readonly rank: number;
}

/** SQLite's authoritative record of the last confirmed vector write. */
export interface EmbeddingRecord {
  readonly entity: EmbeddableEntity;
  readonly spaceId: EmbeddingSpaceId;
  readonly fingerprint: string;
  readonly vectorId: VectorId;
  readonly indexedAt: string;
}

export type VectorHealthStatus =
  | "ready"
  | "degraded"
  | "unavailable"
  | "rebuilding";

export interface VectorHealth {
  readonly status: VectorHealthStatus;
  readonly activeSpaceId?: EmbeddingSpaceId;
  readonly vectorCount: number;
  readonly pendingJobs: number;
  readonly failedJobs: number;
  readonly staleVectorRejects: number;
  readonly diskBytes?: number;
  readonly oldestPendingAt?: string;
  readonly indexedThrough?: string;
  readonly lastReconciledAt?: string;
  readonly message?: string;
}

export type EmbeddingProviderStatus =
  | "disabled"
  | "not_downloaded"
  | "loading"
  | "ready"
  | "unavailable";

export interface EmbeddingCapability {
  readonly status: EmbeddingProviderStatus;
  readonly provider: EmbeddingProviderKind;
  readonly modelCached: boolean;
  readonly reason?: string;
}

export function embeddingSpacesAreCompatible(
  left: EmbeddingSpace,
  right: EmbeddingSpace,
): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.modelRevision === right.modelRevision &&
    left.dimension === right.dimension &&
    left.distanceMetric === right.distanceMetric &&
    left.normalization === right.normalization &&
    left.tokenizerVersion === right.tokenizerVersion &&
    left.preprocessingVersion === right.preprocessingVersion &&
    left.redactionVersion === right.redactionVersion &&
    left.documentPrefix === right.documentPrefix &&
    left.queryPrefix === right.queryPrefix
  );
}

export function validateEmbeddingVector(
  vector: Float32Array,
  space: EmbeddingSpace,
): void {
  if (!Number.isInteger(space.dimension) || space.dimension <= 0) {
    throw new RangeError("Embedding space dimension must be a positive integer");
  }

  if (vector.length !== space.dimension) {
    throw new RangeError(
      `Embedding dimension mismatch: expected ${space.dimension}, received ${vector.length}`,
    );
  }

  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new TypeError("Embedding vectors may contain only finite numbers");
    }
  }
}

export function isRunnableEmbeddingJob(
  job: EmbeddingJob,
  now: Date,
): boolean {
  if (job.state === "pending") {
    return true;
  }

  if (job.state !== "retry" || job.retryAt === undefined) {
    return false;
  }

  const retryAtMs = Date.parse(job.retryAt);
  return Number.isFinite(retryAtMs) && retryAtMs <= now.getTime();
}
