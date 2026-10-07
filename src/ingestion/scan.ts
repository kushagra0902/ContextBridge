import type { CanonicalEvent } from "../contracts/evidence.js";
import type { SessionId } from "../contracts/ids.js";
import type { SessionProjectMetadata } from "../sources/git/project-mapper.js";
import { isCodexSourcePayload } from "../sources/codex/normalize.js";

import type {
  ReadLimit,
  SourceAdapter,
  SourceCursor,
  SourceReadDiagnostic,
  SourceRecord,
  SourceRef,
} from "../contracts/source.js";

import {
  decideCursorTransition,
  type IngestCursorMode,
} from "./cursor.js";

import { deduplicateEvents } from "./dedupe.js";

export interface IngestScan {
  readonly source: SourceRef;
  readonly events: readonly CanonicalEvent[];
  readonly diagnostics: readonly SourceReadDiagnostic[];
  readonly proposedCursor: SourceCursor;
  readonly cursorMode: IngestCursorMode;
  readonly hasMore: boolean;
  readonly recordsRead: number;
  readonly duplicatesCollapsed: number;
  readonly sessionMetadata: readonly SessionProjectMetadata[];
  readonly sessionTitles: readonly SessionTitleMetadata[];
}

export interface SessionTitleMetadata {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly updatedAt?: string;
}

export class IngestCursorError extends Error {
  constructor(
    readonly reason:
      | "source_mismatch"
      | "unexplained_backward_move"
      | "reader_made_no_progress",
  ) {
    super(`Unsafe ingestion cursor transition: ${reason}`);
    this.name = "IngestCursorError";
  }
}

/** Reads and normalizes one bounded source batch without committing it. */
export async function scanOnce(
  adapter: SourceAdapter, // the adpater provided by codex/adapter.ts as per the contracts. 
  source: SourceRef, // source references that are provided by source/ as per the contracts
  cursor: SourceCursor | undefined,
  limit: ReadLimit,
): Promise<IngestScan> {

  // interface function provided by the adapter's readBatch 
  // gives a source batch that has ref to the source, its records etc. 
  const batch = await adapter.readBatch(source, cursor, limit);
  const normalized: CanonicalEvent[] = [];
  for (const record of batch.records) {
    normalized.push(...(await adapter.normalize(record)));
  }
  const deduped = deduplicateEvents(normalized);
  const sessionMetadata = collectSessionMetadata(batch.records);
  const sessionTitles = collectSessionTitles(batch.records);
  const transition = decideCursorTransition(
    cursor,
    batch.proposedCursor,
    batch.diagnostics,
  );
  if (!transition.allowed) {
    throw new IngestCursorError(transition.reason);
  }
  if (
    batch.hasMore &&
    batch.proposedCursor.committedByteOffset ===
      (cursor?.committedByteOffset ?? 0)
  ) {
    throw new IngestCursorError("reader_made_no_progress");
  }

  return {
    source: batch.source,
    events: deduped.events,
    diagnostics: batch.diagnostics,
    proposedCursor: batch.proposedCursor,
    cursorMode: transition.mode,
    hasMore: batch.hasMore,
    recordsRead: batch.records.length,
    duplicatesCollapsed: deduped.duplicateEvents,
    sessionMetadata,
    sessionTitles,
  };
}

function collectSessionMetadata(
  records: readonly SourceRecord[],
): readonly SessionProjectMetadata[] {
  const sessions = new Map<string, SessionProjectMetadata>();
  for (const record of records) {
    if (!isCodexSourcePayload(record.payload)) continue;
    const payload = record.payload;
    if (
      payload.parsed.origin !== "rollout" ||
      payload.parsed.value.kind !== "session_meta"
    ) {
      continue;
    }
    const metadata = payload.parsed.value;
    sessions.set(payload.sessionId, {
      sessionId: payload.sessionId,
      ...(metadata.cwd === undefined ? {} : { cwd: metadata.cwd }),
      ...(metadata.git === undefined ? {} : { git: metadata.git }),
    });
  }
  return [...sessions.values()];
}

function collectSessionTitles(records: readonly SourceRecord[]): readonly SessionTitleMetadata[] {
  const sessions = new Map<string, SessionTitleMetadata>();
  for (const record of records) {
    if (!isCodexSourcePayload(record.payload)) continue;
    const payload = record.payload;
    if (payload.parsed.origin !== "session_index" || payload.parsed.value.title === undefined) continue;
    sessions.set(payload.sessionId, {
      sessionId: payload.sessionId,
      title: payload.parsed.value.title,
      ...(payload.parsed.value.updatedAt === undefined ? {} : { updatedAt: payload.parsed.value.updatedAt }),
    });
  }
  return [...sessions.values()];
}
