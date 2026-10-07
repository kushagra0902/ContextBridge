import type {
  EvidenceChunk,
  EvidenceScope,
} from "../../contracts/evidence.js";
import { memoryId } from "../../contracts/ids.js";
import type {
  SessionSynopsisMemory,
  SynopsisSection,
  SynopsisSectionName,
} from "../../contracts/memory.js";

export const EXTRACTIVE_SYNOPSIS_VERSION = "extractive-synopsis-v1";

export interface SynopsisPolicy {
  readonly derivedAt: string;
  readonly extractorVersion?: string;
  readonly maxSectionCharacters?: number;
  readonly maxEvidencePerSection?: number;
}

interface EvidenceExcerpt {
  readonly chunk: EvidenceChunk;
  readonly text: string;
}

/**
 * Produces a bounded synopsis exclusively from verbatim chunk excerpts. It does
 * not infer success, current code state, or user intent beyond explicit text.
 */
export function buildExtractiveSynopsis(
  input: readonly EvidenceChunk[],
  policy: SynopsisPolicy,
): SessionSynopsisMemory | undefined {
  if (input.length === 0) return undefined;
  const chunks = orderAndValidateChunks(input);
  const scope = chunks[0]?.scope;
  if (scope === undefined) return undefined;
  const maximumCharacters = boundedInteger(
    policy.maxSectionCharacters ?? 1_200,
    128,
    8_000,
    "synopsis section character limit",
  );
  const maximumEvidence = boundedInteger(
    policy.maxEvidencePerSection ?? 5,
    1,
    20,
    "synopsis section evidence limit",
  );
  assertIsoDate(policy.derivedAt, "synopsis derivation time");
  const extractorVersion = policy.extractorVersion ?? EXTRACTIVE_SYNOPSIS_VERSION;

  const sections = [
    section("goal", firstMatches(chunks, userBlocks, 2), maximumCharacters, maximumEvidence),
    section(
      "current_state",
      lastMatches(chunks, assistantBlocks, 3),
      maximumCharacters,
      maximumEvidence,
    ),
    section(
      "constraints",
      matchingLines(chunks, /\b(must|cannot|can't|required?|constraint|only|never)\b/iu),
      maximumCharacters,
      maximumEvidence,
    ),
    section(
      "decisions",
      matchingLines(chunks, /\b(decision|decided|choose|chose|selected|agreed|instead of|supersed|replace)\b/iu),
      maximumCharacters,
      maximumEvidence,
    ),
    section(
      "recent_changes",
      chunks.slice(-3).map((chunk) => ({ chunk, text: chunk.displayText })),
      maximumCharacters,
      maximumEvidence,
    ),
    section(
      "open_questions",
      matchingLines(chunks, /(?:\?|\bTODO\b|\bfollow[- ]?up\b|\bremaining\b|\bnext step\b)/iu),
      maximumCharacters,
      maximumEvidence,
    ),
    section(
      "important_entities",
      matchingLines(chunks, /(?:[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+|\b[A-Za-z_$][\w$]*\.(?:ts|tsx|js|mjs|cjs|json|sql|md)\b)/u),
      maximumCharacters,
      maximumEvidence,
    ),
    section(
      "known_risks",
      matchingLines(chunks, /\b(risk|error|exception|failed?|failure|blocked?|warning|regression)\b/iu),
      maximumCharacters,
      maximumEvidence,
    ),
  ].filter((value): value is SynopsisSection => value !== undefined);

  if (sections.length === 0) return undefined;
  const evidenceIds = [...new Set(sections.flatMap((value) => value.evidenceIds))];
  const observed = chunks
    .flatMap((chunk) => [chunk.observedFrom, chunk.observedTo])
    .filter((value): value is string => value !== undefined)
    .sort();
  const observedFrom = observed[0];
  const observedTo = observed.at(-1);
  return {
    id: memoryId(["session_synopsis", scope.sessionId]),
    type: "session_synopsis",
    scope: { ...scope },
    title: "Extractive session synopsis",
    body: sections
      .map((value) => `${sectionTitle(value.name)}\n${value.text}`)
      .join("\n\n"),
    status: "active",
    evidenceIds,
    derivation: "extractive",
    extractorVersion,
    sections,
    ...(observedFrom === undefined ? {} : { observedFrom }),
    ...(observedTo === undefined ? {} : { observedTo }),
    derivedAt: policy.derivedAt,
    updatedAt: policy.derivedAt,
  };
}

export function orderAndValidateChunks(
  input: readonly EvidenceChunk[],
): readonly EvidenceChunk[] {
  const first = input[0];
  if (first === undefined) return [];
  const ids = new Set<string>();
  for (const chunk of input) {
    if (
      chunk.scope.sessionId !== first.scope.sessionId ||
      chunk.scope.projectId !== first.scope.projectId ||
      chunk.scope.workstreamId !== first.scope.workstreamId
    ) {
      throw new TypeError("Memory input chunks must share one exact scope");
    }
    if (ids.has(chunk.id)) {
      throw new Error("Memory input contains a duplicate chunk ID");
    }
    ids.add(chunk.id);
  }
  return [...input].sort((left, right) =>
    (left.observedFrom ?? "").localeCompare(right.observedFrom ?? "") ||
    left.id.localeCompare(right.id),
  );
}

function section(
  name: SynopsisSectionName,
  excerpts: readonly EvidenceExcerpt[],
  maximumCharacters: number,
  maximumEvidence: number,
): SynopsisSection | undefined {
  const selected: EvidenceExcerpt[] = [];
  const seenText = new Set<string>();
  let usedCharacters = 0;
  for (const excerpt of excerpts) {
    const normalized = excerpt.text.replace(/\s+/gu, " ").trim();
    if (normalized.length === 0 || seenText.has(normalized)) continue;
    const remaining = maximumCharacters - usedCharacters;
    if (remaining <= 0 || selected.length >= maximumEvidence) break;
    const text = boundedExcerpt(normalized, remaining);
    if (text.length === 0) continue;
    seenText.add(normalized);
    selected.push({ chunk: excerpt.chunk, text });
    usedCharacters += text.length + (selected.length === 1 ? 0 : 1);
  }
  if (selected.length === 0) return undefined;
  return {
    name,
    text: selected.map((value) => value.text).join("\n"),
    evidenceIds: selected.map((value) => value.chunk.id),
  };
}

function firstMatches(
  chunks: readonly EvidenceChunk[],
  extractor: (chunk: EvidenceChunk) => readonly EvidenceExcerpt[],
  limit: number,
): readonly EvidenceExcerpt[] {
  const found: EvidenceExcerpt[] = [];
  for (const chunk of chunks) {
    found.push(...extractor(chunk));
    if (found.length >= limit) return found.slice(0, limit);
  }
  return found;
}

function lastMatches(
  chunks: readonly EvidenceChunk[],
  extractor: (chunk: EvidenceChunk) => readonly EvidenceExcerpt[],
  limit: number,
): readonly EvidenceExcerpt[] {
  const found: EvidenceExcerpt[] = [];
  for (const chunk of [...chunks].reverse()) {
    found.unshift(...extractor(chunk));
    if (found.length >= limit) return found.slice(-limit);
  }
  return found;
}

function userBlocks(chunk: EvidenceChunk): readonly EvidenceExcerpt[] {
  return labeledBlocks(chunk, "User");
}

function assistantBlocks(chunk: EvidenceChunk): readonly EvidenceExcerpt[] {
  return labeledBlocks(chunk, "Assistant");
}

function labeledBlocks(
  chunk: EvidenceChunk,
  label: "User" | "Assistant",
): readonly EvidenceExcerpt[] {
  const expression = new RegExp(
    `(?:^|\\n\\n)${label}(?: \\(continued\\))?:\\n([\\s\\S]*?)(?=\\n\\n(?:User|Assistant|Tool call|Tool result)(?: \\(continued\\))?:|$)`,
    "gu",
  );
  return [...chunk.displayText.matchAll(expression)].flatMap((match) => {
    const text = match[1]?.trim();
    return text === undefined || text.length === 0 ? [] : [{ chunk, text }];
  });
}

function matchingLines(
  chunks: readonly EvidenceChunk[],
  pattern: RegExp,
): readonly EvidenceExcerpt[] {
  return chunks.flatMap((chunk) =>
    chunk.displayText
      .split("\n")
      .map((text) => text.trim())
      .filter((text) => text.length > 0 && pattern.test(text))
      .map((text) => ({ chunk, text })),
  );
}

function boundedExcerpt(text: string, maximumCharacters: number): string {
  if (text.length <= maximumCharacters) return text;
  if (maximumCharacters <= 1) return text.slice(0, maximumCharacters);
  return `${text.slice(0, maximumCharacters - 1).trimEnd()}…`;
}

function sectionTitle(name: SynopsisSectionName): string {
  return name.replaceAll("_", " ").replace(/^./u, (value) => value.toUpperCase());
}

function boundedInteger(
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

function assertIsoDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`Invalid ${label}`);
  }
}

export function evidenceScopeFromChunks(
  chunks: readonly EvidenceChunk[],
): EvidenceScope | undefined {
  return orderAndValidateChunks(chunks)[0]?.scope;
}
