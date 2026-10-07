import { join } from "node:path";

import {
  getContextOverview,
  getEvidence,
  indexSources,
  listContextScopes,
  reindex,
  searchMemory,
} from "../app/index.js";
import { loadConfig } from "../config/load.js";
import type { ContextBridgeConfig } from "../config/schema.js";
import {
  ensurePrivateDirectories,
  resolveAppDataPaths,
  resolveCodexHomes,
  type AppDataPaths,
} from "../config/paths.js";
import { parseSessionId } from "../contracts/ids.js";
import type { ScopeAddress, SessionRef } from "../contracts/scope.js";
import type { SourceConfig } from "../contracts/source.js";
import { IngestionScheduler } from "../ingestion/index.js";
import {
  sessionResourceUri,
  type McpReadApplication,
  type McpSessionReference,
} from "../mcp/index.js";
import { heuristicTokenizer } from "../processing/chunks/index.js";
import { loadOrCreateLocalSecret } from "../security/local-auth.js";
import { DefaultOutputPolicy, LocalAuthorizationPolicy } from "../security/output-policy.js";
import { CodexSourceAdapter } from "../sources/codex/adapter.js";
import { openSqliteStorage, type SqliteStorage } from "../storage/sqlite/index.js";

export interface RuntimeApplicationOptions {
  readonly configPath?: string;
}

export interface RuntimeIndexResult {
  readonly status: "ok" | "partial" | "failed" | "no_source";
  readonly ingestion: Awaited<ReturnType<typeof indexSources>>;
  readonly processing: {
    readonly projects: number;
    readonly sessions: number;
    readonly failedSessions: number;
  };
}

export interface RuntimeSourceHealth {
  readonly summaries: readonly {
    readonly sourceId: string;
    readonly kind: string;
    readonly formatVersion: string;
    readonly sizeBytes: number;
    readonly modifiedAt: string;
    readonly indexedBytes: number;
    readonly lagBytes: number;
    readonly status: "missing" | "not_indexed" | "stale" | "current";
  }[];
  readonly diagnostics: readonly { readonly code: string }[];
}

export interface RuntimeApplication {
  readonly config: ContextBridgeConfig;
  readonly paths: AppDataPaths;
  readonly storage: SqliteStorage;
  readonly adapter: CodexSourceAdapter;
  readonly ingestion: IngestionScheduler;
  readonly sourceConfig: SourceConfig;
  readonly readApp: McpReadApplication;
  readonly httpSecret: string;
  readonly cursorSecret: string;
  inspectSourceHealth(): Promise<RuntimeSourceHealth>;
  runIndexCycle(options?: { readonly processExisting?: boolean }): Promise<RuntimeIndexResult>;
  close(): Promise<void>;
}

export async function createRuntimeApplication(
  options: RuntimeApplicationOptions = {},
): Promise<RuntimeApplication> {
  const config = await loadConfig(options.configPath);
  const paths = resolveAppDataPaths({
    ...(config.paths.dataDir === undefined ? {} : { dataDir: config.paths.dataDir }),
    ...(config.paths.cacheDir === undefined ? {} : { cacheDir: config.paths.cacheDir }),
    ...(config.paths.modelCacheDir === undefined ? {} : { modelCacheDir: config.paths.modelCacheDir }),
    ...(config.paths.logsDir === undefined ? {} : { logsDir: config.paths.logsDir }),
    ...(config.paths.exportsDir === undefined ? {} : { exportsDir: config.paths.exportsDir }),
    ...(options.configPath === undefined ? {} : { configFile: options.configPath }),
  });
  await ensurePrivateDirectories(paths);
  const storage = await openSqliteStorage({
    databaseFile: paths.databaseFile,
    busyTimeoutMs: config.storage.sqliteBusyTimeoutMs,
  });
  try {
    const adapter = new CodexSourceAdapter({
      maxNormalizedTextCharacters: config.processing.maxToolOutputCharacters,
    });
    const homes = await resolveCodexHomes({ configuredHomes: config.sources.codexHomes });
    const sourceConfig = sourceConfiguration(homes.homes, config);
    const ingestion = new IngestionScheduler({
      adapter,
      storage,
      readLimit: {
        maxBytes: config.sources.maxReadBytes,
        maxRecords: config.sources.maxRecordsPerBatch,
      },
    });
    const [cursorSecret, httpSecret] = await Promise.all([
      loadOrCreateLocalSecret(join(paths.stateDir, "cursor-secret"), paths.platform),
      loadOrCreateLocalSecret(join(paths.stateDir, "http-secret"), paths.platform),
    ]);
    const authorization = new LocalAuthorizationPolicy(storage.scopes);
    const outputPolicy = new DefaultOutputPolicy({
      limits: {
        maxItems: config.retrieval.maxItems,
        maxBytes: config.retrieval.maxBytes,
        maxTokens: Math.max(
          config.retrieval.searchMaxTokens,
          config.retrieval.overviewMaxTokens,
          config.retrieval.evidenceMaxTokens,
        ),
      },
      tokenizer: heuristicTokenizer,
    });
    const shared = { storage, authorization, outputPolicy, tokenizer: heuristicTokenizer };
    const overview = (scope: ScopeAddress) => getContextOverview({ scope }, {
      ...shared,
      budgetLimits: budgetLimits(config, config.retrieval.overviewMaxTokens),
      cursorSecret,
    });
    const readApp: McpReadApplication = {
      listContextScopes: (input) => listContextScopes(input, {
        ...shared,
        budgetLimits: budgetLimits(config, config.retrieval.overviewMaxTokens),
      }),
      getContextOverview: (input) => getContextOverview(input, {
        ...shared,
        budgetLimits: budgetLimits(config, config.retrieval.overviewMaxTokens),
        cursorSecret,
      }),
      searchMemory: (input) => searchMemory(input, {
        ...shared,
        budgetLimits: budgetLimits(config, config.retrieval.searchMaxTokens),
        cursorSecret,
        candidateLimitPerChannel: config.retrieval.candidateLimitPerChannel,
      }),
      getEvidence: (input) => getEvidence(input, {
        ...shared,
        budgetLimits: budgetLimits(config, config.retrieval.evidenceMaxTokens),
      }),
      async searchSessionReferences(query) {
        const normalized = query.normalize("NFKC").trim().toLowerCase();
        const candidates = await storage.scopes.listCandidates(undefined, 1_000);
        const sessions = candidates
          .filter((candidate): candidate is typeof candidate & { readonly scope: SessionRef } =>
            candidate.scope.kind === "session" && candidate.availability === "selected")
          .map((candidate) => candidate.scope)
          .filter((session) => sessionMatches(session, normalized))
          .sort((left, right) =>
            (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "") ||
            left.id.localeCompare(right.id));
        const references: McpSessionReference[] = [];
        for (const session of sessions.slice(0, 20)) {
          const scope = sessionAddress(session);
          if (!(await authorization.authorizeScope(scope, "list_scopes")).allowed) continue;
          const project = await storage.scopes.get({ projectId: session.projectId });
          const projectName = project?.kind === "project" ? project.displayName : "project";
          const title = await outputPolicy.sanitizeText(sessionTitle(session));
          const subtitle = await outputPolicy.sanitizeText([
            projectName,
            session.branch,
            session.lastActivityAt?.slice(0, 10),
          ].filter((value): value is string => value !== undefined).join(" · "));
          references.push({
            uri: sessionResourceUri(session.id),
            title,
            ...(subtitle.length === 0 ? {} : { subtitle }),
            description: "Saved, historical Codex session context",
            ...(session.lastActivityAt === undefined ? {} : { lastModified: session.lastActivityAt }),
          });
        }
        return references;
      },
      async readSessionReference(uri) {
        const sessionId = parseSessionResourceUri(uri);
        if (sessionId === undefined) return undefined;
        const session = await storage.scopes.getSession(sessionId);
        if (session === undefined) return undefined;
        const scope = sessionAddress(session);
        if ((await authorization.authorizeScope(scope, "get_overview")).allowed === false) return undefined;
        return {
          schemaVersion: 1,
          kind: "codex_session_reference",
          resourceUri: sessionResourceUri(session.id),
          session: {
            id: session.id,
            projectId: session.projectId,
            ...(session.workstreamId === undefined ? {} : { workstreamId: session.workstreamId }),
            title: await outputPolicy.sanitizeText(sessionTitle(session)),
            ...(session.branch === undefined ? {} : { branch: await outputPolicy.sanitizeText(session.branch) }),
            ...(session.lastActivityAt === undefined ? {} : { lastActivityAt: session.lastActivityAt }),
          },
          overview: await overview(scope),
        };
      },
    };

    const inspectSourceHealth = async (): Promise<RuntimeSourceHealth> => {
      const [liveSources, persistedSources] = await Promise.all([
        adapter.discover(sourceConfig),
        storage.sources.listSources(),
      ]);
      const liveIds = new Set(liveSources.map((source) => source.id));
      const combined = [...liveSources, ...persistedSources.filter((source) => !liveIds.has(source.id))];
      const summaries = await Promise.all(combined.map(async (source) => {
        const cursor = await storage.sources.getCursor(source.id);
        const missing = !liveIds.has(source.id);
        const status: RuntimeSourceHealth["summaries"][number]["status"] = missing
          ? "missing"
          : cursor === undefined
            ? "not_indexed"
            : cursor.committedByteOffset < source.fileIdentity.size ? "stale" : "current";
        return {
          sourceId: source.id,
          kind: source.kind,
          formatVersion: source.formatVersion,
          sizeBytes: source.fileIdentity.size,
          modifiedAt: new Date(source.fileIdentity.modifiedAtMs).toISOString(),
          indexedBytes: cursor?.committedByteOffset ?? 0,
          lagBytes: Math.max(0, source.fileIdentity.size - (cursor?.committedByteOffset ?? 0)),
          status,
        };
      }));
      return {
        summaries,
        diagnostics: adapter.getDiscoveryDiagnostics().map((diagnostic) => ({ code: diagnostic.code })),
      };
    };

    const runIndexCycle = async (
      cycleOptions: { readonly processExisting?: boolean } = {},
    ): Promise<RuntimeIndexResult> => {
      const ingestionResult = await indexSources({ sourceConfig }, { ingestion });
      const shouldProcess = cycleOptions.processExisting !== false || ingestionResult.totals.insertedEvents > 0;
      const processing = shouldProcess
        ? await processSelectedProjects(storage, config)
        : [];
      return {
        status: combinedIndexStatus(ingestionResult.status, processing),
        ingestion: ingestionResult,
        processing: {
          projects: processing.length,
          sessions: processing.reduce((total, result) => total + result.sessions.length, 0),
          failedSessions: processing.reduce(
            (total, result) => total + result.sessions.filter((session) => session.status === "failed").length,
            0,
          ),
        },
      };
    };

    let closed = false;
    return {
      config,
      paths,
      storage,
      adapter,
      ingestion,
      sourceConfig,
      readApp,
      httpSecret,
      cursorSecret,
      inspectSourceHealth,
      runIndexCycle,
      async close() {
        if (closed) return;
        closed = true;
        await storage.close();
      },
    };
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
}

function sourceConfiguration(homes: readonly string[], config: ContextBridgeConfig): SourceConfig {
  return {
    roots: homes,
    includeHistory: config.sources.includeHistory,
    includeSessionIndex: config.sources.includeSessionIndex,
  };
}

function budgetLimits(config: ContextBridgeConfig, maxTokens: number) {
  return { maxItems: config.retrieval.maxItems, maxBytes: config.retrieval.maxBytes, maxTokens };
}

export function runtimeChunkPolicy(config: ContextBridgeConfig) {
  return {
    targetTokens: config.processing.chunkTargetTokens,
    maxTokens: config.processing.chunkMaxTokens,
    maxToolOutputCharacters: config.processing.maxToolOutputCharacters,
    tokenizer: heuristicTokenizer,
  };
}

async function processSelectedProjects(storage: SqliteStorage, config: ContextBridgeConfig) {
  const candidates = await storage.scopes.listCandidates(undefined, 1_000);
  const projects = candidates
    .flatMap((candidate) => candidate.scope.kind === "project" && candidate.availability === "selected"
      ? [candidate.scope]
      : [])
    .filter((scope, index, all) => all.findIndex((candidate) => candidate.id === scope.id) === index);
  const results = [];
  for (const project of projects) {
    results.push(await reindex({
      scope: { projectId: project.id },
      chunkPolicy: runtimeChunkPolicy(config),
    }, { storage }));
  }
  return results;
}

function combinedIndexStatus(
  ingestionStatus: "ok" | "partial" | "failed" | "no_source",
  processing: readonly { readonly status: string }[],
): RuntimeIndexResult["status"] {
  if (ingestionStatus === "failed") return "failed";
  if (ingestionStatus === "no_source" && processing.length === 0) return "no_source";
  if (ingestionStatus === "partial" || processing.some((result) => result.status === "partial")) return "partial";
  return "ok";
}

function sessionAddress(session: SessionRef): ScopeAddress {
  return {
    projectId: session.projectId,
    ...(session.workstreamId === undefined ? {} : { workstreamId: session.workstreamId }),
    sessionId: session.id,
  };
}

function sessionTitle(session: SessionRef): string {
  if (session.title !== undefined && session.title.trim().length > 0) return session.title;
  const date = session.lastActivityAt?.slice(0, 10) ?? session.startedAt?.slice(0, 10);
  return ["Codex session", date, session.branch].filter((value) => value !== undefined).join(" · ");
}

function sessionMatches(session: SessionRef, query: string): boolean {
  if (query.length === 0) return true;
  return [session.id, session.title, session.branch, session.headCommit, session.startedAt, session.lastActivityAt]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.normalize("NFKC").toLowerCase().includes(query));
}

function parseSessionResourceUri(value: string) {
  try {
    const uri = new URL(value);
    if (uri.protocol !== "context-bridge:" || uri.hostname !== "sessions" || uri.search || uri.hash) return undefined;
    const encoded = uri.pathname.replace(/^\//u, "");
    if (encoded.length === 0 || encoded.includes("/")) return undefined;
    return parseSessionId(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
}
