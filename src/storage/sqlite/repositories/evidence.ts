import type {
  CanonicalBatch,
  CommitBatchOptions,
  CommitResult,
  EvidenceRepository,
} from "../../../contracts/ports.js";
import type { ChunkId, EventId, SessionId } from "../../../contracts/ids.js";
import type { CanonicalEvent, EvidenceChunk } from "../../../contracts/evidence.js";
import type { SourceCursor } from "../../../contracts/source.js";
import type { SqliteDatabase, SqliteRow } from "../database.js";
import { parseJson, requiredString, stringifyJson } from "../database.js";
import type { StorageExecutor } from "../executor.js";
import { withTransaction } from "../transaction.js";
import { upsertSource, writeCursor } from "./sources.js";

interface CommitArgument {
  readonly batch: CanonicalBatch;
  readonly nextCursor: SourceCursor;
  readonly options?: CommitBatchOptions;
}

interface NeighborhoodArgument {
  readonly ids: readonly EventId[];
  readonly before: number;
  readonly after: number;
  readonly limit: number;
}

export class SqliteEvidenceRepository implements EvidenceRepository {
  constructor(private readonly executor: StorageExecutor) {}

  commitBatch(
    batch: CanonicalBatch,
    nextCursor: SourceCursor,
    options: CommitBatchOptions = {},
  ): Promise<CommitResult> {
    return this.executor.execute("evidence.commitBatch", {
      batch,
      nextCursor,
      options,
    });
  }

  getEvents(ids: readonly EventId[]): Promise<readonly CanonicalEvent[]> {
    return this.executor.execute("evidence.getEvents", ids);
  }

  getChunks(ids: readonly ChunkId[]): Promise<readonly EvidenceChunk[]> {
    return this.executor.execute("evidence.getChunks", ids);
  }

  listSessionEvents(
    sessionId: SessionId,
    afterOrdinal: number | undefined,
    limit: number,
  ): Promise<readonly CanonicalEvent[]> {
    return this.executor.execute("evidence.listSessionEvents", {
      sessionId,
      afterOrdinal,
      limit,
    });
  }

  getEventNeighborhood(
    ids: readonly EventId[],
    before: number,
    after: number,
    limit: number,
  ): Promise<readonly CanonicalEvent[]> {
    return this.executor.execute("evidence.getEventNeighborhood", {
      ids,
      before,
      after,
      limit,
    });
  }
}

export function handleEvidenceOperation(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  switch (operation) {
    case "evidence.commitBatch": {
      const input = argument as CommitArgument;
      return commitBatch(database, input.batch, input.nextCursor, input.options);
    }
    case "evidence.getEvents":
      return getEvents(database, argument as readonly EventId[]);
    case "evidence.getChunks":
      return getChunks(database, argument as readonly ChunkId[]);
    case "evidence.listSessionEvents": {
      const input = argument as {
        sessionId: SessionId;
        afterOrdinal?: number;
        limit: number;
      };
      return listSessionEvents(
        database,
        input.sessionId,
        input.afterOrdinal,
        input.limit,
      );
    }
    case "evidence.getEventNeighborhood": {
      const input = argument as NeighborhoodArgument;
      return getEventNeighborhood(
        database,
        input.ids,
        input.before,
        input.after,
        input.limit,
      );
    }
    default:
      throw new Error(`Unknown evidence repository operation: ${operation}`);
  }
}

export function commitBatch(
  database: SqliteDatabase,
  batch: CanonicalBatch,
  nextCursor: SourceCursor,
  options: CommitBatchOptions = {},
): CommitResult {
  if (
    options.cursorMode !== undefined &&
    options.cursorMode !== "append" &&
    options.cursorMode !== "replay"
  ) {
    throw new TypeError("Invalid source cursor commit mode");
  }
  if (nextCursor.sourceId !== batch.source.id) {
    throw new TypeError("Cursor source does not match canonical batch source");
  }
  if (!Number.isSafeInteger(nextCursor.committedByteOffset) || nextCursor.committedByteOffset < 0) {
    throw new RangeError("Invalid committed source byte offset");
  }
  if (nextCursor.committedByteOffset > batch.source.fileIdentity.size) {
    throw new RangeError("Committed source cursor exceeds the observed file size");
  }

  return withTransaction(database, () => {
    upsertSource(database, batch.source);
    let insertedEvents = 0;
    let duplicateEvents = 0;

    for (const event of batch.events) {
      validateEvent(event, batch);
      const result = database
        .prepare(`
          INSERT INTO events(
            event_id, session_id, ordinal, kind, observed_at, text,
            content_hash, source_id, source_ordinal, byte_start, byte_end,
            format_version, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO NOTHING
        `)
        .run(
          event.id,
          event.sessionId,
          event.ordinal,
          event.kind,
          event.observedAt ?? null,
          event.text,
          event.contentHash,
          event.EvidenceSource.sourceId,
          event.EvidenceSource.sourceOrdinal,
          event.EvidenceSource.byteStart ?? null,
          event.EvidenceSource.byteEnd ?? null,
          event.EvidenceSource.formatVersion,
          stringifyJson(event),
        );

      if (result.changes === 1) {
        insertedEvents += 1;
      } else {
        assertDuplicateMatches(database, event);
        duplicateEvents += 1;
      }
    }

    writeCursor(database, nextCursor, {
      allowBackward: options.cursorMode === "replay",
    });
    return { insertedEvents, duplicateEvents, committedCursor: nextCursor };
  });
}

export function getEvents(
  database: SqliteDatabase,
  ids: readonly EventId[],
): readonly CanonicalEvent[] {
  if (ids.length === 0) {
    return [];
  }
  enforceLimit(ids.length, 1, 1_000, "event IDs");
  const placeholders = ids.map(() => "?").join(", ");
  const rows = database
    .prepare(`
      SELECT events.event_id, events.record_json
      FROM events
      LEFT JOIN sessions ON sessions.session_id = events.session_id
      WHERE events.event_id IN (${placeholders})
        AND (
          sessions.project_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM exclusions AS blocked
            WHERE blocked.project_id = sessions.project_id
              AND (blocked.workstream_id IS NULL OR blocked.workstream_id = sessions.workstream_id)
              AND (blocked.session_id IS NULL OR blocked.session_id = sessions.session_id)
          )
        )
    `)
    .all(...ids) as SqliteRow[];
  const byId = new Map(
    rows.map((row) => [
      requiredString(row, "event_id"),
      parseJson<CanonicalEvent>(requiredString(row, "record_json"), "event"),
    ]),
  );
  return ids.flatMap((id) => {
    const event = byId.get(id);
    return event === undefined ? [] : [event];
  });
}

export function getChunks(
  database: SqliteDatabase,
  ids: readonly ChunkId[],
): readonly EvidenceChunk[] {
  if (ids.length === 0) {
    return [];
  }
  enforceLimit(ids.length, 1, 1_000, "chunk IDs");
  const placeholders = ids.map(() => "?").join(", ");
  const rows = database
    .prepare(`
      SELECT chunk_id, record_json
      FROM chunks
      WHERE chunk_id IN (${placeholders})
        AND (
          project_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM exclusions AS blocked
            WHERE blocked.project_id = chunks.project_id
              AND (blocked.workstream_id IS NULL OR blocked.workstream_id = chunks.workstream_id)
              AND (blocked.session_id IS NULL OR blocked.session_id = chunks.session_id)
          )
        )
    `)
    .all(...ids) as SqliteRow[];
  const byId = new Map(
    rows.map((row) => [
      requiredString(row, "chunk_id"),
      parseJson<EvidenceChunk>(requiredString(row, "record_json"), "chunk"),
    ]),
  );
  return ids.flatMap((id) => {
    const chunk = byId.get(id);
    return chunk === undefined ? [] : [chunk];
  });
}

export function listSessionEvents(
  database: SqliteDatabase,
  sessionId: SessionId,
  afterOrdinal: number | undefined,
  limit: number,
): readonly CanonicalEvent[] {
  enforceLimit(limit, 1, 1_000, "event limit");
  if (afterOrdinal !== undefined && (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0)) {
    throw new RangeError("Invalid event ordinal");
  }
  const rows = database
    .prepare(`
      SELECT events.record_json
      FROM events
      LEFT JOIN sessions ON sessions.session_id = events.session_id
      WHERE events.session_id = ?
        AND (? IS NULL OR events.ordinal > ?)
        AND (
          sessions.project_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM exclusions AS blocked
            WHERE blocked.project_id = sessions.project_id
              AND (blocked.workstream_id IS NULL OR blocked.workstream_id = sessions.workstream_id)
              AND (blocked.session_id IS NULL OR blocked.session_id = sessions.session_id)
          )
        )
      ORDER BY events.ordinal, events.event_id
      LIMIT ?
    `)
    .all(
      sessionId,
      afterOrdinal ?? null,
      afterOrdinal ?? null,
      limit,
    ) as SqliteRow[];
  return rows.map((row) =>
    parseJson<CanonicalEvent>(requiredString(row, "record_json"), "event"),
  );
}

export function getEventNeighborhood(
  database: SqliteDatabase,
  ids: readonly EventId[],
  before: number,
  after: number,
  limit: number,
): readonly CanonicalEvent[] {
  enforceLimit(ids.length, 1, 100, "anchor event IDs");
  enforceLimit(before, 0, 100, "events before");
  enforceLimit(after, 0, 100, "events after");
  enforceLimit(limit, 1, 1_000, "event limit");

  const anchors = getEvents(database, ids);
  const found = new Map<string, CanonicalEvent>();
  for (const anchor of anchors) {
    const rows = database
      .prepare(`
        SELECT record_json
        FROM events
        WHERE session_id = ? AND ordinal BETWEEN ? AND ?
        ORDER BY ordinal, event_id
      `)
      .all(
        anchor.sessionId,
        Math.max(0, anchor.ordinal - before),
        anchor.ordinal + after,
      ) as SqliteRow[];
    for (const row of rows) {
      const event = parseJson<CanonicalEvent>(
        requiredString(row, "record_json"),
        "event",
      );
      found.set(event.id, event);
    }
  }

  return [...found.values()]
    .sort((left, right) =>
      left.sessionId === right.sessionId
        ? left.ordinal - right.ordinal || left.id.localeCompare(right.id)
        : left.sessionId.localeCompare(right.sessionId),
    )
    .slice(0, limit);
}

function validateEvent(event: CanonicalEvent, batch: CanonicalBatch): void {
  if (event.EvidenceSource.sourceId !== batch.source.id) {
    throw new TypeError("Event source does not match canonical batch source");
  }
  if (
    !Number.isSafeInteger(event.ordinal) ||
    event.ordinal < 0 ||
    !Number.isSafeInteger(event.EvidenceSource.sourceOrdinal) ||
    event.EvidenceSource.sourceOrdinal < 0
  ) {
    throw new RangeError("Invalid event ordinal");
  }
  if (
    event.EvidenceSource.byteEnd !== undefined &&
    event.EvidenceSource.byteEnd > batch.source.fileIdentity.size
  ) {
    throw new RangeError("Event provenance exceeds the observed source file");
  }
}

function assertDuplicateMatches(
  database: SqliteDatabase,
  event: CanonicalEvent,
): void {
  const row = database
    .prepare(`
      SELECT session_id, content_hash, source_id, source_ordinal
      FROM events WHERE event_id = ?
    `)
    .get(event.id) as SqliteRow | undefined;
  if (
    row === undefined ||
    row.session_id !== event.sessionId ||
    row.content_hash !== event.contentHash ||
    row.source_id !== event.EvidenceSource.sourceId ||
    row.source_ordinal !== event.EvidenceSource.sourceOrdinal
  ) {
    throw new Error("Stable event ID collision with different evidence");
  }
}

function enforceLimit(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}`);
  }
}
