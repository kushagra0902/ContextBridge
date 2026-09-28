// Provides the interfaces to actually define the scope of the memory and evidences and 
// the scope of search, scope for auth, retrieval etc. 

import type {
  ProjectId,
  SessionId,
  WorkstreamId,
} from "./ids.js";

// The IDs needed to constrain every storage and retrieval operation. 
export interface ScopeAddress {
  readonly projectId: ProjectId;
  readonly workstreamId?: WorkstreamId;
  readonly sessionId?: SessionId;
}

export type ScopeKind = "project" | "workstream" | "session";

// Safe project metadata. Physical checkout paths remain storage-internal. Direct project's 
// location not revelaed, just its reference is given. 
export interface ProjectRef {
  readonly kind: "project";
  readonly id: ProjectId;
  readonly displayName: string;
  readonly lastActivityAt?: string;
}

/** Branch and issue values are hints; they do not prove workstream identity. */
export interface WorkstreamRef {
  readonly kind: "workstream";
  readonly id: WorkstreamId;
  readonly projectId: ProjectId;
  readonly displayName: string;
  readonly branch?: string;
  readonly issueId?: string;
  readonly lastActivityAt?: string;
}

export interface SessionRef {
  readonly kind: "session";
  readonly id: SessionId;
  readonly projectId: ProjectId;
  readonly workstreamId?: WorkstreamId;
  readonly title?: string;
  readonly branch?: string;
  readonly headCommit?: string;
  readonly startedAt?: string;
  readonly lastActivityAt?: string;
}

export type ScopeRef = ProjectRef | WorkstreamRef | SessionRef;

export type ScopeAliasSource =
  | "user"
  | "project_name"
  | "workstream_name"
  | "session_title"
  | "git_remote"
  | "directory_name"
  | "branch"
  | "issue";

export interface ScopeAlias {
  readonly value: string;
  readonly normalizedValue: string;
  readonly target: ScopeAddress;
  readonly source: ScopeAliasSource;
  readonly createdAt: string;
}

/** Selectors are local configuration data and must not be returned publicly. */
export type ExplicitMappingSelector =
  | { readonly kind: "session"; readonly sessionId: SessionId }
  | { readonly kind: "git_remote"; readonly normalizedRemote: string }
  | { readonly kind: "repository_root"; readonly normalizedPath: string }
  | { readonly kind: "cwd_prefix"; readonly normalizedPath: string };

export interface ProjectScopeTarget {
  readonly projectId: ProjectId;
  readonly workstreamId?: WorkstreamId;
}

export interface ExplicitScopeMapping {
  readonly selector: ExplicitMappingSelector;
  readonly target: ProjectScopeTarget;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProjectMappingMethod =
  | "explicit"
  | "git_remote"
  | "repository_root"
  | "cwd";

export type MappingConfidence = "exact" | "high" | "medium" | "low";

export interface ProjectMappingCandidate {
  readonly target: ProjectScopeTarget;
  readonly method: ProjectMappingMethod;
  readonly confidence: MappingConfidence;
  readonly reason: string;
}

export type ProjectMappingResult =
  | {
      readonly status: "mapped";
      readonly sessionId: SessionId;
      readonly mapping: ProjectMappingCandidate;
    }
  | {
      readonly status: "ambiguous";
      readonly sessionId: SessionId;
      readonly candidates: readonly [
        ProjectMappingCandidate,
        ProjectMappingCandidate,
        ...ProjectMappingCandidate[],
      ];
    }
  | {
      readonly status: "unmapped";
      readonly sessionId: SessionId;
      readonly reason: string;
    };

export type ScopeAvailability =
  | "selected"
  | "not_selected"
  | "excluded"
  | "deletion_pending"
  | "deleted";

export type ScopeExclusionReason =
  | "user_excluded"
  | "ignore_rule"
  | "privacy"
  | "forgotten"
  | "source_policy";

/**
 * SQLite owns this record. A blocking tombstone prevents an existing source
 * from silently recreating a forgotten scope during a later scan.
 */
interface ScopeExclusionBase {
  readonly scope: ScopeAddress;
  readonly reason: ScopeExclusionReason;
  readonly blocksIngestion: true;
  readonly excludedAt: string;
  readonly updatedAt: string;
}

export type ScopeExclusion = ScopeExclusionBase &
  (
    | {
        readonly status: "excluded" | "deletion_pending";
        readonly physicalDeletionCompletedAt?: never;
      }
    | {
        readonly status: "deleted";
        readonly physicalDeletionCompletedAt: string;
      }
  );

export type ScopeMatchKind =
  | "explicit_id"
  | "explicit_mapping"
  | "alias"
  | "project_identity"
  | "metadata"
  | "name";

export interface ScopeCandidate {
  readonly scope: ScopeRef;
  readonly matchedBy: ScopeMatchKind;
  readonly score: number;
  readonly aliases: readonly string[];
  readonly availability: ScopeAvailability;
}

export interface ResolvedScopeResult {
  readonly status: "resolved";
  readonly scope: ScopeRef;
  readonly matchedBy: ScopeMatchKind;
}

export interface AmbiguousScopeResult {
  readonly status: "ambiguous";
  readonly candidates: readonly [
    ScopeCandidate,
    ScopeCandidate,
    ...ScopeCandidate[],
  ];
}

export interface ScopeNotFoundResult {
  readonly status: "not_found";
  readonly reason: string;
}

export interface ExcludedScopeResult {
  readonly status: "excluded";
  readonly scope: ScopeRef;
  readonly exclusion: ScopeExclusion;
}

export type ScopeResolution =
  | ResolvedScopeResult
  | AmbiguousScopeResult
  | ScopeNotFoundResult
  | ExcludedScopeResult;

export function scopeAddress(scope: ScopeRef): ScopeAddress {
  switch (scope.kind) {
    case "project":
      return { projectId: scope.id };
    case "workstream":
      return { projectId: scope.projectId, workstreamId: scope.id };
    case "session":
      return {
        projectId: scope.projectId,
        ...(scope.workstreamId === undefined
          ? {}
          : { workstreamId: scope.workstreamId }),
        sessionId: scope.id,
      };
  }
}

/** Returns true when the candidate is inside the requested boundary. */
export function scopeContains(
  boundary: ScopeAddress,
  candidate: ScopeAddress,
): boolean {
  if (boundary.projectId !== candidate.projectId) {
    return false;
  }

  if (
    boundary.workstreamId !== undefined &&
    boundary.workstreamId !== candidate.workstreamId
  ) {
    return false;
  }

  return (
    boundary.sessionId === undefined ||
    boundary.sessionId === candidate.sessionId
  );
}

export function sameScope(left: ScopeAddress, right: ScopeAddress): boolean {
  return (
    left.projectId === right.projectId &&
    left.workstreamId === right.workstreamId &&
    left.sessionId === right.sessionId
  );
}

/** Normalizes user-facing aliases without exposing path-specific matching. */
export function normalizeScopeAlias(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Invalid scope alias");
  }

  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

  if (normalized.length === 0 || normalized.length > 256) {
    throw new TypeError("Invalid scope alias");
  }

  return normalized;
}

export function isResolvedScope(
  resolution: ScopeResolution,
): resolution is ResolvedScopeResult {
  return resolution.status === "resolved";
}
