import type { ScopeAddress, ScopeExclusionReason } from "../contracts/scope.js";
import { scopeAddress } from "../contracts/scope.js";
import type { ScopeRepository } from "../contracts/ports.js";

export interface ForgetScopeInput {
  readonly scope: ScopeAddress;
  readonly reason?: ScopeExclusionReason;
}

export interface ScopePurgeResult {
  readonly sqlite: boolean;
  readonly objects: boolean;
  readonly vectors: boolean;
  readonly caches: boolean;
  readonly backups: boolean;
}

export interface ForgetScopeDependencies {
  readonly scopes: ScopeRepository;
  readonly purge?: {
    purgeScope(scope: ScopeAddress): Promise<ScopePurgeResult>;
  };
  readonly now?: () => Date;
}

export interface ForgetScopeResult {
  readonly status: "complete" | "pending" | "not_found";
  readonly scope: ScopeAddress;
  readonly cleanup?: ScopePurgeResult;
  readonly retryRequired?: boolean;
}

/** Applies an immediate tombstone before attempting any physical cleanup. */
export async function forgetScope(
  input: ForgetScopeInput,
  dependencies: ForgetScopeDependencies,
): Promise<ForgetScopeResult> {
  const ref = await dependencies.scopes.get(input.scope);
  if (ref === undefined) return { status: "not_found", scope: input.scope };
  const scope = scopeAddress(ref);
  const existing = await dependencies.scopes.getExclusion(scope);
  if (existing?.status === "deleted") {
    return { status: "complete", scope, cleanup: completeCleanup() };
  }
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  await dependencies.scopes.upsertExclusion({
    scope,
    reason: input.reason ?? "forgotten",
    blocksIngestion: true,
    status: "deletion_pending",
    excludedAt: existing?.excludedAt ?? now,
    updatedAt: now,
  });
  if (dependencies.purge === undefined) {
    return { status: "pending", scope, retryRequired: true };
  }
  let cleanup: ScopePurgeResult;
  try {
    cleanup = await dependencies.purge.purgeScope(scope);
  } catch {
    return { status: "pending", scope, retryRequired: true };
  }
  if (!Object.values(cleanup).every(Boolean)) {
    return { status: "pending", scope, cleanup, retryRequired: true };
  }
  const completedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  await dependencies.scopes.upsertExclusion({
    scope,
    reason: input.reason ?? existing?.reason ?? "forgotten",
    blocksIngestion: true,
    status: "deleted",
    excludedAt: existing?.excludedAt ?? now,
    updatedAt: completedAt,
    physicalDeletionCompletedAt: completedAt,
  });
  return { status: "complete", scope, cleanup };
}

function completeCleanup(): ScopePurgeResult {
  return { sqlite: true, objects: true, vectors: true, caches: true, backups: true };
}
