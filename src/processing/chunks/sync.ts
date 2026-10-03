import type { SessionId } from "../../contracts/ids.js";
import type { Storage } from "../../contracts/ports.js";
import type { EvidenceChunk } from "../../contracts/evidence.js";
import { buildChunks, type ChunkBuildPolicy } from "./build.js";

const DEFAULT_MAX_EVENTS = 20_000;
const DEFAULT_MAX_CHUNKS = 20_000;

export interface ChunkSyncPolicy
  extends Omit<ChunkBuildPolicy, "scope"> {
  readonly maxEvents?: number;
  readonly maxChunks?: number;
}

export interface ChunkSyncResult {
  readonly sessionId: SessionId;
  readonly eventCount: number;
  readonly chunkCount: number;
  readonly unchangedChunks: number;
  readonly upsertedChunks: number;
  readonly deletedChunks: number;
  readonly chunks: readonly EvidenceChunk[];
}

/**
 * Rebuilds one selected session and publishes only changed rows. The derived
 * repository atomically updates chunks, provenance links, FTS, and exact terms.
 */
export async function syncSessionChunks(
  storage: Storage,
  sessionId: SessionId,
  policy: ChunkSyncPolicy,
): Promise<ChunkSyncResult> {
  const session = await storage.scopes.getSession(sessionId);
  if (session === undefined) {
    throw new Error("Cannot chunk an unmapped session");
  }
  const availability = await storage.scopes.getAvailability({
    projectId: session.projectId,
    ...(session.workstreamId === undefined
      ? {}
      : { workstreamId: session.workstreamId }),
    sessionId,
  });
  if (availability !== "selected") {
    throw new Error(`Cannot chunk a session with availability ${availability}`);
  }

  const maxEvents = boundedLimit(policy.maxEvents ?? DEFAULT_MAX_EVENTS, "event");
  const maxChunks = boundedLimit(policy.maxChunks ?? DEFAULT_MAX_CHUNKS, "chunk");
  const events = await storage.evidence.listSessionEvents(
    sessionId,
    undefined,
    maxEvents + 1,
  );
  if (events.length > maxEvents) {
    throw new RangeError(`Session exceeds the ${maxEvents} event processing limit`);
  }
  const existing = await storage.evidence.listSessionChunks(sessionId, maxChunks + 1);
  if (existing.length > maxChunks) {
    throw new RangeError(`Session exceeds the ${maxChunks} chunk reconciliation limit`);
  }

  const built = buildChunks(events, {
    scope: {
      projectId: session.projectId,
      ...(session.workstreamId === undefined
        ? {}
        : { workstreamId: session.workstreamId }),
      sessionId,
    },
    targetTokens: policy.targetTokens,
    maxTokens: policy.maxTokens,
    maxToolOutputCharacters: policy.maxToolOutputCharacters,
    ...(policy.tokenizer === undefined ? {} : { tokenizer: policy.tokenizer }),
    ...(policy.chunkerVersion === undefined
      ? {}
      : { chunkerVersion: policy.chunkerVersion }),
    ...(policy.redactionVersion === undefined
      ? {}
      : { redactionVersion: policy.redactionVersion }),
  });
  const existingById = new Map(existing.map((chunk) => [chunk.id, chunk]));
  const builtIds = new Set(built.chunks.map((chunk) => chunk.id));
  const changed = built.chunks.filter((chunk) => {
    const previous = existingById.get(chunk.id);
    return previous === undefined || JSON.stringify(previous) !== JSON.stringify(chunk);
  });
  const deleted = existing
    .filter((chunk) => !builtIds.has(chunk.id))
    .map((chunk) => chunk.id);

  if (changed.length > 0 || deleted.length > 0) {
    await storage.derivedData.commit({
      upsertChunks: changed,
      deleteChunkIds: deleted,
      upsertMemories: [],
      deleteMemoryIds: [],
      embeddingJobs: [],
    });
  }
  return {
    sessionId,
    eventCount: events.length,
    chunkCount: built.chunks.length,
    unchangedChunks: built.chunks.length - changed.length,
    upsertedChunks: changed.length,
    deletedChunks: deleted.length,
    chunks: built.chunks,
  };
}

function boundedLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99_999) {
    throw new RangeError(`${label} processing limit must be from 1 to 99999`);
  }
  return value;
}
