import { isAbsolute, relative, resolve, sep } from "node:path";
import { platform as currentPlatform } from "node:os";

import {
  isStableId,
  projectId as createProjectId,
} from "../../contracts/ids.js";
import type {
  ProjectId,
  SessionId,
} from "../../contracts/ids.js";
import type {
  ExplicitScopeMapping,
  ProjectMappingCandidate,
  ProjectMappingResult,
} from "../../contracts/scope.js";
import type { ParsedSessionMeta } from "../codex/rollout-parser.js";
import {
  inspectRepository,
  type InspectRepositoryOptions,
  type RepositoryInspection,
  type RepositorySnapshot,
} from "./repository.js";
import { normalizeGitRemote } from "./remote.js";

export interface SessionProjectMetadata {
  readonly sessionId: SessionId;
  readonly cwd?: ParsedSessionMeta["cwd"];
  readonly git?: ParsedSessionMeta["git"];
  /** Allows callers that already inspected the repository to avoid a second subprocess. */
  readonly repository?: RepositoryInspection;
}

export interface ResolveProjectOptions {
  readonly inspect?: typeof inspectRepository;
  readonly inspection?: InspectRepositoryOptions;
}

/**
 * Applies manual selectors before inference. Historical session remote metadata
 * outranks current repository state because a checkout may have changed since
 * the session was recorded.
 */
export async function resolveProject(
  session: SessionProjectMetadata,
  overrides: readonly ExplicitScopeMapping[],
  options: ResolveProjectOptions = {},
): Promise<ProjectMappingResult> {
  validateInput(session, overrides);

  const sessionMappings = overrides.filter(
    (mapping) =>
      mapping.selector.kind === "session" &&
      mapping.selector.sessionId === session.sessionId,
  );
  const sessionDecision = explicitDecision(
    session.sessionId,
    sessionMappings,
    "explicit_session",
  );
  if (sessionDecision !== undefined) return sessionDecision;

  const metadataRemote = normalizeOptionalRemote(session.git?.repositoryUrl);
  if (metadataRemote !== undefined) {
    const metadataRemoteMappings = overrides.filter(
      (mapping) =>
        mapping.selector.kind === "git_remote" &&
        mapping.selector.normalizedRemote === metadataRemote,
    );
    const remoteDecision = explicitDecision(
      session.sessionId,
      metadataRemoteMappings,
      "explicit_git_remote",
    );
    if (remoteDecision !== undefined) return remoteDecision;
  }

  const repository =
    session.repository ??
    (session.cwd === undefined
      ? undefined
      : await (options.inspect ?? inspectRepository)(
          session.cwd,
          options.inspection,
        ));

  const repositoryRemotes =
    repository?.status === "ok"
      ? distinct(repository.repository.remotes.map((entry) => entry.remote.canonical))
      : [];
  const remoteMappings = overrides.filter(
    (mapping) =>
      mapping.selector.kind === "git_remote" &&
      repositoryRemotes.includes(mapping.selector.normalizedRemote),
  );
  const repositoryRemoteDecision = explicitDecision(
    session.sessionId,
    remoteMappings,
    "explicit_git_remote",
  );
  if (repositoryRemoteDecision !== undefined) return repositoryRemoteDecision;

  if (repository?.status === "ok") {
    const rootMappings = overrides.filter(
      (mapping) =>
        mapping.selector.kind === "repository_root" &&
        sameLocalPath(mapping.selector.normalizedPath, repository.repository.root),
    );
    const rootDecision = explicitDecision(
      session.sessionId,
      rootMappings,
      "explicit_repository_root",
    );
    if (rootDecision !== undefined) return rootDecision;
  }

  if (session.cwd !== undefined) {
    const cwdMappings = longestCwdMappings(session.cwd, overrides);
    const cwdDecision = explicitDecision(
      session.sessionId,
      cwdMappings,
      "explicit_cwd_prefix",
    );
    if (cwdDecision !== undefined) return cwdDecision;
  }

  if (metadataRemote !== undefined) {
    return mapped(
      session.sessionId,
      projectIdFromRemote(metadataRemote),
      "git_remote",
      "high",
      "session_git_remote",
    );
  }

  if (repository?.status === "ok") {
    const identities = preferredRepositoryRemotes(repository.repository);
    if (identities.length === 1 && identities[0] !== undefined) {
      return mapped(
        session.sessionId,
        projectIdFromRemote(identities[0]),
        "git_remote",
        "high",
        "repository_git_remote",
      );
    }
    if (identities.length > 1) {
      const candidates = identities.map<ProjectMappingCandidate>((identity) => ({
        target: { projectId: projectIdFromRemote(identity) },
        method: "git_remote",
        confidence: "medium",
        reason: "multiple_repository_remotes",
      }));
      return {
        status: "ambiguous",
        sessionId: session.sessionId,
        candidates: asAmbiguousTuple(candidates),
      };
    }

    return mapped(
      session.sessionId,
      projectIdFromRepositoryRoot(repository.repository.root),
      "repository_root",
      "high",
      "repository_root",
    );
  }

  return {
    status: "unmapped",
    sessionId: session.sessionId,
    reason: unmappedReason(session.cwd, repository),
  };
}

export function projectIdFromRemote(normalizedRemote: string): ProjectId {
  if (
    normalizedRemote.length === 0 ||
    normalizedRemote.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(normalizedRemote)
  ) {
    throw new TypeError("Invalid normalized Git remote");
  }
  return createProjectId(["git-remote", normalizedRemote]);
}

export function projectIdFromRepositoryRoot(root: string): ProjectId {
  return createProjectId(["repository-root", normalizeLocalPath(root)]);
}

function explicitDecision(
  sessionId: SessionId,
  mappings: readonly ExplicitScopeMapping[],
  reason: string,
): ProjectMappingResult | undefined {
  if (mappings.length === 0) return undefined;
  const candidates = uniqueExplicitCandidates(mappings, reason);
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return {
      status: "mapped",
      sessionId,
      mapping: candidates[0],
    };
  }
  return {
    status: "ambiguous",
    sessionId,
    candidates: asAmbiguousTuple(candidates),
  };
}

function uniqueExplicitCandidates(
  mappings: readonly ExplicitScopeMapping[],
  reason: string,
): ProjectMappingCandidate[] {
  const candidates = new Map<string, ProjectMappingCandidate>();
  for (const mapping of mappings) {
    const key = `${mapping.target.projectId}:${mapping.target.workstreamId ?? ""}`;
    candidates.set(key, {
      target: mapping.target,
      method: "explicit",
      confidence: "exact",
      reason,
    });
  }
  return [...candidates.values()].sort((left, right) =>
    `${left.target.projectId}:${left.target.workstreamId ?? ""}`.localeCompare(
      `${right.target.projectId}:${right.target.workstreamId ?? ""}`,
    ),
  );
}

function longestCwdMappings(
  cwd: string,
  overrides: readonly ExplicitScopeMapping[],
): readonly ExplicitScopeMapping[] {
  const matching = overrides.filter(
    (mapping) =>
      mapping.selector.kind === "cwd_prefix" &&
      pathContains(mapping.selector.normalizedPath, cwd),
  );
  const longest = matching.reduce(
    (length, mapping) =>
      mapping.selector.kind === "cwd_prefix"
        ? Math.max(length, normalizeLocalPath(mapping.selector.normalizedPath).length)
        : length,
    0,
  );
  return matching.filter(
    (mapping) =>
      mapping.selector.kind === "cwd_prefix" &&
      normalizeLocalPath(mapping.selector.normalizedPath).length === longest,
  );
}

function preferredRepositoryRemotes(
  repository: RepositorySnapshot,
): readonly string[] {
  const origin = distinct(
    repository.remotes
      .filter((entry) => entry.name === "origin")
      .map((entry) => entry.remote.canonical),
  );
  if (origin.length > 0) return origin;
  const upstream = distinct(
    repository.remotes
      .filter((entry) => entry.name === "upstream")
      .map((entry) => entry.remote.canonical),
  );
  if (upstream.length > 0) return upstream;
  return distinct(repository.remotes.map((entry) => entry.remote.canonical));
}

function mapped(
  sessionId: SessionId,
  projectId: ProjectId,
  method: ProjectMappingCandidate["method"],
  confidence: ProjectMappingCandidate["confidence"],
  reason: string,
): ProjectMappingResult {
  return {
    status: "mapped",
    sessionId,
    mapping: {
      target: { projectId },
      method,
      confidence,
      reason,
    },
  };
}

function normalizeOptionalRemote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeGitRemote(value);
  return normalized.ok ? normalized.remote.canonical : undefined;
}

function unmappedReason(
  cwd: string | undefined,
  repository: RepositoryInspection | undefined,
): string {
  if (cwd === undefined) return "no_repository_identity";
  switch (repository?.status) {
    case "not_found":
      return "cwd_not_found";
    case "not_directory":
      return "cwd_not_directory";
    case "not_repository":
      return "not_git_repository";
    case "timeout":
      return "repository_inspection_timeout";
    case "git_unavailable":
      return "git_unavailable";
    case "unreadable":
    case undefined:
      return "repository_unreadable";
    case "ok":
      return "no_repository_identity";
  }
}

function pathContains(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeLocalPath(root);
  const normalizedCandidate = normalizeLocalPath(candidate);
  const child = relative(normalizedRoot, normalizedCandidate);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

function sameLocalPath(left: string, right: string): boolean {
  return normalizeLocalPath(left) === normalizeLocalPath(right);
}

function normalizeLocalPath(value: string): string {
  const normalized = resolve(value);
  return currentPlatform() === "win32" ? normalized.toLowerCase() : normalized;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function asAmbiguousTuple(
  candidates: readonly ProjectMappingCandidate[],
): readonly [
  ProjectMappingCandidate,
  ProjectMappingCandidate,
  ...ProjectMappingCandidate[],
] {
  if (
    candidates.length < 2 ||
    candidates[0] === undefined ||
    candidates[1] === undefined
  ) {
    throw new Error("Ambiguous mapping requires at least two candidates");
  }
  return [candidates[0], candidates[1], ...candidates.slice(2)];
}

function validateInput(
  session: SessionProjectMetadata,
  overrides: readonly ExplicitScopeMapping[],
): void {
  if (!isStableId(session.sessionId, "session") || overrides.length > 10_000) {
    throw new TypeError("Invalid project mapping input");
  }
  if (
    session.cwd !== undefined &&
    (session.cwd.length === 0 ||
      session.cwd.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(session.cwd))
  ) {
    throw new TypeError("Invalid session working directory");
  }
  for (const mapping of overrides) {
    if (
      !isStableId(mapping.target.projectId, "project") ||
      (mapping.target.workstreamId !== undefined &&
        !isStableId(mapping.target.workstreamId, "workstream"))
    ) {
      throw new TypeError("Invalid explicit project mapping");
    }
    if (
      mapping.selector.kind === "session" &&
      !isStableId(mapping.selector.sessionId, "session")
    ) {
      throw new TypeError("Invalid explicit session selector");
    }
    if (
      mapping.selector.kind === "git_remote" &&
      (mapping.selector.normalizedRemote.length === 0 ||
        mapping.selector.normalizedRemote.length > 4_096 ||
        /[\u0000-\u001f\u007f]/u.test(mapping.selector.normalizedRemote))
    ) {
      throw new TypeError("Invalid explicit remote selector");
    }
    if (
      (mapping.selector.kind === "repository_root" ||
        mapping.selector.kind === "cwd_prefix") &&
      (!isAbsolute(mapping.selector.normalizedPath) ||
        mapping.selector.normalizedPath.length > 4_096 ||
        /[\u0000-\u001f\u007f]/u.test(mapping.selector.normalizedPath))
    ) {
      throw new TypeError("Invalid explicit path selector");
    }
  }
}
