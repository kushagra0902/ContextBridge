// This exposes the actual memory operation APIs for rest of the 
// application and an abstraction to SQL commands. 

import type { MemoryRepository } from "../../../contracts/ports.js";
import type { MemoryId } from "../../../contracts/ids.js";
import type { MemoryRecord, MemoryType } from "../../../contracts/memory.js";
import type { SearchScope } from "../../../contracts/search.js";
import type { SqliteDatabase, SqliteRow } from "../database.js";
import { parseJson, requiredString } from "../database.js";
import type { StorageExecutor } from "../executor.js";

export class SqliteMemoryRepository implements MemoryRepository {
  constructor(private readonly executor: StorageExecutor) {}

  get(ids: readonly MemoryId[]): Promise<readonly MemoryRecord[]> {
    return this.executor.execute("memories.get", ids);
  }

  findByScope(
    scope: SearchScope,
    types?: readonly MemoryType[],
  ): Promise<readonly MemoryRecord[]> {
    return this.executor.execute("memories.findByScope", { scope, types });
  }
}

export function handleMemoriesOperation(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  switch (operation) {
    case "memories.get":
      return getMemories(database, argument as readonly MemoryId[]);
    case "memories.findByScope": {
      const input = argument as {
        scope: SearchScope;
        types?: readonly MemoryType[];
      };
      return findMemoriesByScope(database, input.scope, input.types);
    }
    default:
      throw new Error(`Unknown memory repository operation: ${operation}`);
  }
}

export function getMemories(
  database: SqliteDatabase,
  ids: readonly MemoryId[],
): readonly MemoryRecord[] {
  if (ids.length === 0) {
    return [];
  }
  if (ids.length > 1_000) {
    throw new RangeError("At most 1000 memories can be read at once");
  }
  const rows = database
    .prepare(`
      SELECT memory_id, record_json
      FROM memories
      WHERE memory_id IN (${ids.map(() => "?").join(", ")})
        AND (
          project_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM exclusions AS blocked
            WHERE blocked.project_id = memories.project_id
              AND (blocked.workstream_id IS NULL OR blocked.workstream_id = memories.workstream_id)
              AND (blocked.session_id IS NULL OR blocked.session_id = memories.session_id)
          )
        )
    `)
    .all(...ids) as SqliteRow[];
  const byId = new Map(
    rows.map((row) => [
      requiredString(row, "memory_id"),
      parseJson<MemoryRecord>(requiredString(row, "record_json"), "memory"),
    ]),
  );
  return ids.flatMap((id) => {
    const memory = byId.get(id);
    return memory === undefined ? [] : [memory];
  });
}

export function findMemoriesByScope(
  database: SqliteDatabase,
  scope: SearchScope,
  types?: readonly MemoryType[],
): readonly MemoryRecord[] {
  if (types !== undefined && types.length === 0) {
    return [];
  }
  const clauses = ["project_id = ?"];
  const parameters: string[] = [scope.projectId];
  if (scope.workstreamId !== undefined) {
    clauses.push("workstream_id = ?");
    parameters.push(scope.workstreamId);
  }
  if (scope.sessionId !== undefined) {
    clauses.push("session_id = ?");
    parameters.push(scope.sessionId);
  }
  if (types !== undefined) {
    clauses.push(`type IN (${types.map(() => "?").join(", ")})`);
    parameters.push(...types);
  }
  const rows = database
    .prepare(`
      SELECT record_json FROM memories
      WHERE ${clauses.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1 FROM exclusions AS blocked
          WHERE blocked.project_id = memories.project_id
            AND (blocked.workstream_id IS NULL OR blocked.workstream_id = memories.workstream_id)
            AND (blocked.session_id IS NULL OR blocked.session_id = memories.session_id)
        )
      ORDER BY updated_at DESC, memory_id
      LIMIT 1000
    `)
    .all(...parameters) as SqliteRow[];
  return rows.map((row) =>
    parseJson<MemoryRecord>(requiredString(row, "record_json"), "memory"),
  );
}

