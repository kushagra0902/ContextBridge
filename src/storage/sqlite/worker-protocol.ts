import type { MigrationResult } from "./migrate.js";
import type { SqliteCapabilities } from "./open.js";
import type { SerializedWorkerError } from "./executor.js";

export interface WorkerOptions {
  readonly databaseFile: string;
  readonly busyTimeoutMs?: number;
  readonly backupBeforeMigration: boolean;
}

export interface WorkerRequest {
  readonly type: "request";
  readonly id: number;
  readonly operation: string;
  readonly argument?: unknown;
}

export type WorkerResponse =
  | {
      readonly type: "ready";
      readonly capabilities: SqliteCapabilities;
      readonly migration: MigrationResult;
    }
  | {
      readonly type: "result";
      readonly id: number;
      readonly result?: unknown;
    }
  | {
      readonly type: "error";
      readonly id?: number;
      readonly error: SerializedWorkerError;
    };

