export { commitIngestBatch } from "./commit.js";
export {
  decideCursorTransition,
  type CursorTransition,
  type IngestCursorMode,
} from "./cursor.js";

export { deduplicateEvents, type EventDedupeResult } from "./dedupe.js";

export {
  reconcileSources,
  type SourceReconciliation,
  type SourceReconciliationKind,
} from "./reconcile-sources.js";

export { scanOnce, IngestCursorError, type IngestScan } from "./scan.js";

export {
  IngestionScheduler,
  type IngestionRunResult,
  type IngestionSchedulerOptions,
  type PollIngestionOptions,
  type SourceIngestionResult,
} from "./scheduler.js";
