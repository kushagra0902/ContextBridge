// Coordinates the chunk creation process

import type {
  CanonicalEvent,
  EvidenceChunk,
  EvidenceScope,
  OmissionMarker,
} from "../../contracts/evidence.js";

import { chunkId, type EventId } from "../../contracts/ids.js";
import type { Tokenizer } from "../../contracts/ports.js";
import { analyzeEventBoundaries, type BoundaryAnalysis } from "./boundaries.js";
import { fingerprintChunk } from "./fingerprint.js";

import {
  countTokens,
  heuristicTokenizer,
  prepareEventText,
  splitEventText,
} from "./text.js";

export const CHUNKER_VERSION = "turn-aware-v1";
export const DEFAULT_REDACTION_VERSION = "canonical-redaction-v1";

export interface ChunkBuildPolicy {
  readonly scope: EvidenceScope;
  readonly targetTokens: number;
  readonly maxTokens: number;
  readonly maxToolOutputCharacters: number;
  readonly tokenizer?: Tokenizer;
  readonly chunkerVersion?: string;
  readonly redactionVersion?: string;
}

export interface ChunkEventLink {
  readonly chunkId: EvidenceChunk["id"];
  readonly eventId: EventId;
  readonly position: number;
}

export interface ChunkBuildResult {
  readonly chunks: readonly EvidenceChunk[];
  readonly eventLinks: readonly ChunkEventLink[];
  readonly boundaries: BoundaryAnalysis;
}

interface EventFragment {
  readonly event: CanonicalEvent;
  readonly segmentIndex: number;
  readonly displayText: string;
  readonly embeddingText: string;
  readonly omissions: readonly OmissionMarker[];
}

/** Builds ordered, provenance-linked chunks without writing to storage. */
export function buildChunks(
  events: readonly CanonicalEvent[],
  policy: ChunkBuildPolicy,
): ChunkBuildResult {
  validatePolicy(policy);
  const tokenizer = policy.tokenizer ?? heuristicTokenizer;
  const chunkerVersion = policy.chunkerVersion ?? CHUNKER_VERSION;
  const redactionVersion = policy.redactionVersion ?? DEFAULT_REDACTION_VERSION;
  const boundaries = analyzeEventBoundaries(events);
  for (const group of boundaries.groups) {
    for (const event of group.events) {
      if (event.sessionId !== policy.scope.sessionId) {
        throw new TypeError("Chunk scope session does not match input events");
      }
    }
  }

  const packed: EventFragment[][] = [];
  let current: EventFragment[] = [];
  const flush = (): void => {
    if (current.length > 0) packed.push(current);
    current = [];
  };

  for (const group of boundaries.groups) {
    const fragments = group.events.flatMap((event) => fragmentsForEvent(
      event,
      policy,
      tokenizer,
    ));
    const groupTokens = countFragments(fragments, tokenizer);
    if (
      current.length > 0 &&
      (countFragments(current, tokenizer) >= policy.targetTokens ||
        countFragments([...current, ...fragments], tokenizer) > policy.maxTokens)
    ) {
      flush();
    }
    if (groupTokens <= policy.maxTokens) {
      current.push(...fragments);
      continue;
    }
    for (const fragment of fragments) {
      if (
        current.length > 0 &&
        countFragments([...current, fragment], tokenizer) > policy.maxTokens
      ) {
        flush();
      }
      current.push(fragment);
    }
  }
  flush();

  const chunks = packed.map((fragments, sequence) => createChunk(
    fragments,
    sequence,
    policy.scope,
    tokenizer,
    chunkerVersion,
    redactionVersion,
  ));
  const eventLinks = chunks.flatMap((chunk) =>
    chunk.eventIds.map((eventId, position) => ({
      chunkId: chunk.id,
      eventId,
      position,
    })),
  );
  return { chunks, eventLinks, boundaries };
}

function fragmentsForEvent(
  event: CanonicalEvent,
  policy: ChunkBuildPolicy,
  tokenizer: Tokenizer,
): readonly EventFragment[] {
  const prepared = prepareEventText(event, {
    maxToolOutputCharacters: policy.maxToolOutputCharacters,
  });
  return splitEventText(event, prepared, policy.maxTokens, tokenizer).map(
    (part, segmentIndex) => ({
      event,
      segmentIndex,
      displayText: part.displayText,
      embeddingText: part.embeddingText,
      omissions: prepared.omissions,
    }),
  );
}

function createChunk(
  fragments: readonly EventFragment[],
  sequence: number,
  scope: EvidenceScope,
  tokenizer: Tokenizer,
  chunkerVersion: string,
  redactionVersion: string,
): EvidenceChunk {
  const first = fragments[0];
  if (first === undefined) {
    throw new Error("Cannot create an empty evidence chunk");
  }
  const displayText = fragments.map((fragment) => fragment.displayText).join("\n\n");
  const embeddingText = fragments
    .map((fragment) => fragment.embeddingText)
    .join("\n\n");
  const tokenCount = countTokens(embeddingText, tokenizer);
  const eventIds = uniqueEventIds(fragments);
  const last = fragments.at(-1) ?? first;
  const omissions = uniqueOmissions(fragments);
  const observed = fragments
    .map((fragment) => fragment.event.observedAt)
    .filter((value): value is string => value !== undefined)
    .sort();
  const observedFrom = observed[0];
  const observedTo = observed.at(-1);
  const id = chunkId([
    scope.sessionId,
    first.event.id,
    String(first.segmentIndex),
    last.event.id,
    String(last.segmentIndex),
    ...eventIds,
  ]);
  return {
    id,
    sequence,
    scope: { ...scope },
    eventIds,
    displayText,
    embeddingText,
    tokenCount,
    fingerprint: fingerprintChunk({
      embeddingText,
      eventIds,
      chunkerVersion,
      redactionVersion,
    }),
    ...(omissions.length === 0 ? {} : { omissions }),
    ...(observedFrom === undefined ? {} : { observedFrom }),
    ...(observedTo === undefined ? {} : { observedTo }),
  };
}

function countFragments(
  fragments: readonly EventFragment[],
  tokenizer: Tokenizer,
): number {
  return countTokens(
    fragments.map((fragment) => fragment.embeddingText).join("\n\n"),
    tokenizer,
  );
}

function uniqueEventIds(fragments: readonly EventFragment[]): EventId[] {
  const seen = new Set<EventId>();
  const ids: EventId[] = [];
  for (const fragment of fragments) {
    if (seen.has(fragment.event.id)) continue;
    seen.add(fragment.event.id);
    ids.push(fragment.event.id);
  }
  return ids;
}

function uniqueOmissions(
  fragments: readonly EventFragment[],
): OmissionMarker[] {
  const seen = new Set<string>();
  const omissions: OmissionMarker[] = [];
  for (const fragment of fragments) {
    for (const omission of fragment.omissions) {
      const key = `${omission.eventId}\0${omission.reason}\0${omission.omittedCharacters ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      omissions.push(omission);
    }
  }
  return omissions;
}

function validatePolicy(policy: ChunkBuildPolicy): void {
  if (!Number.isSafeInteger(policy.targetTokens) || policy.targetTokens < 1) {
    throw new RangeError("Chunk target must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 16) {
    throw new RangeError("Chunk maximum must be at least 16 tokens");
  }
  if (policy.targetTokens > policy.maxTokens) {
    throw new RangeError("Chunk target cannot exceed chunk maximum");
  }
  if (
    !Number.isSafeInteger(policy.maxToolOutputCharacters) ||
    policy.maxToolOutputCharacters < 128
  ) {
    throw new RangeError("Tool output character limit must be at least 128");
  }
}
