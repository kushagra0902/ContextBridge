// This provides SQL abstraction for source related operations

import type { SourceStateRepository } from "../../../contracts/ports.js";
import type { SourceId } from "../../../contracts/ids.js";
import type { SourceCursor, SourceRef } from "../../../contracts/source.js";
import type { SqliteDatabase, SqliteRow } from "../database.js";
import {
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  stringifyJson,
} from "../database.js";
import type { StorageExecutor } from "../executor.js";
import { withTransaction } from "../transaction.js";

export class SqliteSourceStateRepository implements SourceStateRepository {
  constructor(private readonly executor: StorageExecutor) {}

  listSources(): Promise<readonly SourceRef[]> {
    return this.executor.execute("sources.list");
  }

  upsertSources(sources: readonly SourceRef[]): Promise<void> {
    return this.executor.execute("sources.upsert", sources);
  }

  getCursor(sourceId: SourceId): Promise<SourceCursor | undefined> {
    return this.executor.execute("sources.getCursor", sourceId);
  }
}

export function handleSourcesOperation(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  switch (operation) {
    case "sources.list":
      return listSources(database);
    case "sources.upsert":
      upsertSources(database, argument as readonly SourceRef[]);
      return undefined;
    case "sources.getCursor":
      return getCursor(database, argument as SourceId);
    default:
      throw new Error(`Unknown source repository operation: ${operation}`);
  }
}

export function listSources(database: SqliteDatabase): readonly SourceRef[] {
  const rows = database
    .prepare("SELECT record_json FROM sources ORDER BY normalized_path, source_id")
    .all() as SqliteRow[];
  return rows.map((row) =>
    parseJson<SourceRef>(requiredString(row, "record_json"), "source"),
  );
}

export function upsertSources(
  database: SqliteDatabase,
  sources: readonly SourceRef[],
): void {
  withTransaction(database, () => {
    for (const source of sources) {
      upsertSource(database, source);
    }
  });
}

export function upsertSource(
  database: SqliteDatabase,
  source: SourceRef,
  now = new Date().toISOString(),
): void {
  validateSource(source);
  database
    .prepare(`
      INSERT INTO sources(
        source_id, kind, normalized_path, format_version, device, inode,
        size, modified_at_ms, last_seen_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        kind = excluded.kind,
        normalized_path = excluded.normalized_path,
        format_version = excluded.format_version,
        device = excluded.device,
        inode = excluded.inode,
        size = excluded.size,
        modified_at_ms = excluded.modified_at_ms,
        last_seen_at = excluded.last_seen_at,
        record_json = excluded.record_json
    `)
    .run(
      source.id,
      source.kind,
      source.normalizedPath,
      source.formatVersion,
      source.fileIdentity.device ?? null,
      source.fileIdentity.inode ?? null,
      source.fileIdentity.size,
      source.fileIdentity.modifiedAtMs,
      now,
      stringifyJson(source),
    );
}

export function getCursor(
  database: SqliteDatabase,
  sourceId: SourceId,
): SourceCursor | undefined {
  const row = database
    .prepare(`
      SELECT source_id, file_fingerprint, committed_byte_offset,
             last_complete_line_hash
      FROM source_cursors
      WHERE source_id = ?
    `)
    .get(sourceId) as SqliteRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const lastCompleteLineHash = optionalString(row, "last_complete_line_hash");
  return {
    sourceId: requiredString(row, "source_id") as SourceId,
    fileFingerprint: requiredString(row, "file_fingerprint"),
    committedByteOffset: requiredNumber(row, "committed_byte_offset"),
    ...(lastCompleteLineHash === undefined ? {} : { lastCompleteLineHash }),
  };
}

export function writeCursor(
  database: SqliteDatabase,
  cursor: SourceCursor,
  now = new Date().toISOString(),
): void {
  const current = getCursor(database, cursor.sourceId);
  if (
    current !== undefined &&
    current.fileFingerprint === cursor.fileFingerprint &&
    cursor.committedByteOffset < current.committedByteOffset
  ) {
    throw new RangeError("A source cursor cannot move backwards for the same file");
  }

  database
    .prepare(`
      INSERT INTO source_cursors(
        source_id, file_fingerprint, committed_byte_offset,
        last_complete_line_hash, committed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        file_fingerprint = excluded.file_fingerprint,
        committed_byte_offset = excluded.committed_byte_offset,
        last_complete_line_hash = excluded.last_complete_line_hash,
        committed_at = excluded.committed_at
    `)
    .run(
      cursor.sourceId,
      cursor.fileFingerprint,
      cursor.committedByteOffset,
      cursor.lastCompleteLineHash ?? null,
      now,
    );
}

function validateSource(source: SourceRef): void {
  if (
    !Number.isSafeInteger(source.fileIdentity.size) ||
    source.fileIdentity.size < 0 ||
    !Number.isFinite(source.fileIdentity.modifiedAtMs) ||
    source.fileIdentity.modifiedAtMs < 0
  ) {
    throw new RangeError("Invalid source file identity");
  }
  if (source.normalizedPath.length === 0 || source.normalizedPath.includes("\0")) {
    throw new TypeError("Invalid source path");
  }
}

