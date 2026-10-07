import type {
  RankedCandidate,
  SearchIntent,
  SearchMatch,
} from "../contracts/search.js";
import { isExactSearchIntent } from "../contracts/search.js";

export interface FusedCandidate {
  readonly entity: RankedCandidate["entity"];
  readonly scope: RankedCandidate["scope"];
  readonly candidates: readonly RankedCandidate[];
  readonly contributions: readonly number[];
  readonly matches: readonly SearchMatch[];
  readonly fusedScore: number;
}

export interface FuseOptions {
  readonly intent: SearchIntent;
  readonly explicitScope?: boolean;
  readonly k?: number;
  readonly limit?: number;
}

/** Reciprocal-rank fusion with small deterministic exact/structured boosts. */
export function fuseCandidates(
  branches: readonly (readonly RankedCandidate[])[],
  options: FuseOptions,
): readonly FusedCandidate[] {
  const k = options.k ?? 60;
  const limit = options.limit ?? 100;
  if (!Number.isFinite(k) || k <= 0) throw new RangeError("RRF k must be positive");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Fused result limit must be from 1 to 1000");
  }

  const groups = new Map<string, { candidate: RankedCandidate; candidates: RankedCandidate[]; contributions: number[]; score: number }>();
  for (const branch of branches) {
    const seenInBranch = new Set<string>();
    for (const candidate of branch) {
      if (!Number.isSafeInteger(candidate.rank) || candidate.rank < 1) continue;
      const key = entityKey(candidate);
      if (seenInBranch.has(key)) continue;
      seenInBranch.add(key);
      const existing = groups.get(key) ?? { candidate, candidates: [], contributions: [], score: 0 };
      existing.candidates.push(candidate);
      let contribution = 1 / (k + candidate.rank);
      if (candidate.channel === "exact" && isExactSearchIntent(options.intent)) contribution += 0.05;
      if (candidate.channel === "structured" && options.intent !== "general") contribution += 0.01;
      existing.contributions.push(contribution);
      existing.score += contribution;
      groups.set(key, existing);
    }
  }

  return [...groups.values()]
    .map<FusedCandidate>((group) => ({
      entity: group.candidate.entity,
      scope: group.candidate.scope,
      candidates: group.candidates,
      contributions: group.contributions,
      matches: group.candidates.map((candidate) => ({
        channel: candidate.channel,
        rank: candidate.rank,
        ...(candidate.rawScore === undefined ? {} : { rawScore: candidate.rawScore }),
      })),
      fusedScore: group.score + (options.explicitScope === true ? 0.005 : 0),
    }))
    .sort((left, right) => right.fusedScore - left.fusedScore || entityKey(left).localeCompare(entityKey(right)))
    .slice(0, limit);
}

function entityKey(candidate: Pick<RankedCandidate, "entity">): string {
  return `${candidate.entity.kind}\0${candidate.entity.id}`;
}
