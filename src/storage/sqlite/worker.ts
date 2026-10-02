// SQLite APIs are sync and thus direct call will resutl in hang. 
// Therefore we need a a worker who accepts the req and implements it without
// stopping the main thread of the process. 

import { Worker } from "node:worker_threads";

import type { StorageExecutor } from "./executor.js";
import type { MigrationResult } from "./migrate.js";
import type { SqliteCapabilities } from "./open.js";

import type {
  WorkerOptions,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export interface WorkerReadyState {
  readonly capabilities: SqliteCapabilities;
  readonly migration: MigrationResult;
}

export class SqliteWorkerClient implements StorageExecutor {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  // means that the readyPromise stores a promise that will resolve to
  // worker ready state.
  private readonly readyPromise: Promise<WorkerReadyState>;
  private resolveReady!: (state: WorkerReadyState) => void;
  private rejectReady!: (reason: unknown) => void;
  private nextRequestId = 1;
  private state: "starting" | "ready" | "closing" | "closed" = "starting";

  constructor(options: WorkerOptions) {
    this.readyPromise = new Promise<WorkerReadyState>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(new URL("./worker-runtime.js", import.meta.url), {
      workerData: options,
    });
    this.worker.on("message", (response: WorkerResponse) => {
      this.handleMessage(response);
    });
    this.worker.on("error", (error) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.worker.on("exit", (code) => {
      if (this.state !== "closed") {
        this.fail(new Error(`SQLite worker exited unexpectedly with code ${code}`));
      }
    });
  }

  ready(): Promise<WorkerReadyState> {
    return this.readyPromise;
  }


  async execute<TResult>(
    operation: string,
    argument?: unknown,
  ): Promise<TResult> {
    await this.readyPromise;
    if (this.state !== "ready" && operation !== "storage.close") {
      throw new Error("SQLite storage is closing or closed");
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const request: WorkerRequest = {
      type: "request",
      id,
      operation,
      ...(argument === undefined ? {} : { argument }),
    };

    // Send the resp to the worker runtime (defined in worker-runtime.js)
    this.worker.postMessage(request);
    return response as Promise<TResult>;
  }

  async close(): Promise<void> {
    await this.readyPromise;
    if (this.state === "closed" || this.state === "closing") {
      return;
    }
    this.state = "closing";
    await this.execute<void>("storage.close");
    this.state = "closed";
    await this.worker.terminate();
  }

  // This is for handling the resp by worker thread 
  private handleMessage(response: WorkerResponse): void {
    if (response.type === "ready") {
      if (this.state !== "starting") {
        this.fail(new Error("SQLite worker sent a duplicate ready message"));
        return;
      }
      this.state = "ready";
      this.resolveReady({
        capabilities: response.capabilities,
        migration: response.migration,
      });
      return;
    }

    if (response.type === "error" && response.id === undefined) {
      this.fail(deserializeError(response.error));
      return;
    }

    const id = response.id;
    if (id === undefined) {
      this.fail(new Error("SQLite worker response omitted its request ID"));
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      this.fail(new Error(`SQLite worker returned unknown request ${id}`));
      return;
    }
    this.pending.delete(id);
    if (response.type === "error") {
      pending.reject(deserializeError(response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  private fail(error: Error): void {
    if (this.state === "starting") {
      this.rejectReady(error);
    }
    this.state = "closed";
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    void this.worker.terminate();
  }
}

function deserializeError(serialized: {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack !== undefined) {
    error.stack = serialized.stack;
  }
  if (serialized.code !== undefined) {
    Object.defineProperty(error, "code", {
      value: serialized.code,
      enumerable: true,
    });
  }
  return error;
}
