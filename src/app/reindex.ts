import type { SessionId } from "../contracts/ids.js";
import type { ScopeAddress } from "../contracts/scope.js";
import { scopeAddress, scopeContains } from "../contracts/scope.js";
import type { Storage } from "../contracts/ports.js";
import {
  syncSessionChunks,
  type ChunkSyncPolicy,
} from "../processing/chunks/index.js";
import {
  syncSessionMemories,
  type MemorySyncOptions,
} from "../processing/memory/index.js";

export interface ReindexInput {
  readonly scope: ScopeAddress;
  readonly chunkPolicy: ChunkSyncPolicy;
  readonly maxSessions?: number;
}

export interface ReindexDependencies {
  readonly storage: Storage;
  readonly memoryOptions?: MemorySyncOptions;
}

export interface ReindexedSession {
  readonly sessionId: SessionId;
  readonly status: "ok" | "failed";
  readonly events?: number;
  readonly chunks?: number;
  readonly memories?: number;
  readonly upsertedChunks?: number;
  readonly deletedChunks?: number;
  readonly upsertedMemories?: number;
  readonly deletedMemories?: number;
  readonly errorCode?: string;
}

export interface ReindexResult {
  readonly status: "ok" | "partial" | "not_found" | "scope_excluded";
  readonly scope: ScopeAddress;
  readonly sessions: readonly ReindexedSession[];
  readonly truncated: boolean;
}

/** Rebuilds derived SQLite rows from retained canonical evidence only. */
export async function reindex(
  input: ReindexInput,
  dependencies: ReindexDependencies,
): Promise<ReindexResult> {
  const scope = await dependencies.storage.scopes.get(input.scope);
  if (scope === undefined) return { status: "not_found", scope: input.scope, sessions: [], truncated: false };
  const boundary = scopeAddress(scope);
  const availability = await dependencies.storage.scopes.getAvailability(boundary);
  if (availability !== "selected") {
    return { status: "scope_excluded", scope: boundary, sessions: [], truncated: false };
  }
  const maxSessions = boundedSessions(input.maxSessions ?? 1_000);
  let sessionIds: SessionId[];
  let truncated = false;
  if (scope.kind === "session") {
    sessionIds = [scope.id];
  } else {
    const candidates = await dependencies.storage.scopes.listCandidates(undefined, 1_000);
    const matching = candidates
      .filter((candidate) => candidate.scope.kind === "session")
      .filter((candidate) => candidate.availability === "selected")
      .filter((candidate) => scopeContains(boundary, scopeAddress(candidate.scope)))
      .map((candidate) => (candidate.scope as Extract<typeof candidate.scope, { kind: "session" }>).id);
    truncated = matching.length > maxSessions || candidates.length === 1_000;
    sessionIds = matching.slice(0, maxSessions);
  }
  const sessions: ReindexedSession[] = [];
  for (const sessionId of sessionIds) {
    try {
      const chunks = await syncSessionChunks(dependencies.storage, sessionId, input.chunkPolicy);
      const memories = await syncSessionMemories(dependencies.storage, sessionId, dependencies.memoryOptions);
      sessions.push({
        sessionId,
        status: "ok",
        events: chunks.eventCount,
        chunks: chunks.chunkCount,
        memories: memories.memoryCount,
        upsertedChunks: chunks.upsertedChunks,
        deletedChunks: chunks.deletedChunks,
        upsertedMemories: memories.upsertedMemories,
        deletedMemories: memories.deletedMemories,
      });
    } catch (error) {
      sessions.push({
        sessionId,
        status: "failed",
        errorCode: error instanceof RangeError ? "LIMIT_EXCEEDED" : "REINDEX_FAILED",
      });
    }
  }
  return {
    status: sessions.some((session) => session.status === "failed") || truncated ? "partial" : "ok",
    scope: boundary,
    sessions,
    truncated,
  };
}

function boundedSessions(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("Reindex session limit must be from 1 to 1000");
  }
  return value;
}
