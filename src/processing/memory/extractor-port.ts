import type { EvidenceChunk, EvidenceScope } from "../../contracts/evidence.js";
import type { MemoryEvidenceId, MemoryRecord } from "../../contracts/memory.js";

export type MemoryExtractorKind = "local" | "remote";

export interface MemoryExtractorManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: MemoryExtractorKind;
  readonly schemaVersion: 1;
}

export interface MemoryExtractionLimits {
  readonly maxChunks: number;
  readonly maxInputCharacters: number;
  readonly maxOutputRecords: number;
  readonly maxOutputCharacters: number;
}

export interface MemoryExtractionInput {
  readonly scope: EvidenceScope;
  readonly chunks: readonly EvidenceChunk[];
  readonly allowedEvidenceIds: readonly MemoryEvidenceId[];
  readonly limits: MemoryExtractionLimits;
  readonly derivedAt: string;
}

export interface MemoryExtractor {
  manifest(): MemoryExtractorManifest;
  extract(input: MemoryExtractionInput): Promise<readonly MemoryRecord[]>;
}

export function validateExtractorManifest(
  manifest: MemoryExtractorManifest,
): void {
  if (
    manifest.id.trim().length === 0 ||
    manifest.version.trim().length === 0 ||
    manifest.schemaVersion !== 1 ||
    (manifest.kind !== "local" && manifest.kind !== "remote")
  ) {
    throw new TypeError("Invalid memory extractor manifest");
  }
}

export function validateExtractionLimits(
  limits: MemoryExtractionLimits,
): void {
  bounded(limits.maxChunks, 1, 20_000, "extractor chunk limit");
  bounded(
    limits.maxInputCharacters,
    1_024,
    10_000_000,
    "extractor input character limit",
  );
  bounded(limits.maxOutputRecords, 1, 1_000, "extractor output record limit");
  bounded(
    limits.maxOutputCharacters,
    128,
    100_000,
    "extractor output character limit",
  );
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}`);
  }
}
