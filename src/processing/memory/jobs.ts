import type { EvidenceChunk } from "../../contracts/evidence.js";
import type { MemoryId, SessionId } from "../../contracts/ids.js";
import type {
  MemoryEvidenceId,
  MemoryRecord,
  MemoryType,
} from "../../contracts/memory.js";
import type { Storage } from "../../contracts/ports.js";
import {
  extractDecisionCandidates,
  extractOpenItemCandidates,
  HEURISTIC_DECISION_VERSION,
  HEURISTIC_OPEN_ITEM_VERSION,
} from "./decision-candidates.js";
import type {
  MemoryExtractionLimits,
  MemoryExtractor,
  MemoryExtractorManifest,
} from "./extractor-port.js";
import {
  validateExtractionLimits,
  validateExtractorManifest,
} from "./extractor-port.js";
import {
  buildExtractiveSynopsis,
  EXTRACTIVE_SYNOPSIS_VERSION,
} from "./synopsis.js";
import { validateMemoryEvidence } from "./validate-evidence.js";

const MANAGED_TYPES: readonly MemoryType[] = [
  "session_synopsis",
  "decision",
  "episode",
  "semantic_fact",
  "open_item",
];
const BUILTIN_VERSIONS = new Set([
  EXTRACTIVE_SYNOPSIS_VERSION,
  HEURISTIC_DECISION_VERSION,
  HEURISTIC_OPEN_ITEM_VERSION,
]);
const DEFAULT_EXTRACTION_LIMITS: MemoryExtractionLimits = {
  maxChunks: 2_000,
  maxInputCharacters: 1_000_000,
  maxOutputRecords: 100,
  maxOutputCharacters: 20_000,
};

export interface MemorySyncOptions {
  readonly now?: () => Date;
  readonly extractor?: MemoryExtractor;
  readonly extractionLimits?: MemoryExtractionLimits;
  readonly maxChunks?: number;
  readonly maxCandidates?: number;
}

export type MemorySyncDiagnosticCode =
  | "OPTIONAL_EXTRACTOR_FAILED"
  | "OPTIONAL_EXTRACTOR_INVALID_OUTPUT"
  | "OPTIONAL_EXTRACTOR_LIMIT_EXCEEDED";

export interface MemorySyncDiagnostic {
  readonly code: MemorySyncDiagnosticCode;
  readonly extractorId?: string;
}

export interface MemorySyncResult {
  readonly sessionId: SessionId;
  readonly chunkCount: number;
  readonly memoryCount: number;
  readonly unchangedMemories: number;
  readonly upsertedMemories: number;
  readonly deletedMemories: number;
  readonly diagnostics: readonly MemorySyncDiagnostic[];
  readonly memories: readonly MemoryRecord[];
}

/**
 * Reconciles built-in and optional derived memories for one selected session.
 * Optional extraction fails open to the lexical chunk index and never deletes
 * the last successful provider output after a transient provider failure.
 */
export async function syncSessionMemories(
  storage: Storage,
  sessionId: SessionId,
  options: MemorySyncOptions = {},
): Promise<MemorySyncResult> {
  const session = await storage.scopes.getSession(sessionId);
  if (session === undefined) throw new Error("Cannot extract memory for an unmapped session");
  const scope = {
    projectId: session.projectId,
    ...(session.workstreamId === undefined
      ? {}
      : { workstreamId: session.workstreamId }),
    sessionId,
  };
  const availability = await storage.scopes.getAvailability(scope);
  if (availability !== "selected") {
    throw new Error(`Cannot extract memory for a session with availability ${availability}`);
  }

  const maximumChunks = bounded(options.maxChunks ?? 20_000, 1, 99_999, "memory chunk limit");
  const chunks = await storage.evidence.listSessionChunks(sessionId, maximumChunks + 1);
  if (chunks.length > maximumChunks) {
    throw new RangeError(`Session exceeds the ${maximumChunks} memory chunk limit`);
  }
  const existing = await storage.memories.findByScope(scope, MANAGED_TYPES);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const maximumCandidates = bounded(
    options.maxCandidates ?? 200,
    1,
    1_000,
    "memory candidate limit",
  );
  const desired: MemoryRecord[] = [];
  const synopsis = buildExtractiveSynopsis(chunks, { derivedAt: now });
  if (synopsis !== undefined) desired.push(synopsis);
  desired.push(
    ...extractDecisionCandidates(chunks, {
      derivedAt: now,
      maxCandidates: maximumCandidates,
    }),
    ...extractOpenItemCandidates(chunks, {
      derivedAt: now,
      maxCandidates: maximumCandidates,
    }),
  );

  const diagnostics: MemorySyncDiagnostic[] = [];
  let successfulExtractor: MemoryExtractorManifest | undefined;
  if (options.extractor !== undefined) {
    const extracted = await runOptionalExtractor(
      options.extractor,
      chunks,
      scope,
      now,
      options.extractionLimits ?? DEFAULT_EXTRACTION_LIMITS,
    );
    diagnostics.push(...extracted.diagnostics);
    if (extracted.manifest !== undefined) {
      successfulExtractor = extracted.manifest;
      desired.push(...extracted.memories);
    }
  }

  const desiredById = new Map<MemoryId, MemoryRecord>();
  for (const memory of desired) {
    const previous = desiredById.get(memory.id);
    if (previous !== undefined && canonicalJson(previous) !== canonicalJson(memory)) {
      diagnostics.push({
        code: "OPTIONAL_EXTRACTOR_INVALID_OUTPUT",
        ...(successfulExtractor === undefined
          ? {}
          : { extractorId: successfulExtractor.id }),
      });
      continue;
    }
    desiredById.set(memory.id, memory);
  }
  const desiredRecords = [...desiredById.values()];
  const knownMemoryIds = new Set(desiredRecords.map((memory) => memory.id));
  const availableEvidenceIds = availableEvidence(chunks);
  for (const memory of desiredRecords) {
    validateMemoryEvidence(memory, {
      scope,
      availableEvidenceIds,
      knownMemoryIds,
    });
  }

  const existingById = new Map(existing.map((memory) => [memory.id, memory]));
  const stabilized = desiredRecords.map((memory) =>
    stabilizeTimestamps(memory, existingById.get(memory.id), now),
  );
  const changed = stabilized.filter((memory) => {
    const previous = existingById.get(memory.id);
    return previous === undefined || canonicalJson(previous) !== canonicalJson(memory);
  });
  const ownedVersions = new Set(BUILTIN_VERSIONS);
  if (successfulExtractor !== undefined) ownedVersions.add(successfulExtractor.version);
  const desiredIds = new Set(stabilized.map((memory) => memory.id));
  const deleted = existing
    .filter(
      (memory) =>
        ownedVersions.has(memory.extractorVersion) && !desiredIds.has(memory.id),
    )
    .map((memory) => memory.id);

  if (changed.length > 0 || deleted.length > 0) {
    await storage.derivedData.commit({
      upsertChunks: [],
      deleteChunkIds: [],
      upsertMemories: changed,
      deleteMemoryIds: deleted,
      embeddingJobs: [],
    });
  }
  return {
    sessionId,
    chunkCount: chunks.length,
    memoryCount: stabilized.length,
    unchangedMemories: stabilized.length - changed.length,
    upsertedMemories: changed.length,
    deletedMemories: deleted.length,
    diagnostics,
    memories: stabilized,
  };
}

async function runOptionalExtractor(
  extractor: MemoryExtractor,
  chunks: readonly EvidenceChunk[],
  scope: EvidenceChunk["scope"],
  derivedAt: string,
  limits: MemoryExtractionLimits,
): Promise<{
  readonly memories: readonly MemoryRecord[];
  readonly diagnostics: readonly MemorySyncDiagnostic[];
  readonly manifest?: MemoryExtractorManifest;
}> {
  let manifest: MemoryExtractorManifest;
  try {
    manifest = extractor.manifest();
    validateExtractorManifest(manifest);
    validateExtractionLimits(limits);
  } catch {
    return { memories: [], diagnostics: [{ code: "OPTIONAL_EXTRACTOR_INVALID_OUTPUT" }] };
  }
  try {
    const selected = selectChunksWithinBudget(chunks, limits);
    let records: readonly MemoryRecord[];
    try {
      records = await extractor.extract({
        scope,
        chunks: selected,
        allowedEvidenceIds: [...availableEvidence(selected)],
        limits,
        derivedAt,
      });
    } catch {
      return {
        memories: [],
        diagnostics: [{ code: "OPTIONAL_EXTRACTOR_FAILED", extractorId: manifest.id }],
      };
    }
    if (
      records.length > limits.maxOutputRecords ||
      records.reduce((total, memory) => total + memory.title.length + memory.body.length, 0) >
        limits.maxOutputCharacters
    ) {
      return {
        memories: [],
        diagnostics: [{ code: "OPTIONAL_EXTRACTOR_LIMIT_EXCEEDED", extractorId: manifest.id }],
      };
    }
    try {
      if (records.some((memory) => memory.extractorVersion !== manifest.version)) {
        throw new Error("Extractor version mismatch");
      }
      const knownMemoryIds = new Set(records.map((memory) => memory.id));
      const evidence = availableEvidence(selected);
      for (const memory of records) {
        validateMemoryEvidence(memory, {
          scope,
          availableEvidenceIds: evidence,
          knownMemoryIds,
        });
      }
    } catch {
      return {
        memories: [],
        diagnostics: [{ code: "OPTIONAL_EXTRACTOR_INVALID_OUTPUT", extractorId: manifest.id }],
      };
    }
    return { memories: records, diagnostics: [], manifest };
  } catch {
    return { memories: [], diagnostics: [{ code: "OPTIONAL_EXTRACTOR_INVALID_OUTPUT", extractorId: manifest.id }] };
  }
}

function selectChunksWithinBudget(
  chunks: readonly EvidenceChunk[],
  limits: MemoryExtractionLimits,
): readonly EvidenceChunk[] {
  const selected: EvidenceChunk[] = [];
  let characters = 0;
  for (const chunk of chunks) {
    if (selected.length === limits.maxChunks) break;
    const size = chunk.displayText.length + chunk.embeddingText.length;
    if (characters + size > limits.maxInputCharacters) break;
    selected.push(chunk);
    characters += size;
  }
  return selected;
}

function availableEvidence(
  chunks: readonly EvidenceChunk[],
): ReadonlySet<MemoryEvidenceId> {
  return new Set<MemoryEvidenceId>(
    chunks.flatMap((chunk) => [chunk.id, ...chunk.eventIds]),
  );
}

function stabilizeTimestamps(
  desired: MemoryRecord,
  existing: MemoryRecord | undefined,
  now: string,
): MemoryRecord {
  if (existing === undefined) return desired;
  const desiredContent = { ...desired, derivedAt: "", updatedAt: "" };
  const existingContent = { ...existing, derivedAt: "", updatedAt: "" };
  if (canonicalJson(desiredContent) === canonicalJson(existingContent)) return existing;
  return {
    ...desired,
    derivedAt: existing.derivedAt,
    updatedAt: now,
  } as MemoryRecord;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}`);
  }
  return value;
}
