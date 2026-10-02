// SQLite stores the authoritative meta data and the compressed store only has the
// stored object types. Therefore the GC removes the objects that are no longer
// addressed by the SQLite rows.

import type { CompressedObjectStore, ObjectId } from "./compressed-store.js";

export interface ObjectGcOptions {
  readonly now?: Date;
  readonly minimumAgeMs?: number;
  readonly maxDeletes?: number;
  readonly dryRun?: boolean;
}

export interface ObjectGcResult {
  readonly examined: number;
  readonly orphaned: readonly ObjectId[];
  readonly deleted: readonly ObjectId[];
  readonly retainedReferenced: number;
  readonly retainedYoung: number;
}

/**
 * Sweeps only objects absent from the authoritative reference set supplied by
 * SQLite. A minimum age protects objects created just before their reference
 * transaction commits, ie to avoid situations when the object is created and 
 * the the row is not yet committed to the SQLite database. 
 */
export async function collectOrphanObjects(
  store: CompressedObjectStore,
  referencedIds: ReadonlySet<ObjectId>,
  options: ObjectGcOptions = {},
): Promise<ObjectGcResult> {
  const now = options.now ?? new Date();
  const minimumAgeMs = options.minimumAgeMs ?? 60 * 60 * 1_000;
  const maxDeletes = options.maxDeletes ?? 1_000;
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid object GC time");
  }
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
    throw new RangeError("Object GC minimum age must be a nonnegative integer");
  }
  if (!Number.isSafeInteger(maxDeletes) || maxDeletes < 0 || maxDeletes > 100_000) {
    throw new RangeError("Object GC delete limit must be from 0 to 100000");
  }

  const entries = await store.list();
  const orphaned: ObjectId[] = [];
  const deleted: ObjectId[] = [];
  let retainedReferenced = 0;
  let retainedYoung = 0;
  for (const entry of entries) {
    if (referencedIds.has(entry.id)) {
      retainedReferenced += 1;
      continue;
    }
    if (now.getTime() - entry.modifiedAtMs < minimumAgeMs) {
      retainedYoung += 1;
      continue;
    }
    orphaned.push(entry.id);
    if (!options.dryRun && deleted.length < maxDeletes && await store.delete(entry.id)) {
      deleted.push(entry.id);
    }
  }
  return {
    examined: entries.length,
    orphaned,
    deleted,
    retainedReferenced,
    retainedYoung,
  };
}

