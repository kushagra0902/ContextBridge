import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

// DatabaseSync represents one single connection to the SQLite with APIs in Sync manner
export type SqliteDatabase = DatabaseSync;

// SQLOutputValue is type of the row output from SQL. 
// Record is a inbuilt data type in sql which has K as the key type and V as the value type in Record<K, V>
export type SqliteRow = Readonly<Record<string, SQLOutputValue>>;

export function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`SQLite column ${key} is not a string`);
  }
  return value;
}

export function optionalString(
  row: SqliteRow,
  key: string,
): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`SQLite column ${key} is not a string`);
  }
  return value;
}

export function requiredNumber(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new TypeError(`SQLite column ${key} is not a number`);
  }
  return value;
}

export function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Invalid persisted JSON for ${label}`, { cause: error });
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

