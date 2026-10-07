// This is for handling database migration.
// Migrations help in changing schema as and when we need it
// This file ensures that the newer schema do not tamper the older schema such
// that the data becomes imcompatible

import { readFile } from "node:fs/promises";

import type { SqliteDatabase, SqliteRow } from "./database.js";
import { withTransaction } from "./transaction.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly source: URL; // Migration file link
}

export interface MigrationContext {
  readonly currentVersion: number;
  readonly targetVersion: number;
}

// before migration is a hook that let some other func or part of application
// to perform some code if they req, For eg some other func want to insert the hook to 
// print the version number before migration happens. 

export interface MigrateDatabaseOptions {
  readonly beforeMigrate?: (context: MigrationContext) => void | Promise<void>;
}

export interface MigrationResult {
  readonly previousVersion: number;
  readonly currentVersion: number;
  readonly applied: readonly number[];
}

// List of all database schemas, the application later supports
// all these schemas for backward compatibility. 

// The migration data is stored in the migrations table for the database 
// to ensure consistency, proper versioning and applying migrations. 

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    source: new URL("./migrations/001_initial.sql", import.meta.url),
  },
  {
    version: 2,
    name: "chunk_sequence",
    source: new URL("./migrations/002_chunk_sequence.sql", import.meta.url),
  },
];


export async function migrateDatabase(
  database: SqliteDatabase,
  options: MigrateDatabaseOptions = {},
): Promise<MigrationResult> {
  validateMigrationList(MIGRATIONS);
  const previousVersion = currentSchemaVersion(database);

  // Find pending migrations that are to be done. 
  const pending = MIGRATIONS.filter(
    (migration) => migration.version > previousVersion,
  );

  if (pending.length === 0) {
    return {
      previousVersion,
      currentVersion: previousVersion,
      applied: [],
    };
  }

  const targetVersion = pending.at(-1)?.version;
  if (targetVersion === undefined) {
    throw new Error("Unable to determine target schema version");
  }

  // beforeMigrate '?' means that the beforeMigrate is optional and if present, it runs the function given as a callback earlier. 
  await options.beforeMigrate?.({
    currentVersion: previousVersion,
    targetVersion,
  });

  const applied: number[] = [];
  for (const migration of pending) {
    const sql = await readFile(migration.source, "utf8");
    withTransaction(database, () => {
      database.exec(sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, new Date().toISOString());
    }, "EXCLUSIVE");
    applied.push(migration.version);
  }

  return {
    previousVersion,
    currentVersion: targetVersion,
    applied,
  };
}

export function currentSchemaVersion(database: SqliteDatabase): number {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() as SqliteRow | undefined;
  if (table === undefined) {
    return 0;
  }

  const rows = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as SqliteRow[];
  for (const [index, row] of rows.entries()) {
    const version = row.version;
    const name = row.name;
    const expected = MIGRATIONS[index];
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version !== index + 1 ||
      expected === undefined ||
      name !== expected.name
    ) {
      throw new Error("SQLite migration history is missing, unknown, or reordered");
    }
  }
  const version = rows.length;

  const newestKnown = MIGRATIONS.at(-1)?.version ?? 0;
  if (version > newestKnown) {
    throw new Error(
      `Database schema ${version} is newer than supported schema ${newestKnown}`,
    );
  }
  return version;
}

function validateMigrationList(migrations: readonly Migration[]): void {
  let expected = 1;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error(`Expected migration ${expected}, received ${migration.version}`);
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate migration name: ${migration.name}`);
    }
    names.add(migration.name);
    expected += 1;
  }
}
