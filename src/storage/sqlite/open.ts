// This file manages the connection openign and management with the DB engine.
// Since SQLite opens the DB engine in the same process; unlike postgres or mysql,
// which follows a proper client-server engine, this file manages the env so that
// DB opening and operation is safe. 

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// This defines the connection to the DB, and data consistency funcs
import type { SqliteDatabase, SqliteRow } from "./database.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface OpenDatabaseOptions {
  readonly databaseFile: string;
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
}

export interface SqliteCapabilities {
  readonly sqliteVersion: string;
  readonly journalMode: string;
  readonly fts5: true; //fts5 is a searching optimisation in SQLite.
}

export interface OpenDatabaseResult {
  readonly database: SqliteDatabase;
  readonly capabilities: SqliteCapabilities;
}


export function openDatabase(options: OpenDatabaseOptions): OpenDatabaseResult {
  validateOptions(options);
  const readOnly = options.readOnly ?? false;

  if (options.databaseFile !== ":memory:") {
    const parent = dirname(options.databaseFile);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    rejectSymlink(options.databaseFile);
  }

  const database = new DatabaseSync(options.databaseFile, {
    readOnly,
    enableForeignKeyConstraints: true,
  });

  // These are SQLite config commands
  // PRAGMA states that the further commands are for changing the config of SQLite
  // These config how the DB should behave when the DB is locked with another application. 
  try {
    database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA foreign_keys = ON");

    // Journal Mode speicfies the mech to handle the transactions
    // Here we have WAL mode. 
    const journalMode = readOnly
      ? pragmaString(database, "PRAGMA journal_mode", "journal_mode")
      : pragmaString(database, "PRAGMA journal_mode = WAL", "journal_mode");

    database.exec("PRAGMA synchronous = NORMAL");
    const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as
      | SqliteRow
      | undefined;
    if (foreignKeys?.foreign_keys !== 1) {
      throw new Error("SQLite foreign-key enforcement is unavailable");
    }

    // FTS5 uses virtual tables to improve the searching speed
    // So here we have defined the creation of virtual table. 
    database.exec("CREATE VIRTUAL TABLE temp.context_bridge_fts5_probe USING fts5(value)");
    database.exec("DROP TABLE temp.context_bridge_fts5_probe");

    if (!readOnly && options.databaseFile !== ":memory:") {
      chmodSync(options.databaseFile, 0o600);
    }

    return {
      database,
      capabilities: {
        sqliteVersion: pragmaString(
          database,
          "SELECT sqlite_version() AS sqlite_version",
          "sqlite_version",
        ),
        journalMode,
        fts5: true,
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function pragmaString(
  database: SqliteDatabase,
  sql: string,
  key: string,
): string {
  const row = database.prepare(sql).get() as SqliteRow | undefined;
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new Error(`SQLite did not return ${key}`);
  }
  return value;
}

function rejectSymlink(path: string): void {
  try {
    const state = lstatSync(path);
    if (state.isSymbolicLink()) {
      throw new Error("Refusing to open a SQLite database through a symbolic link");
    }
    if (!state.isFile()) {
      throw new Error("SQLite database path is not a regular file");
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function validateOptions(options: OpenDatabaseOptions): void {
  if (options.databaseFile.length === 0 || options.databaseFile.includes("\0")) {
    throw new TypeError("Invalid SQLite database path");
  }

  const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000) {
    throw new RangeError("SQLite busy timeout must be an integer from 0 to 60000");
  }
}
