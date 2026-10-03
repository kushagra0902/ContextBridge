// This file manages the scopes of projects workstreams and sessions in a hierarchial
// fashion. In other words it checks if a project , a workstream and a session exists
// their referential constraints etc. 

import { createHash } from "node:crypto";

import type { ScopeRepository } from "../../../contracts/ports.js";
import type { SessionId } from "../../../contracts/ids.js";

import type {
  ExplicitScopeMapping,
  ScopeAddress,
  ScopeAlias,
  ScopeCandidate,
  ScopeExclusion,
  ScopeRef,
  SessionRef,
} from "../../../contracts/scope.js";

import type { SqliteDatabase, SqliteRow } from "../database.js";
import { parseJson, requiredString, stringifyJson } from "../database.js";
import type { StorageExecutor } from "../executor.js";
import { withTransaction } from "../transaction.js";

import {
  findMatchingExclusion,
  removeExactExclusion,
  scopeAvailability,
  scopeKey,
  upsertExclusion,
} from "./exclusions.js";


export class SqliteScopeRepository implements ScopeRepository {
  constructor(private readonly executor: StorageExecutor) {}
  
  // Get the scope being refered or requrested, or multiple refs to the scope
  // in case of hierarchial scope is requested. 

  get(scope: ScopeAddress): Promise<ScopeRef | undefined> {
    return this.executor.execute("scopes.get", scope);
  }

  getSession(sessionId: SessionId): Promise<SessionRef | undefined> {
    return this.executor.execute("scopes.getSession", sessionId);
  }

  listCandidates(
    query: string | undefined,
    limit: number,
  ): Promise<readonly ScopeCandidate[]> {
    return this.executor.execute("scopes.listCandidates", { query, limit });
  }

  // Find the aliases to the scopes defined. 
  findAliases(
    normalizedAlias: string,
    limit: number,
  ): Promise<readonly ScopeAlias[]> {
    return this.executor.execute("scopes.findAliases", {
      normalizedAlias,
      limit,
    });
  }

  getExplicitMappings(
    sessionId?: SessionId,
  ): Promise<readonly ExplicitScopeMapping[]> {
    return this.executor.execute("scopes.getExplicitMappings", sessionId);
  }

  getExclusion(scope: ScopeAddress): Promise<ScopeExclusion | undefined> {
    return this.executor.execute("scopes.getExclusion", scope);
  }

  getAvailability(scope: ScopeAddress) {
    return this.executor.execute<ReturnType<typeof scopeAvailability>>(
      "scopes.getAvailability",
      scope,
    );
  }

  upsertScopes(scopes: readonly ScopeRef[]): Promise<void> {
    return this.executor.execute("scopes.upsertScopes", scopes);
  }

  upsertAliases(aliases: readonly ScopeAlias[]): Promise<void> {
    return this.executor.execute("scopes.upsertAliases", aliases);
  }

  upsertExplicitMappings(
    mappings: readonly ExplicitScopeMapping[],
  ): Promise<void> {
    return this.executor.execute("scopes.upsertExplicitMappings", mappings);
  }

  upsertExclusion(exclusion: ScopeExclusion): Promise<void> {
    return this.executor.execute("scopes.upsertExclusion", exclusion);
  }

  removeExclusion(scope: ScopeAddress): Promise<boolean> {
    return this.executor.execute("scopes.removeExclusion", scope);
  }
}

export function handleProjectsOperation(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  switch (operation) {
    case "scopes.get":
      return getScope(database, argument as ScopeAddress);
    case "scopes.getSession":
      return getSession(database, argument as SessionId);
    case "scopes.listCandidates": {
      const input = argument as { query?: string; limit: number };
      return listCandidates(database, input.query, input.limit);
    }
    case "scopes.findAliases": {
      const input = argument as { normalizedAlias: string; limit: number };
      return findAliases(database, input.normalizedAlias, input.limit);
    }
    case "scopes.getExplicitMappings":
      return getExplicitMappings(database, argument as SessionId | undefined);
    case "scopes.getExclusion":
      return findMatchingExclusion(database, argument as ScopeAddress);
    case "scopes.getAvailability":
      return scopeAvailability(database, argument as ScopeAddress);
    case "scopes.upsertScopes":
      upsertScopes(database, argument as readonly ScopeRef[]);
      return undefined;
    case "scopes.upsertAliases":
      upsertAliases(database, argument as readonly ScopeAlias[]);
      return undefined;
    case "scopes.upsertExplicitMappings":
      upsertExplicitMappings(database, argument as readonly ExplicitScopeMapping[]);
      return undefined;
    case "scopes.upsertExclusion":
      upsertExclusion(database, argument as ScopeExclusion);
      return undefined;
    case "scopes.removeExclusion":
      return removeExactExclusion(database, argument as ScopeAddress);
    default:
      throw new Error(`Unknown scope repository operation: ${operation}`);
  }
}

export function getSession(
  database: SqliteDatabase,
  sessionId: SessionId,
): SessionRef | undefined {
  const row = database
    .prepare("SELECT record_json FROM sessions WHERE session_id = ?")
    .get(sessionId) as SqliteRow | undefined;
  return row === undefined
    ? undefined
    : parseJson<SessionRef>(requiredString(row, "record_json"), "session scope");
}

export function getScope(
  database: SqliteDatabase,
  scope: ScopeAddress,
): ScopeRef | undefined {
  let row: SqliteRow | undefined;
  if (scope.sessionId !== undefined) {
    row = database
      .prepare(`
        SELECT record_json FROM sessions
        WHERE session_id = ? AND project_id = ?
          AND (? IS NULL OR workstream_id = ?)
      `)
      .get(
        scope.sessionId,
        scope.projectId,
        scope.workstreamId ?? null,
        scope.workstreamId ?? null,
      ) as SqliteRow | undefined;
  } else if (scope.workstreamId !== undefined) {
    row = database
      .prepare(`
        SELECT record_json FROM workstreams
        WHERE workstream_id = ? AND project_id = ?
      `)
      .get(scope.workstreamId, scope.projectId) as SqliteRow | undefined;
  } else {
    row = database
      .prepare("SELECT record_json FROM projects WHERE project_id = ?")
      .get(scope.projectId) as SqliteRow | undefined;
  }
  return row === undefined
    ? undefined
    : parseJson<ScopeRef>(requiredString(row, "record_json"), "scope");
}

export function upsertScopes(
  database: SqliteDatabase,
  scopes: readonly ScopeRef[],
): void {
  withTransaction(database, () => {
    for (const scope of scopes) {
      switch (scope.kind) {
        case "project":
          database
            .prepare(`
              INSERT INTO projects(project_id, display_name, last_activity_at, record_json)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(project_id) DO UPDATE SET
                display_name = excluded.display_name,
                last_activity_at = excluded.last_activity_at,
                record_json = excluded.record_json
            `)
            .run(
              scope.id,
              scope.displayName,
              scope.lastActivityAt ?? null,
              stringifyJson(scope),
            );
          break;
        case "workstream":
          assertProjectExists(database, scope.projectId);
          database
            .prepare(`
              INSERT INTO workstreams(
                workstream_id, project_id, display_name, branch, issue_id,
                last_activity_at, record_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(workstream_id) DO UPDATE SET
                project_id = excluded.project_id,
                display_name = excluded.display_name,
                branch = excluded.branch,
                issue_id = excluded.issue_id,
                last_activity_at = excluded.last_activity_at,
                record_json = excluded.record_json
            `)
            .run(
              scope.id,
              scope.projectId,
              scope.displayName,
              scope.branch ?? null,
              scope.issueId ?? null,
              scope.lastActivityAt ?? null,
              stringifyJson(scope),
            );
          break;
        case "session":
          assertProjectExists(database, scope.projectId);
          if (scope.workstreamId !== undefined) {
            assertWorkstreamBelongsToProject(
              database,
              scope.workstreamId,
              scope.projectId,
            );
          }
          database
            .prepare(`
              INSERT INTO sessions(
                session_id, project_id, workstream_id, title, branch,
                head_commit, started_at, last_activity_at, record_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET
                project_id = excluded.project_id,
                workstream_id = excluded.workstream_id,
                title = excluded.title,
                branch = excluded.branch,
                head_commit = excluded.head_commit,
                started_at = excluded.started_at,
                last_activity_at = excluded.last_activity_at,
                record_json = excluded.record_json
            `)
            .run(
              scope.id,
              scope.projectId,
              scope.workstreamId ?? null,
              scope.title ?? null,
              scope.branch ?? null,
              scope.headCommit ?? null,
              scope.startedAt ?? null,
              scope.lastActivityAt ?? null,
              stringifyJson(scope),
            );
          break;
      }
    }
  });
}

export function upsertAliases(
  database: SqliteDatabase,
  aliases: readonly ScopeAlias[],
): void {
  withTransaction(database, () => {
    for (const alias of aliases) {
      if (getScope(database, alias.target) === undefined) {
        throw new Error("Alias target scope does not exist");
      }
      const key = digestKey([
        alias.normalizedValue,
        scopeKey(alias.target),
        alias.source,
      ]);
      database
        .prepare(`
          INSERT INTO aliases(
            alias_key, value, normalized_value, project_id, workstream_id,
            session_id, source, created_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(alias_key) DO UPDATE SET
            value = excluded.value,
            normalized_value = excluded.normalized_value,
            created_at = excluded.created_at,
            record_json = excluded.record_json
        `)
        .run(
          key,
          alias.value,
          alias.normalizedValue,
          alias.target.projectId,
          alias.target.workstreamId ?? null,
          alias.target.sessionId ?? null,
          alias.source,
          alias.createdAt,
          stringifyJson(alias),
        );
    }
  });
}

export function findAliases(
  database: SqliteDatabase,
  normalizedAlias: string,
  limit: number,
): readonly ScopeAlias[] {
  validateLimit(limit);
  const rows = database
    .prepare(`
      SELECT record_json FROM aliases
      WHERE normalized_value = ?
      ORDER BY created_at DESC, alias_key
      LIMIT ?
    `)
    .all(normalizedAlias, limit) as SqliteRow[];
  return rows.map((row) =>
    parseJson<ScopeAlias>(requiredString(row, "record_json"), "scope alias"),
  );
}

export function upsertExplicitMappings(
  database: SqliteDatabase,
  mappings: readonly ExplicitScopeMapping[],
): void {
  withTransaction(database, () => {
    for (const mapping of mappings) {
      assertProjectExists(database, mapping.target.projectId);
      if (mapping.target.workstreamId !== undefined) {
        assertWorkstreamBelongsToProject(
          database,
          mapping.target.workstreamId,
          mapping.target.projectId,
        );
      }
      const selectorValue = selectorValueOf(mapping);
      const selectorKey = digestKey([mapping.selector.kind, selectorValue]);
      database
        .prepare(`
          INSERT INTO explicit_mappings(
            selector_key, selector_kind, selector_value, project_id,
            workstream_id, created_at, updated_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(selector_key) DO UPDATE SET
            project_id = excluded.project_id,
            workstream_id = excluded.workstream_id,
            updated_at = excluded.updated_at,
            record_json = excluded.record_json
        `)
        .run(
          selectorKey,
          mapping.selector.kind,
          selectorValue,
          mapping.target.projectId,
          mapping.target.workstreamId ?? null,
          mapping.createdAt,
          mapping.updatedAt,
          stringifyJson(mapping),
        );
    }
  });
}

export function getExplicitMappings(
  database: SqliteDatabase,
  sessionId: SessionId | undefined,
): readonly ExplicitScopeMapping[] {
  const rows = sessionId === undefined
    ? database
        .prepare("SELECT record_json FROM explicit_mappings ORDER BY updated_at DESC")
        .all()
    : database
        .prepare(`
          SELECT record_json FROM explicit_mappings
          WHERE selector_kind != 'session' OR selector_value = ?
          ORDER BY updated_at DESC
        `)
        .all(sessionId);
  return (rows as SqliteRow[]).map((row) =>
    parseJson<ExplicitScopeMapping>(
      requiredString(row, "record_json"),
      "explicit scope mapping",
    ),
  );
}

export function listCandidates(
  database: SqliteDatabase,
  query: string | undefined,
  limit: number,
): readonly ScopeCandidate[] {
  validateLimit(limit);
  const normalized = query?.normalize("NFKC").trim().toLowerCase();
  if (normalized !== undefined && normalized.length > 256) {
    throw new RangeError("Scope query is too long");
  }

  const refs = database
    .prepare(`
      SELECT record_json, display_name, last_activity_at FROM projects
      UNION ALL
      SELECT record_json, display_name, last_activity_at FROM workstreams
      UNION ALL
      SELECT record_json, COALESCE(title, ''), last_activity_at FROM sessions
    `)
    .all() as SqliteRow[];
  const aliasRows = normalized === undefined || normalized.length === 0
    ? []
    : (database
        .prepare(`
          SELECT record_json FROM aliases
          WHERE normalized_value = ? OR normalized_value LIKE ? ESCAPE '\\'
          LIMIT ?
        `)
        .all(normalized, `${escapeLike(normalized)}%`, limit * 4) as SqliteRow[]);
  const aliases = aliasRows.map((row) =>
    parseJson<ScopeAlias>(requiredString(row, "record_json"), "scope alias"),
  );

  const result: ScopeCandidate[] = [];
  for (const row of refs) {
    const scope = parseJson<ScopeRef>(requiredString(row, "record_json"), "scope");
    const address = addressOf(scope);
    const name = scopeName(scope).normalize("NFKC").trim().toLowerCase();
    const matchingAliases = aliases.filter(
      (alias) => scopeKey(alias.target) === scopeKey(address),
    );
    let score = 0.25;
    let matchedBy: ScopeCandidate["matchedBy"] = "name";
    if (normalized !== undefined && normalized.length > 0) {
      if (matchingAliases.some((alias) => alias.normalizedValue === normalized)) {
        score = 1;
        matchedBy = "alias";
      } else if (name === normalized) {
        score = 0.95;
      } else if (name.startsWith(normalized)) {
        score = 0.8;
      } else if (name.includes(normalized)) {
        score = 0.6;
      } else if (matchingAliases.length > 0) {
        score = 0.7;
        matchedBy = "alias";
      } else {
        continue;
      }
    }
    result.push({
      scope,
      matchedBy,
      score,
      aliases: matchingAliases.map((alias) => alias.value),
      availability: scopeAvailability(database, address),
    });
  }

  return result
    .sort((left, right) =>
      right.score - left.score || scopeName(left.scope).localeCompare(scopeName(right.scope)),
    )
    .slice(0, limit);
}

function addressOf(scope: ScopeRef): ScopeAddress {
  switch (scope.kind) {
    case "project":
      return { projectId: scope.id };
    case "workstream":
      return { projectId: scope.projectId, workstreamId: scope.id };
    case "session":
      return {
        projectId: scope.projectId,
        ...(scope.workstreamId === undefined ? {} : { workstreamId: scope.workstreamId }),
        sessionId: scope.id,
      };
  }
}

function scopeName(scope: ScopeRef): string {
  return scope.kind === "session" ? scope.title ?? scope.id : scope.displayName;
}

function selectorValueOf(mapping: ExplicitScopeMapping): string {
  switch (mapping.selector.kind) {
    case "session":
      return mapping.selector.sessionId;
    case "git_remote":
      return mapping.selector.normalizedRemote;
    case "repository_root":
    case "cwd_prefix":
      return mapping.selector.normalizedPath;
  }
}

function assertProjectExists(database: SqliteDatabase, projectId: string): void {
  const row = database
    .prepare("SELECT 1 AS present FROM projects WHERE project_id = ?")
    .get(projectId) as SqliteRow | undefined;
  if (row === undefined) {
    throw new Error("Project scope must exist before its descendants");
  }
}

function assertWorkstreamBelongsToProject(
  database: SqliteDatabase,
  workstreamId: string,
  projectId: string,
): void {
  const row = database
    .prepare(`
      SELECT 1 AS present FROM workstreams
      WHERE workstream_id = ? AND project_id = ?
    `)
    .get(workstreamId, projectId) as SqliteRow | undefined;
  if (row === undefined) {
    throw new Error("Workstream does not belong to the target project");
  }
}

function digestKey(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Scope result limit must be from 1 to 1000");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}
