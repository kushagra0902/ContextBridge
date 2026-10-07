import type { SearchHit, SearchIntent } from "../contracts/search.js";

/** Applies intent-aware temporal order without deleting historical records. */
export function orderByChronology(
  hits: readonly SearchHit[],
  intent: SearchIntent,
): readonly SearchHit[] {
  if (intent !== "chronology" && intent !== "latest_state" && intent !== "decision_rationale") {
    return hits.slice();
  }
  return hits.slice().sort((left, right) => {
    if (intent !== "chronology") {
      const currentness = currentnessRank(left) - currentnessRank(right);
      if (currentness !== 0) return currentness;
    }
    const temporal = compareObserved(left.observedAt, right.observedAt);
    if (temporal !== 0) return intent === "chronology" ? temporal : -temporal;
    return right.fusedScore - left.fusedScore || left.entity.id.localeCompare(right.entity.id);
  });
}

function currentnessRank(hit: SearchHit): number {
  switch (hit.currentness) {
    case "current_as_of_commit": return 0;
    case "historical_unverified": return 1;
    case "unknown_currentness": return 2;
    case "superseded": return 3;
  }
}

function compareObserved(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right);
}
