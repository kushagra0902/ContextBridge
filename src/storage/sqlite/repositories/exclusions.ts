// Exclusions refer to scopes or sessions or work streams
// That are present in storage but should be excluded or should not be visible

// Helps in keeping the policy rules neat about scope visibility. 

import type {
  ScopeAddress,
  ScopeAvailability,
  ScopeExclusion,
} from "../../../contracts/scope.js";
import type { SqliteDatabase, SqliteRow } from "../database.js";
import { parseJson, requiredString, stringifyJson } from "../database.js";

export function scopeKey(scope: ScopeAddress): string {
  return JSON.stringify([
    scope.projectId,
    scope.workstreamId ?? null,
    scope.sessionId ?? null,
  ]);
}

export function upsertExclusion(
  database: SqliteDatabase,
  exclusion: ScopeExclusion,
): void {
  database
    .prepare(`
      INSERT INTO exclusions(
        scope_key, project_id, workstream_id, session_id, reason, status,
        blocks_ingestion, excluded_at, updated_at,
        physical_deletion_completed_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        reason = excluded.reason,
        status = excluded.status,
        blocks_ingestion = 1,
        excluded_at = excluded.excluded_at,
        updated_at = excluded.updated_at,
        physical_deletion_completed_at = excluded.physical_deletion_completed_at,
        record_json = excluded.record_json
    `)
    .run(
      scopeKey(exclusion.scope),
      exclusion.scope.projectId,
      exclusion.scope.workstreamId ?? null,
      exclusion.scope.sessionId ?? null,
      exclusion.reason,
      exclusion.status,
      exclusion.excludedAt,
      exclusion.updatedAt,
      exclusion.status === "deleted"
        ? exclusion.physicalDeletionCompletedAt
        : null,
      stringifyJson(exclusion),
    );
}

export function findMatchingExclusion(
  database: SqliteDatabase,
  scope: ScopeAddress,
): ScopeExclusion | undefined {
  const row = database
    .prepare(`
      SELECT record_json
      FROM exclusions
      WHERE project_id = ?
        AND (workstream_id IS NULL OR workstream_id = ?)
        AND (session_id IS NULL OR session_id = ?)
      ORDER BY
        CASE WHEN session_id IS NULL THEN 0 ELSE 1 END DESC,
        CASE WHEN workstream_id IS NULL THEN 0 ELSE 1 END DESC
      LIMIT 1
    `)
    .get(
      scope.projectId,
      scope.workstreamId ?? null,
      scope.sessionId ?? null,
    ) as SqliteRow | undefined;

  return row === undefined
    ? undefined
    : parseJson<ScopeExclusion>(requiredString(row, "record_json"), "exclusion");
}

export function removeExactExclusion(
  database: SqliteDatabase,
  scope: ScopeAddress,
): boolean {
  const result = database
    .prepare("DELETE FROM exclusions WHERE scope_key = ?")
    .run(scopeKey(scope));
  return result.changes > 0;
}

export function scopeAvailability(
  database: SqliteDatabase,
  scope: ScopeAddress,
): ScopeAvailability {
  return findMatchingExclusion(database, scope)?.status ?? "selected";
}

export const VISIBLE_SCOPE_SQL = `
  NOT EXISTS (
    SELECT 1
    FROM exclusions AS blocked
    WHERE blocked.project_id = search_content.project_id
      AND (blocked.workstream_id IS NULL OR blocked.workstream_id = search_content.workstream_id)
      AND (blocked.session_id IS NULL OR blocked.session_id = search_content.session_id)
  )
`;

