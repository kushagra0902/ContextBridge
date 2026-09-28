// This file implementes the structures for implementation of searching and retrieval of the memory.
// It defines the filters, or types of search queries and required results that are to be given.

import type {
  ChunkId,
  EventId,
  MemoryId,
} from "./ids.js";
import type { MemoryEvidenceId, MemoryType } from "./memory.js";
import type { ScopeAddress } from "./scope.js";

export const SEARCH_SCHEMA_VERSION = 1;

export type SearchCursor = string & { readonly __brand: "SearchCursor" };

export type SearchScope = ScopeAddress;

export interface SearchTimeRange {
  readonly from?: string;
  readonly to?: string;
}

export type SearchIntent =
  | "exact_identifier"
  | "exact_error"
  | "decision_rationale"
  | "debugging_history"
  | "chronology"
  | "open_items"
  | "latest_state"
  | "broad_synthesis"
  | "general";

export type RetrievalChannel =
  | "exact"
  | "fts"
  | "semantic"
  | "structured"
  | "recent";

export interface SearchFilters {
  readonly scope?: SearchScope;
  readonly memoryTypes?: readonly MemoryType[];
  readonly timeRange?: SearchTimeRange;
  readonly paths?: readonly string[];
  readonly branch?: string;
}

export interface SearchBudget {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxTokens: number;
}

export interface SearchBudgetLimits extends SearchBudget {
  readonly minItems?: number;
  readonly minBytes?: number;
  readonly minTokens?: number;
}

export type SearchEntity =
  | { readonly kind: "chunk"; readonly id: ChunkId }
  | { readonly kind: "memory"; readonly id: MemoryId };

export interface RankedCandidate {
  readonly entity: SearchEntity;
  readonly scope: SearchScope;
  readonly channel: RetrievalChannel;
  readonly rank: number;
  readonly rawScore?: number;
  readonly matchedTerms?: readonly string[];
  /** Used to reject a stale semantic candidate during SQLite hydration. */
  readonly fingerprint?: string;
}

export type CurrentnessStatus =
  | "historical_unverified"
  | "current_as_of_commit"
  | "unknown_currentness"
  | "superseded";

export type SemanticSearchStatus =
  | "ready"
  | "indexing"
  | "unavailable"
  | "disabled"
  | "not_applicable";

export type SearchHitType = "chunk" | MemoryType;

export interface SearchMatch {
  readonly channel: RetrievalChannel;
  readonly rank: number;
  readonly rawScore?: number;
}

interface SearchHitBase {
  readonly scope: SearchScope;
  readonly title?: string;
  readonly snippet: string;
  readonly matches: readonly SearchMatch[];
  readonly evidenceIds: readonly MemoryEvidenceId[];
  readonly observedAt?: string;
  readonly currentness: CurrentnessStatus;
  readonly fusedScore: number;
}

export interface ChunkSearchHit extends SearchHitBase {
  readonly entity: { readonly kind: "chunk"; readonly id: ChunkId };
  readonly type: "chunk";
}

export interface MemorySearchHit extends SearchHitBase {
  readonly entity: { readonly kind: "memory"; readonly id: MemoryId };
  readonly type: MemoryType;
}

export type SearchHit = ChunkSearchHit | MemorySearchHit;

export interface SearchFreshness {
  readonly sourceLastSeenAt?: string;
  readonly lexicalIndexedThrough?: string;
  readonly semanticIndexedThrough?: string;
  readonly pendingSemanticJobs: number;
  readonly stale: boolean;
}

export type SearchResultStatus =
  | "ok"
  | "empty"
  | "partial"
  | "no_source"
  | "indexing"
  | "ambiguous_scope"
  | "scope_excluded"
  | "stale_index"
  | "not_found";

export type SearchLimitKind = "items" | "bytes" | "tokens";

export interface SearchTruncation {
  readonly truncated: boolean;
  readonly limitsReached: readonly SearchLimitKind[];
}

export interface SearchRequest {
  readonly query: string;
  readonly intent?: SearchIntent;
  readonly filters?: SearchFilters;
  readonly budget: SearchBudget;
  readonly cursor?: SearchCursor;
}

export interface SearchResult {
  readonly schemaVersion: typeof SEARCH_SCHEMA_VERSION;
  readonly status: SearchResultStatus;
  readonly scope?: SearchScope;
  readonly hits: readonly SearchHit[];
  readonly freshness: SearchFreshness;
  readonly semanticStatus: SemanticSearchStatus;
  readonly truncation: SearchTruncation;
  readonly continuation?: SearchCursor;
}

export interface EvidenceRequest {
  readonly evidenceIds: readonly (EventId | ChunkId)[];
  readonly beforeEvents: number;
  readonly afterEvents: number;
  readonly budget: SearchBudget;
}

export function normalizeSearchBudget(
  requested: Partial<SearchBudget> | undefined,
  limits: SearchBudgetLimits,
): SearchBudget {
  const minItems = limits.minItems ?? 1;
  const minBytes = limits.minBytes ?? 1;
  const minTokens = limits.minTokens ?? 1;

  return {
    maxItems: clampInteger(requested?.maxItems, minItems, limits.maxItems),
    maxBytes: clampInteger(requested?.maxBytes, minBytes, limits.maxBytes),
    maxTokens: clampInteger(requested?.maxTokens, minTokens, limits.maxTokens),
  };
}

export function parseSearchCursor(value: unknown): SearchCursor {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Invalid search cursor");
  }

  return value as SearchCursor;
}

export function isExactSearchIntent(intent: SearchIntent): boolean {
  return intent === "exact_identifier" || intent === "exact_error";
}

function clampInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum <= 0 ||
    maximum < minimum
  ) {
    throw new RangeError("Invalid search budget limits");
  }

  if (value === undefined) {
    return maximum;
  }

  if (!Number.isFinite(value)) {
    return maximum;
  }

  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
