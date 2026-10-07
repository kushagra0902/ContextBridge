import type { SearchHit } from "../contracts/search.js";

/** Round-robins sessions/result classes and removes exact evidence duplicates. */
export function diversifyHits(
  hits: readonly SearchHit[],
  limit = hits.length,
): readonly SearchHit[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000) {
    throw new RangeError("Diversified result limit must be from 0 to 1000");
  }
  if (limit === 0) return [];

  const signatures = new Set<string>();
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const evidenceSignature = [...hit.evidenceIds].sort().join("\0");
    if (evidenceSignature.length > 0 && signatures.has(evidenceSignature)) continue;
    if (evidenceSignature.length > 0) signatures.add(evidenceSignature);
    const key = `${hit.scope.sessionId ?? hit.scope.workstreamId ?? hit.scope.projectId}\0${category(hit)}`;
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }

  const queues = [...groups.values()];
  const output: SearchHit[] = [];
  while (output.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const hit = queue.shift();
      if (hit !== undefined) output.push(hit);
      if (output.length === limit) break;
    }
  }
  return output;
}

function category(hit: SearchHit): string {
  if (hit.type === "chunk") return "raw";
  if (hit.type === "decision") return "rationale";
  if (hit.type === "episode") return "outcome";
  return hit.type;
}
