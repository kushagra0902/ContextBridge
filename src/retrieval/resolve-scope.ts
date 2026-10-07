import type { ScopeRepository } from "../contracts/ports.js";
import type {
  ScopeAddress,
  ScopeCandidate,
  ScopeResolution,
} from "../contracts/scope.js";
import { normalizeScopeAlias, scopeAddress } from "../contracts/scope.js";

const DEFAULT_LIMIT = 12;
const AMBIGUITY_DELTA = 0.05;

export interface ResolveScopeInput {
  readonly query?: string;
  readonly explicitScope?: ScopeAddress;
  readonly limit?: number;
}

/** Resolves one selected boundary, or returns ambiguity instead of blending scopes. */
export async function resolveScope(
  input: ResolveScopeInput,
  scopes: ScopeRepository,
): Promise<ScopeResolution> {
  const limit = boundedLimit(input.limit ?? DEFAULT_LIMIT);
  if (input.explicitScope !== undefined) {
    const scope = await scopes.get(input.explicitScope);
    if (scope === undefined) {
      return { status: "not_found", reason: "The requested scope does not exist" };
    }
    const unavailable = await unavailableResolution(scopes, scopeAddress(scope), scope);
    return unavailable ?? { status: "resolved", scope, matchedBy: "explicit_id" };
  }

  const query = input.query?.normalize("NFKC").trim();
  if (query !== undefined && query.length > 256) {
    throw new RangeError("Scope query is too long");
  }

  // Exact aliases are checked first so a stable user alias beats fuzzy names.
  if (query !== undefined && query.length > 0) {
    const aliases = await scopes.findAliases(normalizeScopeAlias(query), limit);
    const aliasCandidates: ScopeCandidate[] = [];
    for (const alias of aliases) {
      const scope = await scopes.get(alias.target);
      if (scope === undefined) continue;
      aliasCandidates.push({
        scope,
        matchedBy: "alias",
        score: 1,
        aliases: [alias.value],
        availability: await scopes.getAvailability(alias.target),
      });
    }
    const aliasResolution = await resolveCandidates(aliasCandidates, scopes);
    if (aliasResolution !== undefined) return aliasResolution;
  }

  const listed = await scopes.listCandidates(query, limit);
  // With no selector, resolve only among project roots. Descendants otherwise
  // tie their parent and make a single-project installation look ambiguous.
  const candidates = query === undefined || query.length === 0
    ? listed.filter((candidate) => candidate.scope.kind === "project")
    : listed;
  return (await resolveCandidates(candidates, scopes)) ?? {
    status: "not_found",
    reason: "No matching selected scope was found",
  };
}

async function resolveCandidates(
  candidates: readonly ScopeCandidate[],
  scopes: ScopeRepository,
): Promise<ScopeResolution | undefined> {
  if (candidates.length === 0) return undefined;
  const selected = candidates.filter((candidate) => candidate.availability === "selected");
  if (selected.length === 0) {
    const first = candidates[0];
    if (first === undefined) return undefined;
    return (await unavailableResolution(scopes, scopeAddress(first.scope), first.scope)) ?? {
      status: "not_found",
      reason: "The matching scope is not selected",
    };
  }

  const first = selected[0];
  if (first === undefined) return undefined;
  const tied = selected.filter(
    (candidate) => first.score - candidate.score <= AMBIGUITY_DELTA,
  );
  if (tied.length >= 2) {
    return {
      status: "ambiguous",
      candidates: tied as [ScopeCandidate, ScopeCandidate, ...ScopeCandidate[]],
    };
  }
  return { status: "resolved", scope: first.scope, matchedBy: first.matchedBy };
}

async function unavailableResolution(
  scopes: ScopeRepository,
  address: ScopeAddress,
  scope: ScopeCandidate["scope"],
): Promise<ScopeResolution | undefined> {
  const availability = await scopes.getAvailability(address);
  if (availability === "selected") return undefined;
  const exclusion = await scopes.getExclusion(address);
  if (exclusion !== undefined) return { status: "excluded", scope, exclusion };
  return {
    status: "not_found",
    reason: availability === "not_selected"
      ? "The requested scope is not selected"
      : "The requested scope is unavailable",
  };
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError("Scope candidate limit must be from 1 to 100");
  }
  return value;
}
