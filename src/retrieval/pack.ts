import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { OutputPolicy, Tokenizer } from "../contracts/ports.js";
import type {
  SearchBudget,
  SearchCursor,
  SearchHit,
  SearchLimitKind,
  SearchTruncation,
} from "../contracts/search.js";
import { parseSearchCursor } from "../contracts/search.js";

interface CursorPayload {
  readonly v: 1;
  readonly offset: number;
  readonly context: string;
}

export interface PackSearchOptions {
  readonly budget: SearchBudget;
  readonly cursor?: SearchCursor;
  readonly cursorSecret: string;
  readonly contextKey: string;
  readonly outputPolicy?: Pick<OutputPolicy, "sanitizeText">;
  readonly tokenizer?: Tokenizer;
}

export interface PackedSearchHits {
  readonly hits: readonly SearchHit[];
  readonly truncation: SearchTruncation;
  readonly continuation?: SearchCursor;
}

/** Sanitizes result text and applies hard item, serialized-byte, and token caps. */
export async function packSearchHits(
  hits: readonly SearchHit[],
  options: PackSearchOptions,
): Promise<PackedSearchHits> {
  validateBudget(options.budget);
  validateCursorInputs(options.cursorSecret, options.contextKey);
  const offset = options.cursor === undefined
    ? 0
    : decodeCursor(options.cursor, options.cursorSecret, options.contextKey).offset;
  if (offset > hits.length) throw new TypeError("Search cursor is outside this result set");

  const packed: SearchHit[] = [];
  const limits = new Set<SearchLimitKind>();
  let nextOffset = offset;
  for (let index = offset; index < hits.length; index += 1) {
    if (packed.length >= options.budget.maxItems) {
      limits.add("items");
      nextOffset = index;
      break;
    }
    const sanitized = await sanitizeHit(hits[index]!, options.outputPolicy);
    const fitted = fitHit([...packed, sanitized], options.budget, options.tokenizer);
    if (fitted !== undefined) {
      packed.push(fitted);
      nextOffset = index + 1;
      if (fitted.snippet.length < sanitized.snippet.length) {
        addMeasuredLimits(limits, [...packed, sanitized], options.budget, options.tokenizer);
        break;
      }
      continue;
    }
    addMeasuredLimits(limits, [...packed, sanitized], options.budget, options.tokenizer);
    // Skip an item whose provenance alone cannot fit, preventing a stuck cursor.
    nextOffset = index + 1;
    break;
  }

  const truncated = nextOffset < hits.length || limits.size > 0;
  return {
    hits: packed,
    truncation: { truncated, limitsReached: [...limits] },
    ...(truncated && nextOffset < hits.length
      ? { continuation: encodeCursor(nextOffset, options.cursorSecret, options.contextKey) }
      : {}),
  };
}

export function encodeSearchCursor(
  offset: number,
  secret: string,
  contextKey: string,
): SearchCursor {
  validateCursorInputs(secret, contextKey);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid search cursor offset");
  return encodeCursor(offset, secret, contextKey);
}

export function decodeSearchCursor(
  cursor: SearchCursor,
  secret: string,
  contextKey: string,
): number {
  validateCursorInputs(secret, contextKey);
  return decodeCursor(cursor, secret, contextKey).offset;
}

async function sanitizeHit(
  hit: SearchHit,
  policy: PackSearchOptions["outputPolicy"],
): Promise<SearchHit> {
  if (policy === undefined) return hit;
  const [title, snippet] = await Promise.all([
    hit.title === undefined ? undefined : policy.sanitizeText(hit.title),
    policy.sanitizeText(hit.snippet),
  ]);
  return { ...hit, ...(title === undefined ? {} : { title }), snippet };
}

function fitHit(
  hits: readonly SearchHit[],
  budget: SearchBudget,
  tokenizer: Tokenizer | undefined,
): SearchHit | undefined {
  if (withinMeasuredBudget(hits, budget, tokenizer)) return hits[hits.length - 1];
  const last = hits[hits.length - 1];
  if (last === undefined || last.snippet.length === 0) return undefined;
  let low = 0;
  let high = last.snippet.length;
  let best: SearchHit | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const shortened = { ...last, snippet: last.snippet.slice(0, middle) };
    if (withinMeasuredBudget([...hits.slice(0, -1), shortened], budget, tokenizer)) {
      best = shortened;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function withinMeasuredBudget(
  hits: readonly SearchHit[],
  budget: SearchBudget,
  tokenizer: Tokenizer | undefined,
): boolean {
  const text = JSON.stringify({ hits });
  return Buffer.byteLength(text) <= budget.maxBytes && countTokens(text, tokenizer) <= budget.maxTokens;
}

function addMeasuredLimits(
  target: Set<SearchLimitKind>,
  hits: readonly SearchHit[],
  budget: SearchBudget,
  tokenizer: Tokenizer | undefined,
): void {
  const text = JSON.stringify({ hits });
  if (Buffer.byteLength(text) > budget.maxBytes) target.add("bytes");
  if (countTokens(text, tokenizer) > budget.maxTokens) target.add("tokens");
}

function countTokens(text: string, tokenizer: Tokenizer | undefined): number {
  const count = tokenizer?.count(text) ?? Buffer.byteLength(text);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Tokenizer returned an invalid token count");
  return count;
}

function encodeCursor(offset: number, secret: string, context: string): SearchCursor {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    offset,
    context: contextDigest(context),
  } satisfies CursorPayload)).toString("base64url");
  const signature = sign(payload, secret);
  return parseSearchCursor(`${payload}.${signature}`);
}

function decodeCursor(cursor: SearchCursor, secret: string, context: string): CursorPayload {
  const parsed = parseSearchCursor(cursor);
  const parts = parsed.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) throw new TypeError("Invalid search cursor");
  const expected = Buffer.from(sign(parts[0], secret));
  const received = Buffer.from(parts[1]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new TypeError("Invalid search cursor signature");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Invalid search cursor payload");
  }
  if (!isCursorPayload(payload) || payload.context !== contextDigest(context)) throw new TypeError("Search cursor does not match this request");
  return payload;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function contextDigest(context: string): string {
  return createHash("sha256").update(context).digest("base64url");
}

function isCursorPayload(value: unknown): value is CursorPayload {
  return typeof value === "object" && value !== null &&
    (value as Partial<CursorPayload>).v === 1 &&
    Number.isSafeInteger((value as Partial<CursorPayload>).offset) &&
    ((value as Partial<CursorPayload>).offset ?? -1) >= 0 &&
    typeof (value as Partial<CursorPayload>).context === "string";
}

function validateBudget(budget: SearchBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid search budget ${key}`);
  }
}

function validateCursorInputs(secret: string, contextKey: string): void {
  if (secret.length < 16) throw new TypeError("Cursor secret must contain at least 16 characters");
  if (contextKey.length === 0 || contextKey.length > 2_048) throw new TypeError("Invalid cursor context");
}
