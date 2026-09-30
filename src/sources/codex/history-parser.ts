// This is for handlign the older format of codex of history.jsonl(json line)
// and produces parsed history evidence format struct whihc is then used to 
// make the structs of the format mentioned in contracts. 

import { normalizeTimestamp } from "./rollout-parser.js";

export interface ParsedHistoryEvidence {
  readonly kind: "evidence";
  readonly sessionKey: string;
  readonly text: string;
  readonly role: "user";
  readonly observedAt?: string;
  readonly recordKey?: string;
}

export interface ParsedHistoryMetadata {
  readonly kind: "metadata";
  readonly sessionKey: string;
  readonly observedAt?: string;
}

export type ParsedHistoryRecord =
  | ParsedHistoryEvidence
  | ParsedHistoryMetadata;

export type HistoryParseResult =
  | { readonly ok: true; readonly record: ParsedHistoryRecord }
  | {
      readonly ok: false;
      readonly code:
        | "EMPTY_LINE"
        | "LINE_TOO_LONG"
        | "INVALID_JSON"
        | "INVALID_RECORD";
    };

const MAX_LINE_CHARACTERS = 2 * 1_024 * 1_024;
const MAX_TEXT_CHARACTERS = 1 * 1_024 * 1_024;

/**
 * Historical Codex history rows are user prompt evidence only when both a
 * session key and bounded text are present. Metadata-only rows never become
 * canonical transcript events.
 */
export function parseHistoryLine(line: string): HistoryParseResult {
  if (line.length === 0) return { ok: false, code: "EMPTY_LINE" };
  if (line.length > MAX_LINE_CHARACTERS) {
    return { ok: false, code: "LINE_TOO_LONG" };
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, code: "INVALID_JSON" };
  }
  if (!isRecord(value)) return { ok: false, code: "INVALID_RECORD" };

  const sessionKey = boundedIdentifier(
    value.session_id ?? value.conversation_id ?? value.thread_id ?? value.id,
    512,
  );
  if (sessionKey === undefined) {
    return { ok: false, code: "INVALID_RECORD" };
  }

  const observedAt = normalizeTimestamp(
    value.ts ?? value.timestamp ?? value.updated_at,
  );
  const text = boundedString(value.text ?? value.message, MAX_TEXT_CHARACTERS);
  if (text === undefined || text.length === 0) {
    return {
      ok: true,
      record: {
        kind: "metadata",
        sessionKey,
        ...(observedAt === undefined ? {} : { observedAt }),
      },
    };
  }

  const recordKey = boundedIdentifier(value.id, 512);
  return {
    ok: true,
    record: {
      kind: "evidence",
      sessionKey,
      text,
      role: "user",
      ...(observedAt === undefined ? {} : { observedAt }),
      ...(recordKey === undefined ? {} : { recordKey }),
    },
  };
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedIdentifier(value: unknown, maximum: number): string | undefined {
  const text = boundedString(value, maximum);
  return text !== undefined && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
