import type { EvidenceScope } from "../../contracts/evidence.js";
import { isStableId, type MemoryId } from "../../contracts/ids.js";
import {
  collectMemoryEvidenceIds,
  type MemoryEvidenceId,
  type MemoryRecord,
  type MemoryStatus,
} from "../../contracts/memory.js";

const MEMORY_STATUSES: ReadonlySet<string> = new Set<MemoryStatus>([
  "candidate",
  "tentative",
  "active",
  "conflicted",
  "superseded",
  "resolved",
  "dismissed",
]);

export interface MemoryEvidenceContext {
  readonly scope: EvidenceScope;
  readonly availableEvidenceIds: ReadonlySet<MemoryEvidenceId>;
  readonly knownMemoryIds?: ReadonlySet<MemoryId>;
}

/** Rejects unsupported citations and scope escalation before persistence. */
export function validateMemoryEvidence(
  memory: MemoryRecord,
  context: MemoryEvidenceContext,
): void {
  if (!isStableId(memory.id, "memory")) {
    throw new TypeError("Derived memory has an invalid memory ID");
  }
  if (!MEMORY_STATUSES.has(memory.status)) {
    throw new TypeError("Derived memory has an invalid status");
  }
  if (
    memory.scope.sessionId !== context.scope.sessionId ||
    memory.scope.projectId !== context.scope.projectId ||
    memory.scope.workstreamId !== context.scope.workstreamId
  ) {
    throw new Error("Derived memory scope does not match its evidence session");
  }
  if (memory.title.trim().length === 0 || memory.body.trim().length === 0) {
    throw new Error("Derived memory title and body must not be empty");
  }
  if (memory.title.length > 1_000 || memory.body.length > 100_000) {
    throw new RangeError("Derived memory text exceeds storage limits");
  }
  assertDate(memory.derivedAt, "memory derivation time");
  assertDate(memory.updatedAt, "memory update time");
  if (memory.observedFrom !== undefined) {
    assertDate(memory.observedFrom, "memory observed-from time");
  }
  if (memory.observedTo !== undefined) {
    assertDate(memory.observedTo, "memory observed-to time");
  }

  const evidenceIds = collectMemoryEvidenceIds(memory);
  if (evidenceIds.length === 0) {
    throw new Error("Derived memory must cite at least one evidence item");
  }
  for (const evidenceId of evidenceIds) {
    if (
      !isStableId(evidenceId, "event") &&
      !isStableId(evidenceId, "chunk")
    ) {
      throw new TypeError("Derived memory cites an invalid evidence ID");
    }
    if (!context.availableEvidenceIds.has(evidenceId)) {
      throw new Error("Derived memory cites unavailable or foreign evidence");
    }
  }

  if (
    memory.type === "decision" &&
    memory.derivation !== "extractive" &&
    memory.status === "active"
  ) {
    throw new Error("Heuristic or model decisions must remain non-authoritative");
  }
  for (const superseded of memory.supersedes ?? []) {
    validateRelatedMemory(memory.id, superseded, context.knownMemoryIds);
  }
  if (memory.supersededBy !== undefined) {
    validateRelatedMemory(memory.id, memory.supersededBy, context.knownMemoryIds);
  }
}

function validateRelatedMemory(
  owner: MemoryId,
  related: MemoryId,
  known: ReadonlySet<MemoryId> | undefined,
): void {
  if (!isStableId(related, "memory") || related === owner) {
    throw new Error("Derived memory contains an invalid supersession link");
  }
  if (known !== undefined && !known.has(related)) {
    throw new Error("Derived memory supersession target is unknown");
  }
}

function assertDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Invalid ${label}`);
  }
}
