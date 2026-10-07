import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  exportScope as exportScopeUseCase,
  forgetScope,
  reindex,
} from "../app/index.js";
import { saveConfigAtomically } from "../config/load.js";
import { resolveCodexHomes } from "../config/paths.js";
import { parseConfig, type ContextBridgeConfig } from "../config/schema.js";
import type { SourceConfig, SourceRef } from "../contracts/source.js";
import { serveMcpStdio } from "../mcp/index.js";
import { heuristicTokenizer } from "../processing/chunks/index.js";
import {
  DefaultOutputPolicy,
  LocalAuthorizationPolicy,
} from "../security/output-policy.js";
import { CodexSourceAdapter } from "../sources/codex/adapter.js";
import { isCodexSourcePayload } from "../sources/codex/normalize.js";
import { projectIdFromRemote } from "../sources/git/project-mapper.js";
import { normalizeGitRemote } from "../sources/git/remote.js";
import {
  createRuntimeApplication,
  createRuntimeServiceManager,
  listenForShutdownSignals,
  runtimeChunkPolicy,
  startRuntimeDaemon,
} from "../runtime/index.js";
import type {
  CliApplication,
  CliApplicationOptions,
  ServiceAction,
} from "./types.js";

export async function createLocalCliApplication(
  options: CliApplicationOptions = {},
): Promise<CliApplication> {
  const runtime = await createRuntimeApplication(options);
  const { config, paths, storage, adapter, readApp, cursorSecret } = runtime;
  const authorization = new LocalAuthorizationPolicy(storage.scopes);
  const maximumTokens = Math.max(
    config.retrieval.searchMaxTokens,
    config.retrieval.overviewMaxTokens,
    config.retrieval.evidenceMaxTokens,
  );
  const outputPolicy = new DefaultOutputPolicy({
    limits: {
      maxItems: config.retrieval.maxItems,
      maxBytes: config.retrieval.maxBytes,
      maxTokens: maximumTokens,
    },
    tokenizer: heuristicTokenizer,
  });
  const shared = { storage, authorization, outputPolicy, tokenizer: heuristicTokenizer };
  const serviceManager = createRuntimeServiceManager({
    platform: paths.platform,
    configPath: paths.configFile,
    cliEntrypoint: fileURLToPath(new URL("./bin.js", import.meta.url)),
  });

  return {
    ...readApp,
    async initialize(input) {
      const resolution = await resolveCodexHomes({
        configuredHomes: input.codexHomes ?? config.sources.codexHomes,
      });
      const previewConfig = sourceConfiguration(resolution.homes, config);
      const discovered = await adapter.discover(previewConfig);
      const projectPreview = await previewProjects(adapter, discovered);
      const selected = new Set(input.includeProjectIds ?? []);
      const excluded = new Set(input.excludeProjectIds ?? []);
      const known = new Set(projectPreview.projects.map((project) => project.projectId));
      for (const projectId of [...selected, ...excluded]) {
        if (!known.has(projectId) && await storage.scopes.get({ projectId }) === undefined) {
          throw new TypeError("Project selection does not match a discovered or indexed project");
        }
      }
      if (projectPreview.projects.length > 0) {
        await storage.scopes.upsertScopes(projectPreview.projects.map((project) => ({
          kind: "project" as const,
          id: project.projectId,
          displayName: project.displayName,
        })));
      }
      for (const projectId of selected) await storage.scopes.removeExclusion({ projectId });
      const now = new Date().toISOString();
      for (const projectId of excluded) {
        await storage.scopes.upsertExclusion({
          scope: { projectId },
          reason: "user_excluded",
          blocksIngestion: true,
          status: "excluded",
          excludedAt: now,
          updatedAt: now,
        });
      }
      const next = parseConfig({
        ...config,
        sources: { ...config.sources, codexHomes: [...resolution.homes] },
      });
      await saveConfigAtomically(next, options.configPath);
      return {
        status: discovered.length === 0 ? "no_source" : "ok",
        configuredHomes: resolution.homes.length,
        discoveredSources: discovered.length,
        sourceKinds: countBy(discovered.map((source) => source.kind)),
        projects: await Promise.all(projectPreview.projects.map(async (project) => ({
          ...project,
          availability: await storage.scopes.getAvailability({ projectId: project.projectId }),
        }))),
        projectPreviewTruncated: projectPreview.truncated,
        unmappedSessions: projectPreview.unmappedSessions,
        diagnostics: resolution.diagnostics.map((diagnostic) => ({ code: diagnostic.code })),
        configWritten: true,
        semanticModel: {
          status: config.embeddings.enabled ? "configured" : "not_configured",
          optional: true,
        },
      };
    },
    async listSources() {
      const health = await runtime.inspectSourceHealth();
      return {
        status: health.summaries.length === 0 ? "no_source" : "ok",
        sources: health.summaries,
        diagnostics: health.diagnostics,
      };
    },
    async index(input) {
      const result = await runtime.runIndexCycle();
      return {
        ...result,
        initial: input.initial,
      };
    },
    async doctor() {
      const sourceHealth = await runtime.inspectSourceHealth();
      const scopes = await storage.scopes.listCandidates(undefined, 1_000);
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      const staleSources = sourceHealth.summaries.filter((source) => source.status !== "current").length;
      const healthy = nodeMajor >= 24 && storage.startup.capabilities.fts5;
      return {
        status: healthy ? "ok" : "unhealthy",
        node: { version: process.versions.node, supported: nodeMajor >= 24 },
        sqlite: {
          version: storage.startup.capabilities.sqliteVersion,
          journalMode: storage.startup.capabilities.journalMode,
          fts5: storage.startup.capabilities.fts5,
          schemaVersion: storage.startup.migration.currentVersion,
        },
        sources: {
          discovered: sourceHealth.summaries.length,
          stale: staleSources,
          diagnostics: sourceHealth.diagnostics,
        },
        scopes: {
          selected: scopes.filter((scope) => scope.availability === "selected").length,
          excluded: scopes.filter((scope) => scope.availability !== "selected").length,
          truncated: scopes.length === 1_000,
        },
        vector: {
          backend: config.vector.backend,
          embeddingsEnabled: config.embeddings.enabled,
          status: config.embeddings.enabled ? "runtime_not_started" : "disabled",
        },
        mcp: {
          stdio: "available",
          readOnlyTools: 4,
          sessionMentions: "available",
          loopbackHttp: `http://${config.runtime.host}:${config.runtime.port}/mcp`,
          authentication: "local_bearer_token",
        },
        tunnel: { status: "not_checked" },
      };
    },
    reindex: (input) => reindex({ ...input, chunkPolicy: runtimeChunkPolicy(config) }, { storage }),
    forget: (input) => forgetScope(input, { scopes: storage.scopes }),
    async exportScope(input, outputPath) {
      const result = await exportScopeUseCase(input, {
        ...shared,
        budgetLimits: budgetLimits(config, config.retrieval.overviewMaxTokens),
        cursorSecret,
      });
      if (outputPath === undefined) return result;
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      const handle = await open(outputPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return { status: result.status, format: result.format, exportedAt: result.exportedAt, written: true };
    },
    service: (action: ServiceAction) => serviceManager.execute(action),
    async serveStdio() {
      const handle = serveMcpStdio(readApp);
      const keepAlive = setInterval(() => undefined, 60_000);
      try {
        await handle.closed;
      } finally {
        clearInterval(keepAlive);
        await handle.close();
      }
    },
    async serveHttp() {
      const daemon = await startRuntimeDaemon(runtime);
      const shutdown = listenForShutdownSignals();
      try {
        await shutdown.signal;
      } finally {
        shutdown.dispose();
        await daemon.stop();
      }
    },
    close: () => runtime.close(),
  };
}

async function previewProjects(
  adapter: CodexSourceAdapter,
  sources: readonly SourceRef[],
): Promise<{
  readonly projects: readonly {
    readonly projectId: ReturnType<typeof projectIdFromRemote>;
    readonly displayName: string;
    readonly sessions: number;
  }[];
  readonly unmappedSessions: number;
  readonly truncated: boolean;
}> {
  const limit = 200;
  const byId = new Map<string, {
    projectId: ReturnType<typeof projectIdFromRemote>;
    displayName: string;
    sessions: number;
  }>();
  let unmappedSessions = 0;
  for (const source of sources.filter((candidate) => candidate.kind === "codex_rollout").slice(0, limit)) {
    try {
      const batch = await adapter.readBatch(source, undefined, { maxBytes: 256 * 1_024, maxRecords: 1 });
      const payload = batch.records.find((record) => isCodexSourcePayload(record.payload))?.payload;
      if (!isCodexSourcePayload(payload) || payload.parsed.origin !== "rollout" ||
          payload.parsed.value.kind !== "session_meta") {
        unmappedSessions += 1;
        continue;
      }
      const remoteValue = payload.parsed.value.git?.repositoryUrl;
      const remote = remoteValue === undefined ? undefined : normalizeGitRemote(remoteValue);
      if (remote === undefined || !remote.ok) {
        unmappedSessions += 1;
        continue;
      }
      const projectId = projectIdFromRemote(remote.remote.canonical);
      const existing = byId.get(projectId);
      if (existing !== undefined) {
        existing.sessions += 1;
        continue;
      }
      byId.set(projectId, {
        projectId,
        displayName: remote.remote.repositoryPath.split("/").at(-1) ?? "project",
        sessions: 1,
      });
    } catch {
      unmappedSessions += 1;
    }
  }
  return {
    projects: [...byId.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName) || left.projectId.localeCompare(right.projectId)),
    unmappedSessions,
    truncated: sources.filter((source) => source.kind === "codex_rollout").length > limit,
  };
}

function sourceConfiguration(
  homes: readonly string[],
  config: ContextBridgeConfig,
): SourceConfig {
  return {
    roots: homes,
    includeHistory: config.sources.includeHistory,
    includeSessionIndex: config.sources.includeSessionIndex,
  };
}

function budgetLimits(
  config: ContextBridgeConfig,
  maxTokens: number,
) {
  return {
    maxItems: config.retrieval.maxItems,
    maxBytes: config.retrieval.maxBytes,
    maxTokens,
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
