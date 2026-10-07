import type { IngestionRunResult } from "../ingestion/index.js";
import type { SourceConfig } from "../contracts/source.js";

export interface IndexSourcesInput {
  readonly sourceConfig: SourceConfig;
}

export interface IndexSourcesDependencies {
  readonly ingestion: {
    runOnce(config: SourceConfig): Promise<IngestionRunResult>;
  };
}

export interface IndexedSourceSummary {
  readonly sourceId: IngestionRunResult["sources"][number]["sourceId"];
  readonly status: IngestionRunResult["sources"][number]["status"];
  readonly batches: number;
  readonly recordsRead: number;
  readonly insertedEvents: number;
  readonly duplicateEvents: number;
  readonly skippedEvents: number;
  readonly diagnostics: number;
  readonly hasMore: boolean;
  readonly errorCode?: string;
  readonly retryAt?: string;
}

export interface IndexSourcesResult {
  readonly status: "ok" | "partial" | "failed" | "no_source";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sources: readonly IndexedSourceSummary[];
  readonly reconciliation: readonly {
    readonly kind: IngestionRunResult["reconciliation"][number]["kind"];
    readonly sourceId: IngestionRunResult["reconciliation"][number]["source"]["id"];
    readonly previousSourceId?: IngestionRunResult["reconciliation"][number]["previousSourceId"];
  }[];
  readonly totals: IngestionRunResult["totals"];
}

/** Runs one bounded scheduler cycle and strips physical source paths. */
export async function indexSources(
  input: IndexSourcesInput,
  dependencies: IndexSourcesDependencies,
): Promise<IndexSourcesResult> {
  const result = await dependencies.ingestion.runOnce(input.sourceConfig);
  const failed = result.totals.failedSources;
  return {
    status: result.totals.discoveredSources === 0
      ? "no_source"
      : failed === result.totals.attemptedSources
        ? "failed"
        : failed > 0 || result.totals.laggingSources > 0
          ? "partial"
          : "ok",
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    sources: result.sources.map((source) => ({ ...source })),
    reconciliation: result.reconciliation.map((item) => ({
      kind: item.kind,
      sourceId: item.source.id,
      ...(item.previousSourceId === undefined ? {} : { previousSourceId: item.previousSourceId }),
    })),
    totals: result.totals,
  };
}
