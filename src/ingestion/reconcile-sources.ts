// This is difference engine that checks the differences between the prev stored 
// source and what we see now. 

import type { SourceId } from "../contracts/ids.js";
import type { FileIdentity, SourceRef } from "../contracts/source.js";

// Type of difference identified for a source. 
export type SourceReconciliationKind =
  | "new"
  | "unchanged"
  | "appended"
  | "metadata_changed"
  | "rotated"
  | "truncated"
  | "moved"
  | "missing";

export interface SourceReconciliation {
  readonly kind: SourceReconciliationKind;
  readonly source: SourceRef;
  readonly previousSourceId?: SourceId;
}

/** Classifies discovery changes without deleting historical source evidence. */
export function reconcileSources(
  persisted: readonly SourceRef[],
  discovered: readonly SourceRef[],
): readonly SourceReconciliation[] {
  const persistedById = new Map(persisted.map((source) => [source.id, source]));
  const discoveredIds = new Set(discovered.map((source) => source.id));
  const unmatchedPersisted = persisted.filter(
    (source) => !discoveredIds.has(source.id),
  );
  const consumedMovedIds = new Set<SourceId>();
  const result: SourceReconciliation[] = [];

  for (const source of discovered) {
    const previous = persistedById.get(source.id);
    if (previous !== undefined) {
      result.push({ kind: compareIdentity(previous, source), source });
      continue;
    }
    const moved = unmatchedPersisted.find(
      (candidate) =>
        !consumedMovedIds.has(candidate.id) &&
        candidate.kind === source.kind &&
        samePhysicalFile(candidate.fileIdentity, source.fileIdentity, false),
    );
    if (moved !== undefined) {
      consumedMovedIds.add(moved.id);
      result.push({ kind: "moved", source, previousSourceId: moved.id });
    } else {
      result.push({ kind: "new", source });
    }
  }

  for (const source of unmatchedPersisted) {
    if (!consumedMovedIds.has(source.id)) {
      result.push({ kind: "missing", source });
    }
  }
  return result;
}

function compareIdentity(
  previous: SourceRef,
  current: SourceRef,
): SourceReconciliationKind {
  if (!samePhysicalFile(previous.fileIdentity, current.fileIdentity, true)) {
    return "rotated";
  }
  if (current.fileIdentity.size < previous.fileIdentity.size) return "truncated";
  if (current.fileIdentity.size > previous.fileIdentity.size) return "appended";
  if (current.fileIdentity.modifiedAtMs !== previous.fileIdentity.modifiedAtMs) {
    return "metadata_changed";
  }
  return "unchanged";
}

function samePhysicalFile(
  left: FileIdentity,
  right: FileIdentity,
  assumeSameWhenUnavailable: boolean,
): boolean {
  if (
    left.device !== undefined &&
    right.device !== undefined &&
    left.inode !== undefined &&
    right.inode !== undefined
  ) {
    return left.device === right.device && left.inode === right.inode;
  }
  return assumeSameWhenUnavailable;
}
