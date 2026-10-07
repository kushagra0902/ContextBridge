import type { EmbeddableEntity, EmbeddingSpaceId } from "../contracts/embedding.js";
import {
  embeddingSpacesAreCompatible,
  validateEmbeddingVector,
} from "../contracts/embedding.js";
import type {
  EmbeddingJobRepository,
  EmbeddingProvider,
  VectorIndex,
} from "../contracts/ports.js";
import type {
  RankedCandidate,
  SearchFilters,
  SearchScope,
  SemanticSearchStatus,
} from "../contracts/search.js";
import type { VectorId } from "../contracts/ids.js";
import { normalizeRetrievalQuery } from "./intent.js";

export interface SemanticCandidate extends RankedCandidate {
  readonly channel: "semantic";
  readonly embeddingEntity: EmbeddableEntity;
  readonly vectorId: VectorId;
  readonly spaceId: EmbeddingSpaceId;
}

export interface SemanticRetrievalResult {
  readonly status: SemanticSearchStatus;
  readonly candidates: readonly SemanticCandidate[];
  readonly spaceId?: EmbeddingSpaceId;
  readonly reason?: string;
}

export interface SemanticRetrievalDependencies {
  readonly provider?: EmbeddingProvider;
  readonly embeddingJobs?: EmbeddingJobRepository;
  readonly vectorIndex?: VectorIndex;
}

export interface SemanticRetrievalInput {
  readonly query: string;
  readonly scope: SearchScope;
  readonly filters?: Omit<SearchFilters, "scope">;
  readonly limit?: number;
}

/** Runs the optional vector branch and converts all capability failures to status. */
export async function retrieveSemantic(
  input: SemanticRetrievalInput,
  dependencies: SemanticRetrievalDependencies,
): Promise<SemanticRetrievalResult> {
  const query = normalizeRetrievalQuery(input.query);
  const limit = boundedLimit(input.limit ?? 50);
  const { provider, embeddingJobs, vectorIndex } = dependencies;
  if (provider === undefined || embeddingJobs === undefined || vectorIndex === undefined) {
    return { status: "disabled", candidates: [] };
  }
  // These filters cannot be proven by the current vector metadata schema.
  if ((input.filters?.paths?.length ?? 0) > 0 || input.filters?.branch !== undefined) {
    return {
      status: "not_applicable",
      candidates: [],
      reason: "Path and branch filters require authoritative lexical metadata",
    };
  }

  try {
    const capability = await provider.capability();
    if (capability.status === "disabled") return { status: "disabled", candidates: [] };
    if (capability.status === "loading" || capability.status === "not_downloaded") {
      return { status: "indexing", candidates: [], ...(capability.reason === undefined ? {} : { reason: capability.reason }) };
    }
    if (capability.status !== "ready") {
      return { status: "unavailable", candidates: [], ...(capability.reason === undefined ? {} : { reason: capability.reason }) };
    }

    const space = await embeddingJobs.getActiveSpace();
    if (space === undefined || space.status !== "active") {
      return { status: "indexing", candidates: [], reason: "No active embedding space" };
    }
    if (!embeddingSpacesAreCompatible(space, provider.manifest())) {
      return { status: "unavailable", candidates: [], spaceId: space.id, reason: "Embedding provider does not match the active space" };
    }

    const health = await vectorIndex.health();
    if (health.status === "unavailable") {
      return { status: "unavailable", candidates: [], spaceId: space.id, ...(health.message === undefined ? {} : { reason: health.message }) };
    }
    if (health.status === "rebuilding") {
      return { status: "indexing", candidates: [], spaceId: space.id, ...(health.message === undefined ? {} : { reason: health.message }) };
    }
    if (health.activeSpaceId !== undefined && health.activeSpaceId !== space.id) {
      return { status: "indexing", candidates: [], spaceId: space.id, reason: "Vector index is not serving the active embedding space" };
    }

    const vector = await provider.embedQuery(query);
    validateEmbeddingVector(vector, space);
    const hits = await vectorIndex.search(vector, {
      ...input.scope,
      spaceId: space.id,
      ...(input.filters?.timeRange?.from === undefined ? {} : { observedFrom: input.filters.timeRange.from }),
      ...(input.filters?.timeRange?.to === undefined ? {} : { observedTo: input.filters.timeRange.to }),
    }, limit);
    const allowedTypes = new Set(input.filters?.memoryTypes ?? []);
    const candidates = hits
      .filter((hit) => hit.spaceId === space.id)
      .filter((hit) => allowedTypes.size === 0 || (hit.entity.kind === "memory" && allowedTypes.has(hit.entity.memoryType)))
      .map<SemanticCandidate>((hit) => ({
        entity: hit.entity.kind === "chunk"
          ? { kind: "chunk", id: hit.entity.id }
          : { kind: "memory", id: hit.entity.id },
        scope: input.scope,
        channel: "semantic",
        rank: hit.rank,
        rawScore: -hit.distance,
        fingerprint: hit.fingerprint,
        embeddingEntity: hit.entity,
        vectorId: hit.id,
        spaceId: hit.spaceId,
      }));
    return { status: "ready", candidates, spaceId: space.id };
  } catch (error) {
    return {
      status: "unavailable",
      candidates: [],
      reason: error instanceof Error ? error.message : "Semantic retrieval failed",
    };
  }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("Semantic retrieval limit must be from 1 to 1000");
  }
  return value;
}
