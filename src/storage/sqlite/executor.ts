// A general interface that exposes a execute function; that takes operation to be 
// performed and eventually gives the result. The result type as a promise makes it
// async

// TResult is the generic type that will be returned here.
export interface StorageExecutor {
  execute<TResult>(operation: string, argument?: unknown): Promise<TResult>;
}

export interface SerializedWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

