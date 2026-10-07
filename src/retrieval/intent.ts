import type { SearchIntent } from "../contracts/search.js";

const MAX_QUERY_LENGTH = 2_048;

/** Classifies a query with deterministic, inspectable rules. */
export function classifyQuery(query: string): SearchIntent {
  const normalized = normalizeQuery(query);

  if (looksLikeExactError(normalized)) return "exact_error";
  if (looksLikeExactIdentifier(normalized)) return "exact_identifier";
  if (/\b(?:why|rationale|reason|decid(?:e|ed|ing)|reject(?:ed|ion)?|trade[ -]?off)\b/iu.test(normalized)) {
    return "decision_rationale";
  }
  if (/\b(?:debug(?:ging)?|troubleshoot|attempt(?:ed|s)?|tried|failure history|what failed)\b/iu.test(normalized)) {
    return "debugging_history";
  }
  if (/\b(?:timeline|chronolog(?:y|ical)|when|before|after|sequence|history of)\b/iu.test(normalized)) {
    return "chronology";
  }
  if (/\b(?:todo|to-do|open item|open question|remaining|follow[ -]?up|next step|what(?:'s| is) left)\b/iu.test(normalized)) {
    return "open_items";
  }
  if (/\b(?:latest|current|present state|where (?:are|did) we|status now|most recent)\b/iu.test(normalized)) {
    return "latest_state";
  }
  if (/\b(?:overview|summar(?:y|ize)|recap|big picture|across (?:the )?(?:project|workstream|sessions?))\b/iu.test(normalized)) {
    return "broad_synthesis";
  }
  return "general";
}

export function normalizeRetrievalQuery(query: string): string {
  return normalizeQuery(query);
}

function normalizeQuery(query: string): string {
  if (typeof query !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(query)) {
    throw new TypeError("Invalid search query");
  }
  const normalized = query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > MAX_QUERY_LENGTH) {
    throw new RangeError(`Search query must contain from 1 to ${MAX_QUERY_LENGTH} characters`);
  }
  return normalized;
}

function looksLikeExactError(query: string): boolean {
  return (
    /\b(?:TypeError|RangeError|ReferenceError|SyntaxError|Exception|Traceback|panic:)\b/u.test(query) ||
    /\b(?:ERR_|E[A-Z0-9_]{3,}|HTTP\s+[45]\d\d|exit code \d+)\b/u.test(query) ||
    /(?:error|exception|failed|failure|panic|traceback)\s*[:\-]\s*\S+/iu.test(query)
  );
}

function looksLikeExactIdentifier(query: string): boolean {
  return (
    /(?:\.{0,2}\/)?(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_.@-]+/u.test(query) ||
    /\b[A-Za-z_$][\w$]*(?:(?:::|\.|#)[A-Za-z_$][\w$]*)+\b/u.test(query) ||
    /[`'"][A-Za-z_$][A-Za-z0-9_$-]{2,}[`'"]/u.test(query)
  );
}
