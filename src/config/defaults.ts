const KIB = 1_024;
const MIB = 1_024 * KIB;
const GIB = 1_024 * MIB;

export const CURRENT_CONFIG_VERSION = 1 as const;

export const DEFAULT_CONFIG = {
  version: CURRENT_CONFIG_VERSION,
  paths: {},
  sources: {
    codexHomes: [],
    includeHistory: true,
    includeSessionIndex: true,
    pollingIntervalMs: 30_000,
    maxReadBytes: 1 * MIB,
    maxRecordsPerBatch: 500,
  },
  storage: {
    sqliteBusyTimeoutMs: 5_000,
    maxObjectBytes: 4 * MIB,
  },
  processing: {
    chunkTargetTokens: 600,
    chunkMaxTokens: 900,
    maxToolOutputCharacters: 64 * KIB,
  },
  retrieval: {
    candidateLimitPerChannel: 50,
    maxItems: 12,
    maxBytes: 128 * KIB,
    searchMaxTokens: 6_000,
    overviewMaxTokens: 3_000,
    evidenceMaxTokens: 5_000,
  },
  runtime: {
    host: "127.0.0.1",
    port: 3847,
    maxRequestBytes: 1 * MIB,
    maxConcurrentRequests: 16,
    shutdownGraceMs: 15_000,
  },
  embeddings: {
    enabled: false,
    provider: "local_transformers",
    batchSize: 16,
    maxPendingJobs: 50_000,
    idleUnloadMs: 5 * 60_000,
  },
  vector: {
    backend: "lancedb",
    maxDiskBytes: 5 * GIB,
    optimizeAfterWrites: 10_000,
  },
} as const;
