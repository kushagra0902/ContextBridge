// This is the actual executing thread for the sql queries 
// which is called by the worker.ts file upon receiving a req.

import { existsSync } from "node:fs";
import { backup } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import type { SqliteDatabase } from "./database.js";
import type { SerializedWorkerError } from "./executor.js";
import { migrateDatabase } from "./migrate.js";
import { openDatabase } from "./open.js";
import { handleDerivedDataOperation } from "./repositories/derived-data.js";
import { handleEmbeddingJobsOperation } from "./repositories/embedding-jobs.js";
import { handleEvidenceOperation } from "./repositories/evidence.js";
import { handleLexicalSearchOperation } from "./repositories/lexical-search.js";
import { handleMemoriesOperation } from "./repositories/memories.js";
import { handleProjectsOperation } from "./repositories/projects.js";
import { handleSourcesOperation } from "./repositories/sources.js";
import type {
  WorkerOptions,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.js";

if (parentPort === null) {
  throw new Error("SQLite worker runtime must run in a worker thread");
}

const port = parentPort;
const options = workerData as WorkerOptions;

try {
  const existedBeforeOpen = existsSync(options.databaseFile);
  const { database, capabilities } = openDatabase({
    databaseFile: options.databaseFile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  const migration = await migrateDatabase(database, {
    beforeMigrate: async ({ currentVersion }) => {
      if (
        options.backupBeforeMigration &&
        existedBeforeOpen &&
        currentVersion > 0 &&
        options.databaseFile !== ":memory:"
      ) {
        await backup(
          database,
          `${options.databaseFile}.pre-migration-v${currentVersion}.bak`,
        );
      }
    },
  });
  port.postMessage({ type: "ready", capabilities, migration } satisfies WorkerResponse);

  port.on("message", (request: WorkerRequest) => {
    handleRequest(database, request);
  });
} catch (error) {
  port.postMessage({
    type: "error",
    error: serializeError(error),
  } satisfies WorkerResponse);
}

function handleRequest(database: SqliteDatabase, request: WorkerRequest): void {
  try {
    if (request.type !== "request") {
      throw new TypeError("Invalid SQLite worker request");
    }
    if (request.operation === "storage.close") {
      database.close();
      port.postMessage({ type: "result", id: request.id } satisfies WorkerResponse);
      return;
    }
    const result = dispatch(database, request.operation, request.argument);
    port.postMessage({
      type: "result",
      id: request.id,
      ...(result === undefined ? {} : { result }),
    } satisfies WorkerResponse);
  } catch (error) {
    port.postMessage({
      type: "error",
      id: request.id,
      error: serializeError(error),
    } satisfies WorkerResponse);
  }
}

function dispatch(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  if (operation.startsWith("sources.")) {
    return handleSourcesOperation(database, operation, argument);
  }
  if (operation.startsWith("scopes.")) {
    return handleProjectsOperation(database, operation, argument);
  }
  if (operation.startsWith("evidence.")) {
    return handleEvidenceOperation(database, operation, argument);
  }
  if (operation.startsWith("memories.")) {
    return handleMemoriesOperation(database, operation, argument);
  }
  if (operation.startsWith("derived.")) {
    return handleDerivedDataOperation(database, operation, argument);
  }
  if (operation.startsWith("lexical.")) {
    return handleLexicalSearchOperation(database, operation, argument);
  }
  if (operation.startsWith("embedding.")) {
    return handleEmbeddingJobsOperation(database, operation, argument);
  }
  throw new Error(`Unknown SQLite worker operation: ${operation}`);
}

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(code === undefined ? {} : { code }),
    };
  }
  return { name: "Error", message: "Unknown SQLite worker failure" };
}

