// Orchestrates the ingestion pipeline
// Discovers the sources, priortise them, calls the reading func
// write the data to database etc. 

import { basename } from "node:path";

import type { SessionId, SourceId } from "../contracts/ids.js";
import type { Storage } from "../contracts/ports.js";
import type { CanonicalEvent } from "../contracts/evidence.js";
import type { SessionRef } from "../contracts/scope.js";

import type {
  ReadLimit,
  SourceAdapter,
  SourceConfig,
  SourceRef,
} from "../contracts/source.js";

import { commitIngestBatch } from "./commit.js";

import {
  reconcileSources,
  type SourceReconciliation,
} from "./reconcile-sources.js";

import { scanOnce } from "./scan.js";
import {
  resolveProject,
  type SessionProjectMetadata,
} from "../sources/git/project-mapper.js";

import { normalizeGitRemote } from "../sources/git/remote.js";

export interface IngestionSchedulerOptions {
  readonly adapter: SourceAdapter;
  readonly storage: Storage;
  readonly readLimit: ReadLimit;
  readonly maxSourcesPerRun?: number;
  readonly maxBatchesPerSource?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly mapProjects?: boolean;
  readonly allowUnmapped?: boolean;
  readonly now?: () => Date;
}

export interface SourceIngestionResult {
  readonly sourceId: SourceId;
  readonly status: "committed" | "deferred" | "failed";
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

export interface IngestionRunResult {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly reconciliation: readonly SourceReconciliation[];
  readonly sources: readonly SourceIngestionResult[];
  readonly totals: {
    readonly discoveredSources: number;
    readonly attemptedSources: number;
    readonly batches: number;
    readonly recordsRead: number;
    readonly insertedEvents: number;
    readonly duplicateEvents: number;
    readonly skippedEvents: number;
    readonly diagnostics: number;
    readonly laggingSources: number;
    readonly failedSources: number;
  };
}

export interface PollIngestionOptions {
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly onRun?: (result: IngestionRunResult) => void | Promise<void>;
}

interface FailureState {
  readonly attempts: number;
  readonly retryAtMs: number;
}

export class IngestionScheduler {
  private readonly adapter: SourceAdapter;
  private readonly storage: Storage;
  private readonly readLimit: ReadLimit;
  private readonly maxSourcesPerRun: number;
  private readonly maxBatchesPerSource: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly mapProjects: boolean;
  private readonly allowUnmapped: boolean;
  private readonly now: () => Date;
  private readonly failures = new Map<SourceId, FailureState>();
  private readonly sessionMetadata = new Map<SessionId, SessionProjectMetadata>();
  private readonly sessionScopes = new Map<SessionId, SessionRef | null>();

  constructor(options: IngestionSchedulerOptions) {
    const maxSourcesPerRun = options.maxSourcesPerRun ?? 10_000;
    const maxBatchesPerSource = options.maxBatchesPerSource ?? 1_000;
    const baseBackoffMs = options.baseBackoffMs ?? 1_000;
    const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
    validateOptions(
      maxSourcesPerRun,
      maxBatchesPerSource,
      baseBackoffMs,
      maxBackoffMs,
    );
    this.adapter = options.adapter;
    this.storage = options.storage;
    this.readLimit = options.readLimit;
    this.maxSourcesPerRun = maxSourcesPerRun;
    this.maxBatchesPerSource = maxBatchesPerSource;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.mapProjects = options.mapProjects ?? true;
    this.allowUnmapped = options.allowUnmapped ?? false;
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(config: SourceConfig): Promise<IngestionRunResult> {
    const startedAt = this.now().toISOString();
    const [discovered, persisted] = await Promise.all([
      this.adapter.discover(config),
      this.storage.sources.listSources(),
    ]);
    const reconciliation = reconcileSources(persisted, discovered);
    const prioritized = [...discovered]
      .sort(
        (left, right) =>
          right.fileIdentity.modifiedAtMs - left.fileIdentity.modifiedAtMs ||
          left.normalizedPath.localeCompare(right.normalizedPath),
      )
      .slice(0, this.maxSourcesPerRun);
    const sources: SourceIngestionResult[] = [];

    for (const source of prioritized) {
      sources.push(await this.ingestSource(source));
    }

    const totals = summarize(discovered.length, sources);
    return {
      startedAt,
      completedAt: this.now().toISOString(),
      reconciliation,
      sources,
      totals,
    };
  }

  async poll(config: SourceConfig, options: PollIngestionOptions): Promise<void> {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100) {
      throw new RangeError("Polling interval must be at least 100 milliseconds");
    }
    while (!options.signal.aborted) {
      const result = await this.runOnce(config);
      await options.onRun?.(result);
      await waitForNextPoll(options.intervalMs, options.signal);
    }
  }

  private async ingestSource(source: SourceRef): Promise<SourceIngestionResult> {
    const failure = this.failures.get(source.id);
    const nowMs = this.now().getTime();
    if (failure !== undefined && failure.retryAtMs > nowMs) {
      return emptySourceResult(source.id, "deferred", true, {
        retryAt: new Date(failure.retryAtMs).toISOString(),
      });
    }

    let batches = 0;
    let recordsRead = 0;
    let insertedEvents = 0;
    let duplicateEvents = 0;
    let skippedEvents = 0;
    let diagnostics = 0;
    let hasMore = false;

    try {
      let currentSource = source;
      let cursor = await this.storage.sources.getCursor(source.id);
      do {
        const scan = await scanOnce(
          this.adapter,
          currentSource,
          cursor,
          this.readLimit,
        );
        for (const metadata of scan.sessionMetadata) {
          this.sessionMetadata.set(metadata.sessionId, metadata);
        }
        const scoped = await this.filterEventsByScope(scan.events);
        const committed = await commitIngestBatch(this.storage.evidence, {
          ...scan,
          events: scoped.events,
        });
        batches += 1;
        recordsRead += scan.recordsRead;
        insertedEvents += committed.insertedEvents;
        duplicateEvents += committed.duplicateEvents + scan.duplicatesCollapsed;
        skippedEvents += scoped.skippedEvents;
        diagnostics += scan.diagnostics.length;
        hasMore = scan.hasMore;
        currentSource = scan.source;
        cursor = scan.proposedCursor;
      } while (hasMore && batches < this.maxBatchesPerSource);

      this.failures.delete(source.id);
      return {
        sourceId: source.id,
        status: "committed",
        batches,
        recordsRead,
        insertedEvents,
        duplicateEvents,
        skippedEvents,
        diagnostics,
        hasMore,
      };
    } catch (error) {
      const next = nextFailure(failure, nowMs, this.baseBackoffMs, this.maxBackoffMs);
      this.failures.set(source.id, next);
      return {
        sourceId: source.id,
        status: "failed",
        batches,
        recordsRead,
        insertedEvents,
        duplicateEvents,
        skippedEvents,
        diagnostics,
        hasMore,
        errorCode: safeErrorCode(error),
        retryAt: new Date(next.retryAtMs).toISOString(),
      };
    }
  }

  private async filterEventsByScope(
    events: readonly CanonicalEvent[],
  ): Promise<{ readonly events: readonly CanonicalEvent[]; readonly skippedEvents: number }> {
    if (!this.mapProjects || events.length === 0) {
      return { events, skippedEvents: 0 };
    }
    const allowed = new Map<SessionId, boolean>();
    for (const event of events) {
      if (!allowed.has(event.sessionId)) {
        const scope = await this.resolveSessionScope(event.sessionId, events);
        if (scope === undefined) {
          allowed.set(event.sessionId, this.allowUnmapped);
        } else {
          const availability = await this.storage.scopes.getAvailability({
            projectId: scope.projectId,
            ...(scope.workstreamId === undefined
              ? {}
              : { workstreamId: scope.workstreamId }),
            sessionId: scope.id,
          });
          allowed.set(event.sessionId, availability === "selected");
        }
      }
    }
    const accepted = events.filter((event) => allowed.get(event.sessionId) === true);
    return { events: accepted, skippedEvents: events.length - accepted.length };
  }

  private async resolveSessionScope(
    sessionId: SessionId,
    events: readonly CanonicalEvent[],
  ): Promise<SessionRef | undefined> {
    const cached = this.sessionScopes.get(sessionId);
    if (cached !== undefined) return cached ?? undefined;

    const existing = await this.storage.scopes.getSession(sessionId);
    if (existing !== undefined) {
      this.sessionScopes.set(sessionId, existing);
      return existing;
    }

    const metadata = this.sessionMetadata.get(sessionId);
    if (metadata === undefined) {
      this.sessionScopes.set(sessionId, null);
      return undefined;
    }
    const mappings = await this.storage.scopes.getExplicitMappings(sessionId);
    const resolution = await resolveProject(metadata, mappings);
    if (resolution.status !== "mapped") {
      this.sessionScopes.set(sessionId, null);
      return undefined;
    }

    const target = resolution.mapping.target;
    const activity = observedRange(
      events.filter((event) => event.sessionId === sessionId),
    );
    const existingProject = await this.storage.scopes.get({
      projectId: target.projectId,
    });
    if (existingProject === undefined) {
      await this.storage.scopes.upsertScopes([
        {
          kind: "project",
          id: target.projectId,
          displayName: projectDisplayName(metadata, target.projectId),
          ...(activity.last === undefined ? {} : { lastActivityAt: activity.last }),
        },
      ]);
    }
    const scope: SessionRef = {
      kind: "session",
      id: sessionId,
      projectId: target.projectId,
      ...(target.workstreamId === undefined
        ? {}
        : { workstreamId: target.workstreamId }),
      ...(metadata.git?.branch === undefined
        ? {}
        : { branch: metadata.git.branch }),
      ...(metadata.git?.commitHash === undefined
        ? {}
        : { headCommit: metadata.git.commitHash }),
      ...(activity.first === undefined ? {} : { startedAt: activity.first }),
      ...(activity.last === undefined ? {} : { lastActivityAt: activity.last }),
    };
    await this.storage.scopes.upsertScopes([scope]);
    this.sessionScopes.set(sessionId, scope);
    return scope;
  }
}

function emptySourceResult(
  sourceId: SourceId,
  status: "deferred",
  hasMore: boolean,
  extra: { readonly retryAt: string },
): SourceIngestionResult {
  return {
    sourceId,
    status,
    batches: 0,
    recordsRead: 0,
    insertedEvents: 0,
    duplicateEvents: 0,
    skippedEvents: 0,
    diagnostics: 0,
    hasMore,
    retryAt: extra.retryAt,
  };
}

function nextFailure(
  previous: FailureState | undefined,
  nowMs: number,
  baseMs: number,
  maximumMs: number,
): FailureState {
  const attempts = (previous?.attempts ?? 0) + 1;
  const delay = Math.min(maximumMs, baseMs * 2 ** Math.min(attempts - 1, 20));
  return { attempts, retryAtMs: nowMs + delay };
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,64}$/u.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)) {
    return error.name;
  }
  return "INGESTION_ERROR";
}

function summarize(
  discoveredSources: number,
  sources: readonly SourceIngestionResult[],
): IngestionRunResult["totals"] {
  return {
    discoveredSources,
    attemptedSources: sources.filter((source) => source.status !== "deferred").length,
    batches: sum(sources, "batches"),
    recordsRead: sum(sources, "recordsRead"),
    insertedEvents: sum(sources, "insertedEvents"),
    duplicateEvents: sum(sources, "duplicateEvents"),
    skippedEvents: sum(sources, "skippedEvents"),
    diagnostics: sum(sources, "diagnostics"),
    laggingSources:
      Math.max(0, discoveredSources - sources.length) +
      sources.filter((source) => source.hasMore).length,
    failedSources: sources.filter((source) => source.status === "failed").length,
  };
}

function sum(
  sources: readonly SourceIngestionResult[],
  key:
    | "batches"
    | "recordsRead"
    | "insertedEvents"
    | "duplicateEvents"
    | "skippedEvents"
    | "diagnostics",
): number {
  return sources.reduce((total, source) => total + source[key], 0);
}

function observedRange(events: readonly CanonicalEvent[]): {
  readonly first?: string;
  readonly last?: string;
} {
  const timestamps = events
    .flatMap((event) => (event.observedAt === undefined ? [] : [event.observedAt]))
    .sort();
  const first = timestamps[0];
  const last = timestamps.at(-1);
  return {
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
  };
}

function projectDisplayName(
  metadata: SessionProjectMetadata,
  projectId: string,
): string {
  const remote = metadata.git?.repositoryUrl;
  if (remote !== undefined) {
    const normalized = normalizeGitRemote(remote);
    if (normalized.ok) {
      const name = normalized.remote.repositoryPath.split("/").at(-1);
      if (name !== undefined && name.length > 0) return name;
    }
  }
  if (metadata.cwd !== undefined) {
    const name = basename(metadata.cwd);
    if (name.length > 0) return name;
  }
  return `Project ${projectId.slice(-12)}`;
}

function waitForNextPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function validateOptions(
  maxSourcesPerRun: number,
  maxBatchesPerSource: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
): void {
  const values = [
    maxSourcesPerRun,
    maxBatchesPerSource,
    baseBackoffMs,
    maxBackoffMs,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError("Invalid ingestion scheduler limits");
  }
  if (baseBackoffMs > maxBackoffMs) {
    throw new RangeError("Ingestion backoff base exceeds its maximum");
  }
}
