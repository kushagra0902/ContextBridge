import type { RankedCandidate, SearchFilters } from "../../contracts/search.js";
import type { ChunkId, MemoryId, ProjectId, SessionId, WorkstreamId } from "../../contracts/ids.js";
import type { SqliteDatabase, SqliteRow } from "./database.js";
import { optionalString, requiredNumber, requiredString } from "./database.js";

const MAX_QUERY_LENGTH = 2_048;
const MAX_QUERY_TERMS = 32;

export function escapeFtsQuery(query: string): string {
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH || /\0/u.test(query)) {
    throw new TypeError("Invalid FTS query");
  }
  const terms = query
    .normalize("NFKC")
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) {
    throw new TypeError("FTS query must contain searchable text");
  }
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

export function searchFts(
  database: SqliteDatabase,
  query: string,
  filters: SearchFilters,
  limit: number,
): readonly RankedCandidate[] {
  validateLimit(limit);
  const where = buildSearchWhere(filters);
  const expression = escapeFtsQuery(query);
  const rows = database
    .prepare(`
      SELECT
        search_content.entity_kind,
        search_content.entity_id,
        search_content.project_id,
        search_content.workstream_id,
        search_content.session_id,
        search_content.fingerprint,
        bm25(search_fts, 3.0, 1.0) AS score
      FROM search_fts
      JOIN search_content ON search_content.rowid = search_fts.rowid
      LEFT JOIN sessions ON sessions.session_id = search_content.session_id
      WHERE search_fts MATCH ?
        AND ${visibleSearchContentSql()}
        ${where.sql}
      ORDER BY score, search_content.rowid
      LIMIT ?
    `)
    .all(expression, ...where.parameters, limit) as SqliteRow[];
  return rows.flatMap((row, index) => {
    const candidate = rowToCandidate(row, "fts", index + 1);
    return candidate === undefined ? [] : [candidate];
  });
}

export function rebuildFts(database: SqliteDatabase): void {
  database.prepare("INSERT INTO search_fts(search_fts) VALUES ('rebuild')").run();
}

export interface SearchWhere {
  readonly sql: string;
  readonly parameters: readonly (string | number | null)[];
}

export function buildSearchWhere(filters: SearchFilters): SearchWhere {
  const clauses: string[] = [];
  const parameters: (string | number | null)[] = [];
  const scope = filters.scope;
  if (scope !== undefined) {
    clauses.push("AND search_content.project_id = ?");
    parameters.push(scope.projectId);
    if (scope.workstreamId !== undefined) {
      clauses.push("AND search_content.workstream_id = ?");
      parameters.push(scope.workstreamId);
    }
    if (scope.sessionId !== undefined) {
      clauses.push("AND search_content.session_id = ?");
      parameters.push(scope.sessionId);
    }
  }
  if (filters.memoryTypes !== undefined && filters.memoryTypes.length > 0) {
    clauses.push(
      `AND search_content.hit_type IN (${filters.memoryTypes.map(() => "?").join(", ")})`,
    );
    parameters.push(...filters.memoryTypes);
  }
  if (filters.timeRange?.from !== undefined) {
    clauses.push("AND search_content.observed_at >= ?");
    parameters.push(filters.timeRange.from);
  }
  if (filters.timeRange?.to !== undefined) {
    clauses.push("AND search_content.observed_at <= ?");
    parameters.push(filters.timeRange.to);
  }
  if (filters.branch !== undefined) {
    clauses.push("AND sessions.branch = ?");
    parameters.push(filters.branch);
  }
  if (filters.paths !== undefined && filters.paths.length > 0) {
    clauses.push(`AND EXISTS (
      SELECT 1 FROM exact_terms AS path_terms
      WHERE path_terms.entity_kind = search_content.entity_kind
        AND path_terms.entity_id = search_content.entity_id
        AND path_terms.term_kind = 'path'
        AND path_terms.normalized_term IN (${filters.paths.map(() => "?").join(", ")})
    )`);
    parameters.push(...filters.paths.map(normalizeExactTerm));
  }
  return { sql: clauses.join("\n"), parameters };
}

export function visibleSearchContentSql(): string {
  return `NOT EXISTS (
    SELECT 1 FROM exclusions AS blocked
    WHERE blocked.project_id = search_content.project_id
      AND (blocked.workstream_id IS NULL OR blocked.workstream_id = search_content.workstream_id)
      AND (blocked.session_id IS NULL OR blocked.session_id = search_content.session_id)
  )`;
}

export function rowToCandidate(
  row: SqliteRow,
  channel: "fts" | "exact",
  rank: number,
): RankedCandidate | undefined {
  const projectId = optionalString(row, "project_id");
  if (projectId === undefined) {
    return undefined;
  }
  const entityKind = requiredString(row, "entity_kind");
  const entityId = requiredString(row, "entity_id");
  const workstreamId = optionalString(row, "workstream_id");
  const sessionId = optionalString(row, "session_id");
  const fingerprint = optionalString(row, "fingerprint");
  const score = row.score;
  return {
    entity: entityKind === "chunk"
      ? { kind: "chunk", id: entityId as ChunkId }
      : { kind: "memory", id: entityId as MemoryId },
    scope: {
      projectId: projectId as ProjectId,
      ...(workstreamId === undefined
        ? {}
        : { workstreamId: workstreamId as WorkstreamId }),
      ...(sessionId === undefined ? {} : { sessionId: sessionId as SessionId }),
    },
    channel,
    rank,
    ...(typeof score === "number" ? { rawScore: -score } : {}),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

export function normalizeExactTerm(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Search limit must be from 1 to 1000");
  }
}

