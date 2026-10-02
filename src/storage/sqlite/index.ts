// Public entry point for the module. Just exposes all the interfaces, classes
// and apis

// The repository is the project specific api definitions etc
// And other files give connection to database and engine configs expressed through 
// worker client for the database. 


import type { Storage } from "../../contracts/ports.js";
import { SqliteDerivedDataRepository } from "./repositories/derived-data.js";
import { SqliteEmbeddingJobRepository } from "./repositories/embedding-jobs.js";
import { SqliteEvidenceRepository } from "./repositories/evidence.js";
import { SqliteLexicalSearchRepository } from "./repositories/lexical-search.js";
import { SqliteMemoryRepository } from "./repositories/memories.js";
import { SqliteScopeRepository } from "./repositories/projects.js";
import { SqliteSourceStateRepository } from "./repositories/sources.js";
import { SqliteWorkerClient, type WorkerReadyState } from "./worker.js";

export interface OpenSqliteStorageOptions {
  readonly databaseFile: string;
  readonly busyTimeoutMs?: number;
  readonly backupBeforeMigration?: boolean;
}

export interface SqliteStorage extends Storage {
  readonly startup: WorkerReadyState;
}

export async function openSqliteStorage(
  options: OpenSqliteStorageOptions,
): Promise<SqliteStorage> {
  const worker = new SqliteWorkerClient({
    databaseFile: options.databaseFile,
    ...(options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: options.busyTimeoutMs }),
    backupBeforeMigration: options.backupBeforeMigration ?? true,
  });
  const startup = await worker.ready();
  return {
    startup,
    sources: new SqliteSourceStateRepository(worker),
    scopes: new SqliteScopeRepository(worker),
    evidence: new SqliteEvidenceRepository(worker),
    memories: new SqliteMemoryRepository(worker),
    derivedData: new SqliteDerivedDataRepository(worker),
    lexicalSearch: new SqliteLexicalSearchRepository(worker),
    embeddingJobs: new SqliteEmbeddingJobRepository(worker),
    close: () => worker.close(),
  };
}

export { escapeFtsQuery, rebuildFts, searchFts } from "./fts.js";
export {
  extractExactTerms,
  replaceExactTerms,
  searchExactTerms,
} from "./exact-terms.js";
export { migrateDatabase, currentSchemaVersion } from "./migrate.js";
export { openDatabase } from "./open.js";
export { withTransaction } from "./transaction.js";

