import { Buffer } from "node:buffer";

import type {
  AuthorizationPolicy,
  OutputPolicy,
  Storage,
  Tokenizer,
  VectorIndex,
} from "../contracts/ports.js";
import type {
  SearchBudget,
  SearchBudgetLimits,
  SearchFreshness,
  SearchLimitKind,
  SearchTruncation,
} from "../contracts/search.js";
import { normalizeSearchBudget } from "../contracts/search.js";

export interface AppReadDependencies {
  readonly storage: Storage;
  readonly authorization: AuthorizationPolicy;
  readonly outputPolicy: OutputPolicy;
  readonly budgetLimits: SearchBudgetLimits;
  readonly tokenizer?: Tokenizer;
  readonly vectorIndex?: VectorIndex;
}

export async function collectFreshness(
  storage: Storage,
  vectorIndex?: VectorIndex,
): Promise<SearchFreshness> {
  const sources = await storage.sources.listSources();
  const cursors = await Promise.all(sources.map((source) => storage.sources.getCursor(source.id)));
  const fullyIndexedTimes: number[] = [];
  let stale = false;
  sources.forEach((source, index) => {
    const cursor = cursors[index];
    if (cursor === undefined || cursor.committedByteOffset < source.fileIdentity.size) {
      stale = true;
      return;
    }
    fullyIndexedTimes.push(source.fileIdentity.modifiedAtMs);
  });

  const sourceLastSeenMs = maximumFinite(sources.map((source) => source.fileIdentity.modifiedAtMs));
  const lexicalIndexedMs = maximumFinite(fullyIndexedTimes);
  let semanticIndexedThrough: string | undefined;
  let pendingSemanticJobs = 0;
  if (vectorIndex !== undefined) {
    try {
      const health = await vectorIndex.health();
      semanticIndexedThrough = health.indexedThrough;
      pendingSemanticJobs = health.pendingJobs;
    } catch {
      // Search status reports vector failure separately; freshness remains safe.
    }
  }
  return {
    ...(sourceLastSeenMs === undefined ? {} : { sourceLastSeenAt: new Date(sourceLastSeenMs).toISOString() }),
    ...(lexicalIndexedMs === undefined ? {} : { lexicalIndexedThrough: new Date(lexicalIndexedMs).toISOString() }),
    ...(semanticIndexedThrough === undefined ? {} : { semanticIndexedThrough }),
    pendingSemanticJobs,
    stale,
  };
}

export function effectiveBudget(
  requested: Partial<SearchBudget> | undefined,
  limits: SearchBudgetLimits,
): SearchBudget {
  return normalizeSearchBudget(requested, limits);
}

export function reserveEnvelopeBudget(
  budget: SearchBudget,
  envelope: unknown,
  tokenizer: Tokenizer | undefined,
  reserveBytes = 512,
): SearchBudget {
  const serialized = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(serialized) + reserveBytes;
  const tokens = countTokens(serialized, tokenizer) + reserveBytes;
  if (bytes >= budget.maxBytes || tokens >= budget.maxTokens) {
    throw new RangeError("Response metadata cannot fit the requested budget");
  }
  return {
    maxItems: budget.maxItems,
    maxBytes: budget.maxBytes - bytes,
    maxTokens: budget.maxTokens - tokens,
  };
}

export interface BoundedItems<T> {
  readonly items: readonly T[];
  readonly truncation: SearchTruncation;
}

export function boundJsonItems<T>(
  items: readonly T[],
  budget: SearchBudget,
  tokenizer: Tokenizer | undefined,
  envelope: (selected: readonly T[], truncation: SearchTruncation) => unknown,
): BoundedItems<T> {
  const selected: T[] = [];
  const limits = new Set<SearchLimitKind>();
  for (const item of items) {
    if (selected.length === budget.maxItems) {
      limits.add("items");
      break;
    }
    const next = [...selected, item];
    const probe = JSON.stringify(envelope(next, { truncated: false, limitsReached: [] }));
    const bytes = Buffer.byteLength(probe);
    const tokens = countTokens(probe, tokenizer);
    if (bytes > budget.maxBytes || tokens > budget.maxTokens) {
      if (bytes > budget.maxBytes) limits.add("bytes");
      if (tokens > budget.maxTokens) limits.add("tokens");
      break;
    }
    selected.push(item);
  }
  if (selected.length < items.length && limits.size === 0) limits.add("items");
  return {
    items: selected,
    truncation: { truncated: limits.size > 0, limitsReached: [...limits] },
  };
}

export async function assertFinalBudget(
  value: unknown,
  budget: SearchBudget,
  outputPolicy: OutputPolicy,
): Promise<void> {
  outputPolicy.assertWithinBudget(JSON.stringify(value), budget);
}

function countTokens(text: string, tokenizer: Tokenizer | undefined): number {
  const count = tokenizer?.count(text) ?? Buffer.byteLength(text);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Tokenizer returned an invalid token count");
  return count;
}

function maximumFinite(values: readonly number[]): number | undefined {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? undefined : Math.max(...finite);
}
