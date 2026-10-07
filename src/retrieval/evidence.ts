import { Buffer } from "node:buffer";

import { ContextBridgeError, ERROR_CODES } from "../contracts/errors.js";
import type { CanonicalEvent, EvidenceChunk, OmissionMarker } from "../contracts/evidence.js";
import { isStableId } from "../contracts/ids.js";
import type { ChunkId, EventId, SessionId, SourceId } from "../contracts/ids.js";
import type {
  EvidenceRepository,
  OutputPolicy,
  ScopeRepository,
  Tokenizer,
} from "../contracts/ports.js";
import type {
  EvidenceRequest,
  SearchLimitKind,
  SearchScope,
  SearchTruncation,
} from "../contracts/search.js";
import { scopeContains } from "../contracts/scope.js";

export interface ExpandedEvidenceChunk {
  readonly id: ChunkId;
  readonly scope: SearchScope;
  readonly eventIds: readonly EventId[];
  readonly omissions?: readonly OmissionMarker[];
  readonly observedFrom?: string;
  readonly observedTo?: string;
}

export interface ExpandedEvidenceEvent {
  readonly id: EventId;
  readonly sessionId: SessionId;
  readonly ordinal: number;
  readonly kind: CanonicalEvent["kind"];
  readonly observedAt?: string;
  readonly text: string;
  readonly toolCallId?: string;
  readonly source: {
    readonly sourceId: SourceId;
    readonly sourceOrdinal: number;
    readonly formatVersion: string;
  };
}

export interface ExpandedEvidenceResult {
  readonly chunks: readonly ExpandedEvidenceChunk[];
  readonly events: readonly ExpandedEvidenceEvent[];
  /** Missing, excluded, and foreign IDs intentionally share one outcome. */
  readonly unavailableEvidenceIds: readonly string[];
  readonly truncation: SearchTruncation;
}

export interface EvidenceExpansionDependencies {
  readonly evidence: EvidenceRepository;
  readonly scopes?: ScopeRepository;
  readonly outputPolicy?: Pick<OutputPolicy, "sanitizeText">;
  readonly tokenizer?: Tokenizer;
}

export interface EvidenceExpansionOptions {
  readonly scope?: SearchScope;
}

/** Expands opaque evidence IDs into bounded adjacent events and tool pairs. */
export async function expandEvidence(
  request: EvidenceRequest,
  dependencies: EvidenceExpansionDependencies,
  options: EvidenceExpansionOptions = {},
): Promise<ExpandedEvidenceResult> {
  validateRequest(request);
  if (options.scope !== undefined && dependencies.scopes === undefined) {
    throw new TypeError("Scope-aware evidence expansion requires a scope repository");
  }
  const uniqueIds = [...new Set<string>(request.evidenceIds)];
  const chunkIds = uniqueIds.filter((id): id is ChunkId => isStableId(id, "chunk"));
  const eventIds = uniqueIds.filter((id): id is EventId => isStableId(id, "event"));
  const unavailable = new Set<string>(
    uniqueIds.filter((id) => !isStableId(id, "chunk") && !isStableId(id, "event")),
  );

  const [storedChunks, directEvents] = await Promise.all([
    dependencies.evidence.getChunks(chunkIds),
    dependencies.evidence.getEvents(eventIds),
  ]);
  const chunks: EvidenceChunk[] = [];
  for (const chunk of storedChunks) {
    const scope = chunkScope(chunk);
    if (scope === undefined || (options.scope !== undefined && !scopeContains(options.scope, scope))) {
      unavailable.add(chunk.id);
    } else {
      chunks.push(chunk);
    }
  }
  const allowedDirect: CanonicalEvent[] = [];
  for (const event of directEvents) {
    if (await eventAllowed(event, options.scope, dependencies.scopes)) allowedDirect.push(event);
    else unavailable.add(event.id);
  }
  for (const id of chunkIds) if (!storedChunks.some((chunk) => chunk.id === id)) unavailable.add(id);
  for (const id of eventIds) if (!directEvents.some((event) => event.id === id)) unavailable.add(id);

  const anchorIds = [...new Set<EventId>([
    ...allowedDirect.map((event) => event.id),
    ...chunks.flatMap((chunk) => chunk.eventIds),
  ])];
  const limitedAnchors = anchorIds.slice(0, 100);
  const anchorEvents = await dependencies.evidence.getEvents(limitedAnchors);
  const fetched = limitedAnchors.length === 0 ? [] : await dependencies.evidence.getEventNeighborhood(
    limitedAnchors,
    Math.max(request.beforeEvents, 1),
    Math.max(request.afterEvents, 1),
    1_000,
  );
  const anchorsBySession = new Map<string, CanonicalEvent[]>();
  for (const anchor of anchorEvents) {
    const list = anchorsBySession.get(anchor.sessionId) ?? [];
    list.push(anchor);
    anchorsBySession.set(anchor.sessionId, list);
  }

  const normal = fetched.filter((event) => (anchorsBySession.get(event.sessionId) ?? []).some(
    (anchor) => event.ordinal >= anchor.ordinal - request.beforeEvents && event.ordinal <= anchor.ordinal + request.afterEvents,
  ));
  const pairedIds = new Set(normal.flatMap((event) => event.toolCallId === undefined ? [] : [event.toolCallId]));
  const selectedEvents = fetched.filter((event) =>
    normal.some((candidate) => candidate.id === event.id) ||
    (event.toolCallId !== undefined && pairedIds.has(event.toolCallId)),
  );

  const [finalEvents, finalChunks] = await Promise.all([
    dependencies.evidence.getEvents(selectedEvents.map((event) => event.id)),
    dependencies.evidence.getChunks(chunks.map((chunk) => chunk.id)),
  ]);
  const safeEvents: ExpandedEvidenceEvent[] = [];
  for (const event of finalEvents) {
    if (!(await eventAllowed(event, options.scope, dependencies.scopes))) continue;
    safeEvents.push(await publicEvent(event, dependencies.outputPolicy));
  }
  const publicChunks = finalChunks
    .filter((chunk) => {
      const scope = chunkScope(chunk);
      return scope !== undefined && (options.scope === undefined || scopeContains(options.scope, scope));
    })
    .map(publicChunk);
  const limits = new Set<SearchLimitKind>();
  if (anchorIds.length > limitedAnchors.length || safeEvents.length > request.budget.maxItems) limits.add("items");
  let result: ExpandedEvidenceResult = {
    chunks: publicChunks,
    events: safeEvents.slice(0, request.budget.maxItems),
    unavailableEvidenceIds: [...unavailable],
    truncation: { truncated: limits.size > 0, limitsReached: [...limits] },
  };
  result = fitResult(result, request, dependencies.tokenizer, limits);
  return result;
}

function fitResult(
  initial: ExpandedEvidenceResult,
  request: EvidenceRequest,
  tokenizer: Tokenizer | undefined,
  limits: Set<SearchLimitKind>,
): ExpandedEvidenceResult {
  let chunks = initial.chunks.slice();
  let events = initial.events.slice();
  let unavailable = initial.unavailableEvidenceIds.slice();
  while (true) {
    const candidate: ExpandedEvidenceResult = {
      chunks,
      events,
      unavailableEvidenceIds: unavailable,
      truncation: { truncated: limits.size > 0, limitsReached: [...limits] },
    };
    const serialized = JSON.stringify(candidate);
    const bytes = Buffer.byteLength(serialized);
    const tokens = countTokens(serialized, tokenizer);
    if (bytes <= request.budget.maxBytes && tokens <= request.budget.maxTokens) return candidate;
    if (bytes > request.budget.maxBytes) limits.add("bytes");
    if (tokens > request.budget.maxTokens) limits.add("tokens");
    if (events.length > 0) events = events.slice(0, -1);
    else if (chunks.length > 0) chunks = chunks.slice(0, -1);
    else if (unavailable.length > 0) unavailable = unavailable.slice(0, -1);
    else {
      throw new ContextBridgeError(ERROR_CODES.LIMIT_EXCEEDED, "Evidence metadata cannot fit the response budget", { budget: request.budget });
    }
  }
}

async function publicEvent(
  event: CanonicalEvent,
  outputPolicy: EvidenceExpansionDependencies["outputPolicy"],
): Promise<ExpandedEvidenceEvent> {
  const [text, toolCallId] = outputPolicy === undefined
    ? [event.text, event.toolCallId]
    : await Promise.all([
        outputPolicy.sanitizeText(event.text),
        event.toolCallId === undefined ? undefined : outputPolicy.sanitizeText(event.toolCallId),
      ]);
  return {
    id: event.id,
    sessionId: event.sessionId,
    ordinal: event.ordinal,
    kind: event.kind,
    ...(event.observedAt === undefined ? {} : { observedAt: event.observedAt }),
    text,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    source: {
      sourceId: event.EvidenceSource.sourceId,
      sourceOrdinal: event.EvidenceSource.sourceOrdinal,
      formatVersion: event.EvidenceSource.formatVersion,
    },
  };
}

function publicChunk(chunk: EvidenceChunk): ExpandedEvidenceChunk {
  return {
    id: chunk.id,
    scope: chunkScope(chunk)!,
    eventIds: chunk.eventIds,
    ...(chunk.omissions === undefined ? {} : { omissions: chunk.omissions }),
    ...(chunk.observedFrom === undefined ? {} : { observedFrom: chunk.observedFrom }),
    ...(chunk.observedTo === undefined ? {} : { observedTo: chunk.observedTo }),
  };
}

async function eventAllowed(
  event: CanonicalEvent,
  boundary: SearchScope | undefined,
  scopes: ScopeRepository | undefined,
): Promise<boolean> {
  if (boundary === undefined) return true;
  const session = await scopes!.getSession(event.sessionId);
  if (session === undefined) return false;
  return scopeContains(boundary, {
    projectId: session.projectId,
    ...(session.workstreamId === undefined ? {} : { workstreamId: session.workstreamId }),
    sessionId: session.id,
  });
}

function chunkScope(chunk: EvidenceChunk): SearchScope | undefined {
  return chunk.scope.projectId === undefined ? undefined : {
    projectId: chunk.scope.projectId,
    ...(chunk.scope.workstreamId === undefined ? {} : { workstreamId: chunk.scope.workstreamId }),
    sessionId: chunk.scope.sessionId,
  };
}

function countTokens(text: string, tokenizer: Tokenizer | undefined): number {
  const count = tokenizer?.count(text) ?? Buffer.byteLength(text);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Tokenizer returned an invalid token count");
  return count;
}

function validateRequest(request: EvidenceRequest): void {
  if (request.evidenceIds.length < 1 || request.evidenceIds.length > 20) throw new RangeError("Evidence requests accept from 1 to 20 IDs");
  if (!Number.isSafeInteger(request.beforeEvents) || request.beforeEvents < 0 || request.beforeEvents > 20) throw new RangeError("beforeEvents must be from 0 to 20");
  if (!Number.isSafeInteger(request.afterEvents) || request.afterEvents < 0 || request.afterEvents > 20) throw new RangeError("afterEvents must be from 0 to 20");
  for (const value of Object.values(request.budget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Invalid evidence budget");
  }
}
