// Recursively traverse the directories to get the history.jsonl and session.jsonl
// files and forms the data structures as defined in the contracts and forms the 
// generalised source kind objects.

// All other kind of files related to auth, cache, symbolic files etc are ignored.

import { lstat, opendir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { SourceKind, SourceRef } from "../../contracts/source.js";
import {
  canReadSource,
  type SourceDenialReason,
} from "../../security/source-policy.js";

import {
  CODEX_FORMAT_VERSION,
  codexSourceId,
  fileIdentityFromStats,
  normalizeCodexPath,
} from "./identity.js";

export interface DiscoverCodexOptions {
  readonly includeHistory?: boolean;
  readonly includeSessionIndex?: boolean;
  readonly excludedRoots?: readonly string[];
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

export type CodexDiscoveryDiagnosticCode =
  | "HOME_NOT_FOUND"
  | "HOME_NOT_DIRECTORY"
  | "HOME_SYMBOLIC_LINK"
  | "HOME_UNREADABLE"
  | "SESSIONS_NOT_FOUND"
  | "OPTIONAL_SOURCE_NOT_FOUND"
  | "SOURCE_REJECTED"
  | "SCAN_LIMIT_REACHED";

export interface CodexDiscoveryDiagnostic {
  readonly code: CodexDiscoveryDiagnosticCode;
  readonly path: string;
  readonly reason?: SourceDenialReason;
}

export interface CodexDiscoveryResult {
  readonly sources: readonly SourceRef[];
  readonly diagnostics: readonly CodexDiscoveryDiagnostic[];
}

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_DEPTH = 8;

export async function discoverCodexSources(
  homes: readonly string[],
  options: DiscoverCodexOptions = {},
): Promise<CodexDiscoveryResult> {
  const includeHistory = options.includeHistory ?? true;
  const includeSessionIndex = options.includeSessionIndex ?? true;
  const excludedRoots = options.excludedRoots ?? [];
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  validateLimits(maxEntries, maxDepth);

  const normalizedHomes = [...new Set(homes.map((home) => resolve(home)))];
  const sources = new Map<string, SourceRef>();
  const diagnostics: CodexDiscoveryDiagnostic[] = [];
  let visitedEntries = 0;
  let scanLimitReached = false;

  for (const home of normalizedHomes) {
    if (scanLimitReached) break;
    let homeDetails;
    try {
      homeDetails = await lstat(home);
    } catch (error) {
      diagnostics.push({
        code: getErrorCode(error) === "ENOENT" ? "HOME_NOT_FOUND" : "HOME_UNREADABLE",
        path: home,
      });
      continue;
    }
    if (homeDetails.isSymbolicLink()) {
      diagnostics.push({ code: "HOME_SYMBOLIC_LINK", path: home });
      continue;
    }
    if (!homeDetails.isDirectory()) {
      diagnostics.push({ code: "HOME_NOT_DIRECTORY", path: home });
      continue;
    }

    const policyConfig = {
      codexHomes: normalizedHomes,
      excludedRoots,
      includeHistory,
      includeSessionIndex,
    };
    if (includeHistory) {
      await addOptionalRootSource(
        join(home, "history.jsonl"),
        policyConfig,
        sources,
        diagnostics,
      );
    }
    if (includeSessionIndex) {
      await addOptionalRootSource(
        join(home, "session_index.jsonl"),
        policyConfig,
        sources,
        diagnostics,
      );
    }

    const sessionsRoot = join(home, "sessions");
    let sessionsDetails;
    try {
      sessionsDetails = await lstat(sessionsRoot);
    } catch (error) {
      diagnostics.push({
        code:
          getErrorCode(error) === "ENOENT"
            ? "SESSIONS_NOT_FOUND"
            : "HOME_UNREADABLE",
        path: sessionsRoot,
      });
      continue;
    }
    if (!sessionsDetails.isDirectory() || sessionsDetails.isSymbolicLink()) {
      diagnostics.push({ code: "HOME_UNREADABLE", path: sessionsRoot });
      continue;
    }

    const pending: Array<{ readonly path: string; readonly depth: number }> = [
      { path: sessionsRoot, depth: 0 },
    ];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;

      let directory;
      try {
        directory = await opendir(current.path);
      } catch {
        diagnostics.push({ code: "HOME_UNREADABLE", path: current.path });
        continue;
      }

      try {
        for await (const entry of directory) {
          visitedEntries += 1;
          if (visitedEntries > maxEntries) {
            diagnostics.push({
              code: "SCAN_LIMIT_REACHED",
              path: current.path,
            });
            pending.length = 0;
            scanLimitReached = true;
            break;
          }

          const candidate = join(current.path, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (current.depth < maxDepth) {
              pending.push({ path: candidate, depth: current.depth + 1 });
            }
            continue;
          }
          if (
            entry.isFile() &&
            basename(candidate).startsWith("rollout-") &&
            candidate.endsWith(".jsonl")
          ) {
            await addApprovedSource(
              candidate,
              policyConfig,
              sources,
              diagnostics,
            );
          }
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    }
  }

  return {
    sources: [...sources.values()].sort((left, right) =>
      left.normalizedPath.localeCompare(right.normalizedPath),
    ),
    diagnostics,
  };
}

async function addOptionalRootSource(
  path: string,
  config: Parameters<typeof canReadSource>[1],
  sources: Map<string, SourceRef>,
  diagnostics: CodexDiscoveryDiagnostic[],
): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    diagnostics.push({
      code:
        getErrorCode(error) === "ENOENT"
          ? "OPTIONAL_SOURCE_NOT_FOUND"
          : "HOME_UNREADABLE",
      path,
    });
    return;
  }
  await addApprovedSource(path, config, sources, diagnostics);
}

async function addApprovedSource(
  path: string,
  config: Parameters<typeof canReadSource>[1],
  sources: Map<string, SourceRef>,
  diagnostics: CodexDiscoveryDiagnostic[],
): Promise<void> {
  const decision = await canReadSource(path, config);
  if (!decision.allowed) {
    diagnostics.push({
      code: "SOURCE_REJECTED",
      path: decision.path,
      reason: decision.reason,
    });
    return;
  }

  try {
    const details = await stat(decision.path);
    const normalizedPath = normalizeCodexPath(decision.path);
    const source = createSourceRef(
      decision.sourceKind,
      normalizedPath,
      fileIdentityFromStats(details),
    );
    sources.set(`${source.kind}:${source.normalizedPath}`, source);
  } catch {
    diagnostics.push({ code: "HOME_UNREADABLE", path: decision.path });
  }
}

function createSourceRef(
  kind: SourceKind,
  normalizedPath: string,
  fileIdentity: SourceRef["fileIdentity"],
): SourceRef {
  return {
    id: codexSourceId(kind, normalizedPath),
    kind,
    normalizedPath,
    formatVersion: CODEX_FORMAT_VERSION,
    fileIdentity,
  };
}

function validateLimits(maxEntries: number, maxDepth: number): void {
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 1_000_000 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > 32
  ) {
    throw new RangeError("Invalid Codex discovery limits");
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
