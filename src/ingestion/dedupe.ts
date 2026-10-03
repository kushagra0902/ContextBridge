import type { CanonicalEvent } from "../contracts/evidence.js";

export interface EventDedupeResult {
  readonly events: readonly CanonicalEvent[];
  readonly duplicateEvents: number;
}

/** Deduplicates stable event IDs and rejects a conflicting ID in one scan. */
export function deduplicateEvents(
  events: readonly CanonicalEvent[],
): EventDedupeResult {
  const byId = new Map<string, CanonicalEvent>();
  let duplicateEvents = 0;

  for (const event of events) {
    const existing = byId.get(event.id);
    if (existing === undefined) {
      byId.set(event.id, event);
      continue;
    }
    if (!sameStableEvent(existing, event)) {
      throw new Error("Stable event ID collision inside ingestion batch");
    }
    duplicateEvents += 1;
  }

  return { events: [...byId.values()], duplicateEvents };
}

function sameStableEvent(left: CanonicalEvent, right: CanonicalEvent): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.ordinal === right.ordinal &&
    left.kind === right.kind &&
    left.observedAt === right.observedAt &&
    left.text === right.text &&
    left.contentHash === right.contentHash &&
    left.toolCallId === right.toolCallId &&
    left.EvidenceSource.sourceId === right.EvidenceSource.sourceId &&
    left.EvidenceSource.sourceOrdinal === right.EvidenceSource.sourceOrdinal &&
    left.EvidenceSource.byteStart === right.EvidenceSource.byteStart &&
    left.EvidenceSource.byteEnd === right.EvidenceSource.byteEnd &&
    left.EvidenceSource.formatVersion === right.EvidenceSource.formatVersion &&
    JSON.stringify(left.redactions ?? []) === JSON.stringify(right.redactions ?? [])
  );
}
