// This file creates stable ids as defined in the contracts/ids using the
// file properties, paths etc as required for the stable ids. 

import { createHash } from "node:crypto";
import { basename, normalize, resolve } from "node:path";

import type { CanonicalEventKind } from "../../contracts/evidence.js";
import {
  eventId as createEventId,
  sessionId as createSessionId,
  sourceId as createSourceId,
} from "../../contracts/ids.js";

import type {
  EventId,
  SessionId,
  SourceId,
} from "../../contracts/ids.js";

import type {
  FileIdentity,
  SourceKind,
  SourceRef,
} from "../../contracts/source.js";

export const CODEX_FORMAT_VERSION = "codex-jsonl-v1";

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

export function normalizeCodexPath(path: string): string {
  return normalize(resolve(path));
}

export function codexSourceId(kind: SourceKind, path: string): SourceId {
  return createSourceId(["codex", kind, normalizeCodexPath(path)]);
}

/**
 * Prefer Codex's session key. Rollout filenames are the restart-safe fallback;
 * the first UUID is the owning session for both root and child-agent files.
 */
export function sourceSessionId(
  source: Pick<SourceRef, "id" | "kind" | "normalizedPath">,
  explicitSessionKey?: string,
): SessionId {
  const explicit = normalizeIdentityComponent(explicitSessionKey);
  if (explicit !== undefined) {
    return createSessionId(["codex", explicit]);
  }

  if (source.kind === "codex_rollout") {
    const filenameId = basename(source.normalizedPath).match(UUID_PATTERN)?.[0];
    if (filenameId !== undefined) {
      return createSessionId(["codex", filenameId.toLowerCase()]);
    }
  }

  return createSessionId(["codex-source", source.id]);
}

export function codexEventId(
  sessionId: SessionId,
  kind: CanonicalEventKind,
  stableRecordKey: string,
): EventId {
  return createEventId([sessionId, kind, stableRecordKey]);
}

/** Stable across append; a path replacement changes device/inode where exposed. */
export function sourceFingerprint(
  path: string,
  identity: FileIdentity,
): string {
  return hashParts([
    "codex-source-v1",
    normalizeCodexPath(path),
    identity.device ?? "unknown-device",
    identity.inode ?? "unknown-inode",
  ]);
}

export function contentFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function fileIdentityFromStats(stats: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly mtimeMs: number;
}): FileIdentity {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    size: toSafeNumber(stats.size, "file size"),
    modifiedAtMs: stats.mtimeMs,
  };
}

function normalizeIdentityComponent(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return undefined;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    normalized,
  )
    ? normalized.toLowerCase()
    : normalized;
}

function hashParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function toSafeNumber(value: number | bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`Invalid ${label}`);
  }
  return number;
}
