import type { EvidenceChunk, EvidenceScope } from "../../contracts/evidence.js";
import { memoryId } from "../../contracts/ids.js";
import type {
  DecisionAlternative,
  DecisionMemory,
  MemoryRecord,
  OpenItemKind,
  OpenItemMemory,
} from "../../contracts/memory.js";
import { orderAndValidateChunks } from "./synopsis.js";

export const HEURISTIC_DECISION_VERSION = "heuristic-decision-v1";
export const HEURISTIC_OPEN_ITEM_VERSION = "heuristic-open-item-v1";

export interface CandidatePolicy {
  readonly derivedAt: string;
  readonly maxCandidates?: number;
  readonly maxCandidateCharacters?: number;
}

const DECISION_PATTERNS = [
  /^(?:decision\s*:\s*)(.+)$/iu,
  /^(?:we\s+)?decided(?:\s+to|\s+on)?\s+(.+)$/iu,
  /^we\s+(?:choose|chose|selected|agreed)(?:\s+to|\s+on)?\s+(.+)$/iu,
  /^(?:we\s+)?will\s+use\s+(.+)$/iu,
];
const SUPERSESSION = /\b(instead of|supersed(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|no longer use|switch(?:ed|ing)? from)\b/iu;
const CONFLICT = /\b(conflicts? with|contradicts?)\b/iu;
const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "because", "by", "for", "from",
  "in", "instead", "is", "it", "of", "on", "or", "our", "the", "to",
  "use", "we", "will", "with",
]);

export function extractDecisionCandidates(
  input: readonly EvidenceChunk[],
  policy: CandidatePolicy,
): readonly DecisionMemory[] {
  const chunks = orderAndValidateChunks(input);
  if (chunks.length === 0) return [];
  validatePolicy(policy);
  const scope = chunks[0]?.scope;
  if (scope === undefined) return [];
  const maximum = policy.maxCandidates ?? 200;
  const maximumCharacters = policy.maxCandidateCharacters ?? 1_200;
  const decisions: DecisionMemory[] = [];

  for (const chunk of chunks) {
    const sentences = extractSentences(chunk.displayText);
    for (const sentence of sentences) {
      const captured = captureDecision(sentence);
      if (captured === undefined) continue;
      const split = splitRationale(captured);
      const decision = boundedText(split.decision, maximumCharacters);
      if (decision.length === 0) continue;
      const alternatives = extractAlternatives(sentences, decision, maximumCharacters);
      const constraints = sentences
        .filter((value) => /\b(must|cannot|can't|required?|constraint)\b/iu.test(value))
        .slice(0, 8)
        .map((value) => boundedText(value, 300));
      const affectedEntities = extractEntities(sentence).slice(0, 20);
      const normalized = normalizeIdentity(decision);
      const rationale = boundedText(split.rationale ?? "No explicit rationale was captured.", maximumCharacters);
      decisions.push({
        id: memoryId(["decision", scope.sessionId, chunk.id, normalized]),
        type: "decision",
        scope: { ...scope },
        title: `Decision candidate: ${boundedText(decision, 120)}`,
        body: renderDecisionBody(decision, rationale, alternatives),
        status: "candidate",
        evidenceIds: [chunk.id],
        derivation: "heuristic",
        extractorVersion: HEURISTIC_DECISION_VERSION,
        decision,
        rationale,
        alternatives,
        constraints,
        affectedEntities,
        ...(chunk.observedFrom === undefined ? {} : { observedFrom: chunk.observedFrom }),
        ...(chunk.observedTo === undefined ? {} : { observedTo: chunk.observedTo }),
        derivedAt: policy.derivedAt,
        updatedAt: policy.derivedAt,
      });
      if (decisions.length === maximum) return reconcileDecisionTimeline(decisions);
    }
  }
  return reconcileDecisionTimeline(decisions);
}

export function extractOpenItemCandidates(
  input: readonly EvidenceChunk[],
  policy: CandidatePolicy,
): readonly OpenItemMemory[] {
  const chunks = orderAndValidateChunks(input);
  if (chunks.length === 0) return [];
  validatePolicy(policy);
  const scope = chunks[0]?.scope;
  if (scope === undefined) return [];
  const maximum = policy.maxCandidates ?? 200;
  const maximumCharacters = policy.maxCandidateCharacters ?? 1_200;
  const records: OpenItemMemory[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    for (const sentence of extractSentences(chunk.displayText)) {
      const itemKind = classifyOpenItem(sentence);
      if (itemKind === undefined || /\b(done|completed|resolved|fixed)\b/iu.test(sentence)) {
        continue;
      }
      const item = boundedText(sentence, maximumCharacters);
      const normalized = normalizeIdentity(item);
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      records.push({
        id: memoryId(["open_item", scope.sessionId, chunk.id, normalized]),
        type: "open_item",
        scope: { ...scope },
        title: `${openItemTitle(itemKind)}: ${boundedText(item, 120)}`,
        body: `Heuristic ${itemKind.replaceAll("_", " ")} candidate:\n${item}`,
        status: "candidate",
        evidenceIds: [chunk.id],
        derivation: "heuristic",
        extractorVersion: HEURISTIC_OPEN_ITEM_VERSION,
        itemKind,
        ...(chunk.observedFrom === undefined ? {} : { observedFrom: chunk.observedFrom }),
        ...(chunk.observedTo === undefined ? {} : { observedTo: chunk.observedTo }),
        derivedAt: policy.derivedAt,
        updatedAt: policy.derivedAt,
      });
      if (records.length === maximum) return records;
    }
  }
  return records;
}

/** Preserves every decision while marking only explicit replacement/conflict language. */
export function reconcileDecisionTimeline(
  input: readonly DecisionMemory[],
): readonly DecisionMemory[] {
  const decisions = [...input].sort(compareMemoryTime);
  const result = new Map(decisions.map((decision) => [decision.id, decision]));
  for (let index = 0; index < decisions.length; index += 1) {
    const current = decisions[index];
    if (current === undefined) continue;
    const explicitSupersession = SUPERSESSION.test(`${current.decision}\n${current.body}`);
    const explicitConflict = CONFLICT.test(`${current.decision}\n${current.body}`);
    if (!explicitSupersession && !explicitConflict) continue;
    const prior = bestRelatedDecision(decisions.slice(0, index), current);
    if (prior === undefined) continue;

    if (explicitSupersession) {
      const currentRecord = result.get(current.id) ?? current;
      const priorRecord = result.get(prior.id) ?? prior;
      result.set(current.id, {
        ...currentRecord,
        supersedes: uniqueIds([...(currentRecord.supersedes ?? []), prior.id]),
      });
      result.set(prior.id, {
        ...priorRecord,
        status: "superseded",
        supersededBy: current.id,
      });
    } else {
      const currentRecord = result.get(current.id) ?? current;
      const priorRecord = result.get(prior.id) ?? prior;
      result.set(current.id, { ...currentRecord, status: "conflicted" });
      result.set(prior.id, { ...priorRecord, status: "conflicted" });
    }
  }
  return decisions.map((decision) => result.get(decision.id) ?? decision);
}

export function isManagedHeuristicMemory(memory: MemoryRecord): boolean {
  return memory.extractorVersion === HEURISTIC_DECISION_VERSION ||
    memory.extractorVersion === HEURISTIC_OPEN_ITEM_VERSION;
}

function captureDecision(sentence: string): string | undefined {
  const withoutLabel = sentence.replace(/^(User|Assistant|Tool call|Tool result)(?: \(continued\))?:\s*/u, "");
  for (const pattern of DECISION_PATTERNS) {
    const match = withoutLabel.match(pattern);
    const value = match?.[1]?.trim();
    if (value !== undefined && value.length >= 3) return value;
  }
  return undefined;
}

function splitRationale(value: string): {
  readonly decision: string;
  readonly rationale?: string;
} {
  const match = value.match(/^([\s\S]*?)\s+because\s+([\s\S]+)$/iu);
  if (match?.[1] === undefined || match[2] === undefined) return { decision: value };
  return { decision: match[1].trim(), rationale: match[2].trim() };
}

function extractAlternatives(
  sentences: readonly string[],
  decision: string,
  maximumCharacters: number,
): readonly DecisionAlternative[] {
  const alternatives: DecisionAlternative[] = [];
  const instead = decision.match(/\binstead of\s+(.+)$/iu)?.[1];
  if (instead !== undefined) {
    alternatives.push({ name: boundedText(instead, 300), outcome: "rejected" });
  }
  for (const sentence of sentences) {
    const rejected = sentence.match(/(?:we\s+)?rejected\s+(.+?)(?:\s+because\s+(.+))?$/iu) ??
      sentence.match(/^(.+?)\s+was rejected(?:\s+because\s+(.+))?$/iu);
    if (rejected?.[1] === undefined) continue;
    alternatives.push({
      name: boundedText(rejected[1], 300),
      outcome: "rejected",
      ...(rejected[2] === undefined
        ? {}
        : { reason: boundedText(rejected[2], maximumCharacters) }),
    });
    if (alternatives.length === 8) break;
  }
  return alternatives;
}

function bestRelatedDecision(
  prior: readonly DecisionMemory[],
  current: DecisionMemory,
): DecisionMemory | undefined {
  let best: { decision: DecisionMemory; score: number } | undefined;
  for (const candidate of prior) {
    const score = tokenSimilarity(candidate.decision, current.decision);
    if (score < 0.2 || (best !== undefined && score <= best.score)) continue;
    best = { decision: candidate, score };
  }
  return best?.decision;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = identityTokens(left);
  const rightTokens = identityTokens(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

function identityTokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) ?? [],
  );
}

function classifyOpenItem(value: string): OpenItemKind | undefined {
  const text = value
    .replace(/^(User|Assistant|Tool call|Tool result)(?: \(continued\))?:\s*/u, "")
    .trim();
  if (/^(?:open|unanswered) question\s*:/iu.test(text)) return "question";
  if (/^(?:known )?(?:risk|blocker)\s*:/iu.test(text) || /\bremains? blocked\b/iu.test(text)) {
    return "risk";
  }
  if (/^(?:deferred decision|defer)\s*:/iu.test(text) || /\bdefer(?:red)? until\b/iu.test(text)) {
    return "deferred_decision";
  }
  if (/^(?:follow[- ]?up|next step|remaining)\s*:/iu.test(text) || /\bneed to follow up\b/iu.test(text)) {
    return "follow_up";
  }
  if (/^TODO\s*:/u.test(text) || /\b(?:still )?need to\b/iu.test(text) || /\bremains? to be\b/iu.test(text)) {
    return "todo";
  }
  return undefined;
}

function extractSentences(text: string): readonly string[] {
  return text
    .replaceAll("\r", "")
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);
}

function extractEntities(value: string): readonly string[] {
  return [...new Set(
    value.match(/(?:[A-Za-z0-9_.-]+\/)+(?:[A-Za-z0-9_.-]+)|\b[A-Za-z_$][\w$]*\.(?:ts|tsx|js|mjs|cjs|json|sql|md)\b/gu) ?? [],
  )];
}

function renderDecisionBody(
  decision: string,
  rationale: string,
  alternatives: readonly DecisionAlternative[],
): string {
  const lines = [
    "Heuristic decision candidate; verify against the linked evidence.",
    `Decision: ${decision}`,
    `Rationale: ${rationale}`,
  ];
  for (const alternative of alternatives) {
    lines.push(
      `Alternative ${alternative.outcome}: ${alternative.name}` +
        (alternative.reason === undefined ? "" : ` — ${alternative.reason}`),
    );
  }
  return lines.join("\n");
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function boundedText(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function openItemTitle(kind: OpenItemKind): string {
  switch (kind) {
    case "todo": return "TODO candidate";
    case "question": return "Open question candidate";
    case "risk": return "Risk candidate";
    case "deferred_decision": return "Deferred decision candidate";
    case "follow_up": return "Follow-up candidate";
  }
}

function compareMemoryTime(left: DecisionMemory, right: DecisionMemory): number {
  return (left.observedTo ?? left.observedFrom ?? "")
    .localeCompare(right.observedTo ?? right.observedFrom ?? "") ||
    left.id.localeCompare(right.id);
}

function uniqueIds<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function validatePolicy(policy: CandidatePolicy): void {
  if (!Number.isFinite(Date.parse(policy.derivedAt))) {
    throw new TypeError("Invalid candidate derivation time");
  }
  if (
    policy.maxCandidates !== undefined &&
    (!Number.isSafeInteger(policy.maxCandidates) || policy.maxCandidates < 1 || policy.maxCandidates > 1_000)
  ) {
    throw new RangeError("Candidate limit must be from 1 to 1000");
  }
  if (
    policy.maxCandidateCharacters !== undefined &&
    (!Number.isSafeInteger(policy.maxCandidateCharacters) ||
      policy.maxCandidateCharacters < 128 ||
      policy.maxCandidateCharacters > 8_000)
  ) {
    throw new RangeError("Candidate character limit must be from 128 to 8000");
  }
}

export function scopeForCandidates(
  chunks: readonly EvidenceChunk[],
): EvidenceScope | undefined {
  return orderAndValidateChunks(chunks)[0]?.scope;
}
