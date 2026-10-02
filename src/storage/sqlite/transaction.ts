import type { SqliteDatabase } from "./database.js";

// Write lock obtaining modes
export type TransactionMode = "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE";

/**
 * Runs a synchronous unit of database work in one transaction.
 *
 * Transactions are deliberately not retried here. A callback can contain state
 * changes that are unsafe to replay. SQLite's busy timeout handles short lock
 * contention before an error reaches the caller.
 */

// T here defines a generic datatype to be returned from the 
// callback. 
export function withTransaction<T>(
  database: SqliteDatabase,
  fn: () => T,
  mode: TransactionMode = "IMMEDIATE",
): T {
  if (database.isTransaction) {
    throw new Error("Nested SQLite transactions are not supported");
  }

  database.exec(`BEGIN ${mode}`);
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "SQLite transaction and rollback both failed",
      );
    }
    throw error;
  }
}

