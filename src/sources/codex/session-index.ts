// This handles reading the session index files to get the meta data of the sessions
// COmpared to rollout parser files; rollout files handle the codex session content files
// and get the complete files, whereas this handles session meta data and ndex files.

import type { SourceReadDiagnostic } from "../../contracts/source.js";
import { readCompleteLines } from "./rollout-reader.js";
import { normalizeTimestamp } from "./rollout-parser.js";

export interface CodexSessionIndexEntry {
  readonly sessionKey: string;
  readonly title?: string;
  readonly updatedAt?: string;
}

export type SessionIndexParseResult =
  | { readonly ok: true; readonly entry: CodexSessionIndexEntry }
  | {
      readonly ok: false;
      readonly code:
        | "EMPTY_LINE"
        | "LINE_TOO_LONG"
        | "INVALID_JSON"
        | "INVALID_RECORD";
    };

export interface SessionIndexLoadResult {
  readonly entries: readonly CodexSessionIndexEntry[];
  readonly diagnostics: readonly SourceReadDiagnostic[];
  readonly pendingPartialLine: boolean;
  readonly truncated: boolean;
}

export function parseSessionIndexLine(line: string): SessionIndexParseResult {
  if (line.length === 0) return { ok: false, code: "EMPTY_LINE" };
  if (line.length > 64 * 1_024) {
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
    value.id ?? value.session_id ?? value.thread_id,
    512,
  );
  if (sessionKey === undefined) {
    return { ok: false, code: "INVALID_RECORD" };
  }

  const title = boundedString(value.thread_name ?? value.title, 4_096);
  const updatedAt = normalizeTimestamp(value.updated_at ?? value.timestamp);
  return {
    ok: true,
    entry: {
      sessionKey,
      ...(title === undefined || title.length === 0 ? {} : { title }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    },
  };
}

export async function loadSessionIndex(
  path: string,
  maxBytes = 4 * 1_024 * 1_024,
  maxRecords = 10_000,
): Promise<SessionIndexLoadResult> {
  const read = await readCompleteLines(path, undefined, maxBytes, maxRecords);
  const entries: CodexSessionIndexEntry[] = [];
  const diagnostics = [...read.diagnostics];

  for (const line of read.lines) {
    const parsed = parseSessionIndexLine(line.text);
    if (parsed.ok) {
      entries.push(parsed.entry);
    } else {
      diagnostics.push({
        code:
          parsed.code === "INVALID_JSON" || parsed.code === "EMPTY_LINE"
            ? "MALFORMED_JSON"
            : "INVALID_RECORD",
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
      });
    }
  }

  return {
    entries,
    diagnostics,
    pendingPartialLine: read.pendingPartialLine,
    truncated: read.hasMore,
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
