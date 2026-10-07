// This file is for valdiating and converting the cofig from external sources like
// config.toml etc and convert it th js objects

// Since the config from ecternal source will be retrieved at the runtime, we need ZOD which provides 
// schema valdiation at runtime as TS itself does only compile time validation. 

import { z } from "zod";

import { CURRENT_CONFIG_VERSION, DEFAULT_CONFIG } from "./defaults.js";

const filesystemPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "Path contains control characters",
  });

const pathsSchema = z.strictObject({
  dataDir: filesystemPathSchema.optional(),
  cacheDir: filesystemPathSchema.optional(),
  modelCacheDir: filesystemPathSchema.optional(),
  logsDir: filesystemPathSchema.optional(),
  exportsDir: filesystemPathSchema.optional(),
});

const sourcesSchema = z.strictObject({
  codexHomes: z
    .array(filesystemPathSchema)
    .max(32)
    .default([...DEFAULT_CONFIG.sources.codexHomes]),
  includeHistory: z.boolean().default(DEFAULT_CONFIG.sources.includeHistory),
  includeSessionIndex: z
    .boolean()
    .default(DEFAULT_CONFIG.sources.includeSessionIndex),
  pollingIntervalMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60_000)
    .default(DEFAULT_CONFIG.sources.pollingIntervalMs),
  maxReadBytes: z
    .number()
    .int()
    .min(4_096)
    .max(64 * 1_024 * 1_024)
    .default(DEFAULT_CONFIG.sources.maxReadBytes),
  maxRecordsPerBatch: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(DEFAULT_CONFIG.sources.maxRecordsPerBatch),
});

const storageSchema = z.strictObject({
  sqliteBusyTimeoutMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(DEFAULT_CONFIG.storage.sqliteBusyTimeoutMs),
  maxObjectBytes: z
    .number()
    .int()
    .min(1_024)
    .max(64 * 1_024 * 1_024)
    .default(DEFAULT_CONFIG.storage.maxObjectBytes),
});

const processingSchema = z
  .strictObject({
    chunkTargetTokens: z
      .number()
      .int()
      .min(64)
      .max(4_096)
      .default(DEFAULT_CONFIG.processing.chunkTargetTokens),
    chunkMaxTokens: z
      .number()
      .int()
      .min(128)
      .max(8_192)
      .default(DEFAULT_CONFIG.processing.chunkMaxTokens),
    maxToolOutputCharacters: z
      .number()
      .int()
      .min(1_024)
      .max(2_000_000)
      .default(DEFAULT_CONFIG.processing.maxToolOutputCharacters),
  })
  .superRefine((value, context) => {
    if (value.chunkTargetTokens > value.chunkMaxTokens) {
      context.addIssue({
        code: "custom",
        path: ["chunkTargetTokens"],
        message: "chunkTargetTokens cannot exceed chunkMaxTokens",
      });
    }
  });

const retrievalSchema = z.strictObject({
  candidateLimitPerChannel: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(DEFAULT_CONFIG.retrieval.candidateLimitPerChannel),
  maxItems: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(DEFAULT_CONFIG.retrieval.maxItems),
  maxBytes: z
    .number()
    .int()
    .min(1_024)
    .max(2 * 1_024 * 1_024)
    .default(DEFAULT_CONFIG.retrieval.maxBytes),
  searchMaxTokens: z
    .number()
    .int()
    .min(128)
    .max(10_000)
    .default(DEFAULT_CONFIG.retrieval.searchMaxTokens),
  overviewMaxTokens: z
    .number()
    .int()
    .min(128)
    .max(10_000)
    .default(DEFAULT_CONFIG.retrieval.overviewMaxTokens),
  evidenceMaxTokens: z
    .number()
    .int()
    .min(128)
    .max(10_000)
    .default(DEFAULT_CONFIG.retrieval.evidenceMaxTokens),
});

const runtimeSchema = z.strictObject({
  host: z.literal("127.0.0.1").default(DEFAULT_CONFIG.runtime.host),
  port: z.number().int().min(1).max(65_535).default(DEFAULT_CONFIG.runtime.port),
  maxRequestBytes: z
    .number()
    .int()
    .min(4_096)
    .max(8 * 1_024 * 1_024)
    .default(DEFAULT_CONFIG.runtime.maxRequestBytes),
  maxConcurrentRequests: z
    .number()
    .int()
    .min(1)
    .max(256)
    .default(DEFAULT_CONFIG.runtime.maxConcurrentRequests),
  shutdownGraceMs: z
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(DEFAULT_CONFIG.runtime.shutdownGraceMs),
});

const httpsUrlSchema = z.string().url().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
    } catch {
      return false;
    }
  },
  {
    message:
      "Remote embedding endpoints must use HTTPS and contain no credentials, query, or fragment",
  },
);

const embeddingsSchema = z
  .strictObject({
    enabled: z.boolean().default(DEFAULT_CONFIG.embeddings.enabled),
    provider: z
      .enum(["local_transformers", "remote"])
      .default(DEFAULT_CONFIG.embeddings.provider),
    modelId: z.string().trim().min(1).max(512).optional(),
    modelRevision: z.string().trim().min(1).max(512).optional(),
    remoteEndpoint: httpsUrlSchema.optional(),
    batchSize: z
      .number()
      .int()
      .min(1)
      .max(128)
      .default(DEFAULT_CONFIG.embeddings.batchSize),
    maxPendingJobs: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(DEFAULT_CONFIG.embeddings.maxPendingJobs),
    idleUnloadMs: z
      .number()
      .int()
      .min(0)
      .max(60 * 60_000)
      .default(DEFAULT_CONFIG.embeddings.idleUnloadMs),
  })
  .superRefine((value, context) => {
    if (value.enabled && value.modelId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["modelId"],
        message: "Enabled embeddings require a pinned modelId",
      });
    }

    if (value.enabled && value.modelRevision === undefined) {
      context.addIssue({
        code: "custom",
        path: ["modelRevision"],
        message: "Enabled embeddings require a pinned modelRevision",
      });
    }

    if (
      value.enabled &&
      value.provider === "remote" &&
      value.remoteEndpoint === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["remoteEndpoint"],
        message: "Enabled remote embeddings require an HTTPS endpoint",
      });
    }

    if (
      value.provider === "local_transformers" &&
      value.remoteEndpoint !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["remoteEndpoint"],
        message: "remoteEndpoint is only valid for the remote provider",
      });
    }
  });

const vectorSchema = z.strictObject({
  backend: z
    .enum(["lancedb", "sqlite_vec", "disabled"])
    .default(DEFAULT_CONFIG.vector.backend),
  maxDiskBytes: z
    .number()
    .int()
    .min(64 * 1_024 * 1_024)
    .max(100 * 1_024 * 1_024 * 1_024)
    .default(DEFAULT_CONFIG.vector.maxDiskBytes),
  optimizeAfterWrites: z
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .default(DEFAULT_CONFIG.vector.optimizeAfterWrites),
});

export const contextBridgeConfigSchema = z
  .strictObject({
    version: z.literal(CURRENT_CONFIG_VERSION),
    paths: pathsSchema.default({}),
    sources: sourcesSchema.default({
      ...DEFAULT_CONFIG.sources,
      codexHomes: [...DEFAULT_CONFIG.sources.codexHomes],
    }),
    storage: storageSchema.default({ ...DEFAULT_CONFIG.storage }),
    processing: processingSchema.default({ ...DEFAULT_CONFIG.processing }),
    retrieval: retrievalSchema.default({ ...DEFAULT_CONFIG.retrieval }),
    runtime: runtimeSchema.default({ ...DEFAULT_CONFIG.runtime }),
    embeddings: embeddingsSchema.default({ ...DEFAULT_CONFIG.embeddings }),
    vector: vectorSchema.default({ ...DEFAULT_CONFIG.vector }),
  })
  .superRefine((value, context) => {
    if (value.embeddings.enabled && value.vector.backend === "disabled") {
      context.addIssue({
        code: "custom",
        path: ["vector", "backend"],
        message: "The vector backend cannot be disabled while embeddings are enabled",
      });
    }
  });

export type ContextBridgeConfig = z.output<typeof contextBridgeConfigSchema>;
export type ContextBridgeConfigInput = z.input<typeof contextBridgeConfigSchema>;

export class ConfigVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(`Unsupported configuration version: ${String(version)}`);
    this.name = "ConfigVersionError";
    this.version = version;
  }
}

/** Adds the first explicit version to pre-release, unversioned configurations. */
export function migrateConfig(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const version = input.version;
  if (version === undefined || version === 0) {
    return { ...input, version: CURRENT_CONFIG_VERSION };
  }

  if (version !== CURRENT_CONFIG_VERSION) {
    throw new ConfigVersionError(version);
  }

  return input;
}

export function parseConfig(input: unknown): ContextBridgeConfig {
  return contextBridgeConfigSchema.parse(migrateConfig(input));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
