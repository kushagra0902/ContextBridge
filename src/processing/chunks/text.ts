// Gives textual representation to the chunks 
// Two forms Embedding text and display text

import type {
  CanonicalEvent,
  OmissionMarker,
  OmissionReason,
} from "../../contracts/evidence.js";

import type { Tokenizer } from "../../contracts/ports.js";

const ERROR_LINE = /(error|exception|fail(?:ed|ure)?|fatal|panic|traceback)/iu;
const TOKEN_PATTERN = /\p{L}{1,4}|\p{N}{1,3}|[^\s\p{L}\p{N}]/gu;

export interface PreparedEventText {
  readonly displayText: string;
  readonly embeddingText: string;
  readonly omissions: readonly OmissionMarker[];
}

export interface EventTextPolicy {
  readonly maxToolOutputCharacters: number;
}

/**
 * Deterministic fallback used before a model-specific tokenizer is installed.
 * It deliberately splits long words/code identifiers into small pieces. M10
 * can inject the active embedding model's exact tokenizer through the port.
 */
export const heuristicTokenizer: Tokenizer = {
  count(text: string): number {
    return text.match(TOKEN_PATTERN)?.length ?? 0;
  },
  truncate(text: string, maxTokens: number): string {
    validateTokenLimit(maxTokens);
    return longestPrefixWithin(text, maxTokens, this);
  },
};

export function prepareEventText(
  event: CanonicalEvent,
  policy: EventTextPolicy,
): PreparedEventText {
  if (
    !Number.isSafeInteger(policy.maxToolOutputCharacters) ||
    policy.maxToolOutputCharacters < 128
  ) {
    throw new RangeError("Tool output character limit must be at least 128");
  }
  const normalized = event.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const compacted = event.kind === "tool_result"
    ? compactToolOutput(normalized, policy.maxToolOutputCharacters)
    : { text: normalized, omissions: [] as readonly TextOmission[] };
  return {
    displayText: compacted.text,
    embeddingText: normalizeEmbeddingText(compacted.text),
    omissions: compacted.omissions.map((omission) => ({
      eventId: event.id,
      reason: omission.reason,
      ...(omission.omittedCharacters === undefined
        ? {}
        : { omittedCharacters: omission.omittedCharacters }),
    })),
  };
}

export function eventLabel(event: CanonicalEvent): string {
  switch (event.kind) {
    case "user_message":
      return "User";
    case "assistant_message":
      return "Assistant";
    case "tool_call":
      return "Tool call";
    case "tool_result":
      return "Tool result";
  }
}

export function renderEventDisplay(
  event: CanonicalEvent,
  text: string,
  continued: boolean,
): string {
  return `${eventLabel(event)}${continued ? " (continued)" : ""}:\n${text}`;
}

export function renderEventEmbedding(
  event: CanonicalEvent,
  text: string,
  continued: boolean,
): string {
  return `${eventLabel(event)}${continued ? " continued" : ""}: ${normalizeEmbeddingText(text)}`;
}

export function splitEventText(
  event: CanonicalEvent,
  prepared: PreparedEventText,
  maxTokens: number,
  tokenizer: Tokenizer,
): readonly { readonly displayText: string; readonly embeddingText: string }[] {
  validateTokenLimit(maxTokens);
  if (prepared.displayText.length === 0) {
    return [{
      displayText: renderEventDisplay(event, "[empty output]", false),
      embeddingText: renderEventEmbedding(event, "[empty output]", false),
    }];
  }

  const parts: { displayText: string; embeddingText: string }[] = [];
  let remaining = prepared.displayText;
  while (remaining.length > 0) {
    const continued = parts.length > 0;
    const completeEmbedding = renderEventEmbedding(event, remaining, continued);
    let selected = remaining;
    if (countTokens(completeEmbedding, tokenizer) > maxTokens) {
      selected = longestBodyPrefix(event, remaining, continued, maxTokens, tokenizer);
      if (selected.length === 0) {
        throw new RangeError("Chunk token limit is too small for an event label");
      }
    }
    parts.push({
      displayText: renderEventDisplay(event, selected, continued),
      embeddingText: renderEventEmbedding(event, selected, continued),
    });
    remaining = remaining.slice(selected.length).trimStart();
  }
  return parts;
}

export function countTokens(text: string, tokenizer: Tokenizer): number {
  const count = tokenizer.count(text);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Tokenizer returned an invalid token count");
  }
  return count;
}

interface TextOmission {
  readonly reason: OmissionReason;
  readonly omittedCharacters?: number;
}

function compactToolOutput(
  text: string,
  maximumCharacters: number,
): { readonly text: string; readonly omissions: readonly TextOmission[] } {
  const repeated = compactRepeatedLines(text);
  const omissions: TextOmission[] = [...repeated.omissions];
  if (repeated.text.length <= maximumCharacters) {
    return { text: repeated.text, omissions };
  }

  const errorLines = repeated.text
    .split("\n")
    .filter((line) => ERROR_LINE.test(line))
    .join("\n");
  const marker = "\n... [output omitted] ...\n";
  const markerCount = errorLines.length === 0 ? 1 : 2;
  const sourceBudget = Math.max(0, maximumCharacters - marker.length * markerCount);
  const errorBudget = Math.min(Math.floor(sourceBudget * 0.5), errorLines.length);
  const edgeBudget = sourceBudget - errorBudget;
  const headBudget = Math.ceil(edgeBudget / 2);
  const tailBudget = Math.floor(edgeBudget / 2);
  const head = repeated.text.slice(0, headBudget);
  const errors = errorLines.slice(0, errorBudget);
  const tail = tailBudget === 0 ? "" : repeated.text.slice(-tailBudget);
  const middle = errors.length === 0 ? marker : `${marker}${errors}${marker}`;
  const compacted = `${head}${middle}${tail}`;
  omissions.push({
    reason: "output_limit",
    omittedCharacters: Math.max(1, repeated.text.length - sourceBudget),
  });
  return { text: compacted, omissions };
}

function compactRepeatedLines(
  text: string,
): { readonly text: string; readonly omissions: readonly TextOmission[] } {
  const lines = text.split("\n");
  const output: string[] = [];
  let omittedCharacters = 0;
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const runLength = end - index;
    if (line.length > 0 && runLength > 3) {
      output.push(line, line, `... [${runLength - 2} repeated lines omitted] ...`);
      omittedCharacters += (line.length + 1) * (runLength - 2);
    } else {
      output.push(...lines.slice(index, end));
    }
    index = end;
  }
  return {
    text: output.join("\n"),
    omissions: omittedCharacters === 0
      ? []
      : [{ reason: "repetitive_output", omittedCharacters }],
  };
}

function normalizeEmbeddingText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function longestBodyPrefix(
  event: CanonicalEvent,
  text: string,
  continued: boolean,
  maxTokens: number,
  tokenizer: Tokenizer,
): string {
  const codePoints = [...text];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = codePoints.slice(0, middle).join("");
    if (countTokens(renderEventEmbedding(event, candidate, continued), tokenizer) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low === 0) return "";
  const prefix = codePoints.slice(0, low).join("");
  const minimumUsefulBreak = Math.floor(prefix.length * 0.6);
  const newline = prefix.lastIndexOf("\n");
  const space = prefix.lastIndexOf(" ");
  const boundary = Math.max(newline, space);
  return boundary >= minimumUsefulBreak ? prefix.slice(0, boundary + 1) : prefix;
}

function longestPrefixWithin(
  text: string,
  maxTokens: number,
  tokenizer: Tokenizer,
): string {
  const codePoints = [...text];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = codePoints.slice(0, middle).join("");
    if (tokenizer.count(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return codePoints.slice(0, low).join("");
}

function validateTokenLimit(maxTokens: number): void {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new RangeError("Token limit must be a non-negative safe integer");
  }
}
