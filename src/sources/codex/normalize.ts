// Converts the parsed structures from CODEX files to the canonical event format

import type {
  CanonicalEvent,
  CanonicalEventKind,
} from "../../contracts/evidence.js";

import type { SessionId } from "../../contracts/ids.js";
import { isStableId } from "../../contracts/ids.js";

import type {
  SourceKind,
  SourceRecord,
} from "../../contracts/source.js";

import {
  redactText,
  type RedactionOptions,
  type UserRedactionRule,
} from "../../security/redact.js";

import type { ParsedHistoryRecord } from "./history-parser.js";

import {
  codexEventId,
  contentFingerprint,
} from "./identity.js";

import type { ParsedRolloutRecord } from "./rollout-parser.js";
import type { CodexSessionIndexEntry } from "./session-index.js";

export type ParsedCodexSourceRecord =
  | { readonly origin: "rollout"; readonly value: ParsedRolloutRecord }
  | { readonly origin: "history"; readonly value: ParsedHistoryRecord }
  | { readonly origin: "session_index"; readonly value: CodexSessionIndexEntry };

export interface CodexSourcePayload {
  readonly schemaVersion: 1;
  readonly sourceKind: SourceKind;
  readonly formatVersion: string;
  readonly sessionId: SessionId;
  readonly parsed: ParsedCodexSourceRecord;
}

export interface NormalizeCodexOptions extends RedactionOptions {
  readonly redactionRules?: readonly UserRedactionRule[];
  readonly maxTextCharacters?: number;
}

const DEFAULT_MAX_TEXT_CHARACTERS = 1_048_576;
const TRUNCATION_MARKER = "\n[OUTPUT TRUNCATED]";

export async function normalizeCodexRecord(
  record: SourceRecord,
  options: NormalizeCodexOptions = {},
): Promise<readonly CanonicalEvent[]> {
  if (!isCodexSourcePayload(record.payload)) return [];
  const payload = record.payload;
  const extracted = extractEvent(payload.parsed);
  if (extracted === undefined) return [];

  const maxTextCharacters =
    options.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS;
  if (
    !Number.isSafeInteger(maxTextCharacters) ||
    maxTextCharacters < 64 ||
    maxTextCharacters > DEFAULT_MAX_TEXT_CHARACTERS
  ) {
    throw new RangeError("Invalid Codex normalization text limit");
  }

  const marker = TRUNCATION_MARKER.slice(0, maxTextCharacters);
  const boundedText =
    extracted.text.length <= maxTextCharacters
      ? extracted.text
      : `${extracted.text.slice(0, maxTextCharacters - marker.length)}${marker}`;
  const redacted = await redactText(
    boundedText,
    options.redactionRules ?? [],
    redactionOptions(options),
  );
  if (redacted.text.length === 0 && extracted.kind !== "tool_result") return [];

  const stableRecordKey =
    extracted.recordKey ??
    `${record.sourceId}:${record.ordinal}:${record.byteStart}:${extracted.kind}`;
  const event: CanonicalEvent = {
    id: codexEventId(payload.sessionId, extracted.kind, stableRecordKey),
    sessionId: payload.sessionId,
    ordinal: record.ordinal,
    kind: extracted.kind,
    ...(extracted.observedAt === undefined
      ? {}
      : { observedAt: extracted.observedAt }),
    text: redacted.text,
    contentHash: contentFingerprint(redacted.text),
    EvidenceSource: {
      sourceId: record.sourceId,
      sourceOrdinal: record.ordinal,
      byteStart: record.byteStart,
      byteEnd: record.byteEnd,
      formatVersion: payload.formatVersion,
    },
    ...(redacted.spans.length === 0 ? {} : { redactions: redacted.spans }),
    ...(extracted.toolCallId === undefined
      ? {}
      : { toolCallId: extracted.toolCallId }),
  };
  return [event];
}

export function isCodexSourcePayload(value: unknown): value is CodexSourcePayload {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (
    !["codex_rollout", "codex_history", "codex_session_index"].includes(
      String(value.sourceKind),
    ) ||
    typeof value.formatVersion !== "string" ||
    value.formatVersion.length === 0 ||
    value.formatVersion.length > 128 ||
    !isStableId(value.sessionId, "session") ||
    !isRecord(value.parsed) ||
    !["rollout", "history", "session_index"].includes(
      String(value.parsed.origin),
    )
  ) {
    return false;
  }
  return isValidParsedRecord(value.parsed);
}

function isValidParsedRecord(parsed: Record<string, unknown>): boolean {
  if (!isRecord(parsed.value)) return false;
  const value = parsed.value;
  switch (parsed.origin) {
    case "session_index":
      return typeof value.sessionKey === "string";
    case "history":
      return (
        (value.kind === "metadata" && typeof value.sessionKey === "string") ||
        (value.kind === "evidence" &&
          typeof value.sessionKey === "string" &&
          typeof value.text === "string" &&
          value.role === "user")
      );
    case "rollout":
      switch (value.kind) {
        case "session_meta":
        case "ignored":
          return true;
        case "message":
          return (
            (value.role === "user" || value.role === "assistant") &&
            typeof value.text === "string" &&
            (value.variant === "response_item" || value.variant === "event_msg")
          );
        case "tool_call":
          return (
            typeof value.toolName === "string" && typeof value.input === "string"
          );
        case "tool_result":
          return typeof value.output === "string";
        default:
          return false;
      }
    default:
      return false;
  }
}

function extractEvent(parsed: ParsedCodexSourceRecord):
  | {
      readonly kind: CanonicalEventKind;
      readonly text: string;
      readonly observedAt?: string;
      readonly recordKey?: string;
      readonly toolCallId?: string;
    }
  | undefined {
  if (parsed.origin === "session_index") return undefined;
  const value = parsed.value;
  if (parsed.origin === "history") {
    if (value.kind !== "evidence") return undefined;
    return {
      kind: "user_message",
      text: value.text,
      ...optionalFields(value),
    };
  }

  switch (value.kind) {
    case "message":
      return {
        kind: value.role === "user" ? "user_message" : "assistant_message",
        text: value.text,
        ...optionalFields(value),
      };
    case "tool_call":
      return {
        kind: "tool_call",
        text:
          value.input.length === 0
            ? `tool: ${value.toolName}`
            : `tool: ${value.toolName}\ninput: ${value.input}`,
        ...optionalFields(value),
        ...(value.toolCallId === undefined
          ? {}
          : { toolCallId: value.toolCallId }),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        text: value.output,
        ...optionalFields(value),
        ...(value.toolCallId === undefined
          ? {}
          : { toolCallId: value.toolCallId }),
      };
    case "session_meta":
    case "ignored":
      return undefined;
  }
}

function optionalFields(value: {
  readonly observedAt?: string;
  readonly recordKey?: string;
}): { readonly observedAt?: string; readonly recordKey?: string } {
  return {
    ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
    ...(value.recordKey === undefined ? {} : { recordKey: value.recordKey }),
  };
}

function redactionOptions(options: NormalizeCodexOptions): RedactionOptions {
  return {
    ...(options.maxInputCharacters === undefined
      ? {}
      : { maxInputCharacters: options.maxInputCharacters }),
    ...(options.maxMatches === undefined ? {} : { maxMatches: options.maxMatches }),
    ...(options.regexTimeoutMs === undefined
      ? {}
      : { regexTimeoutMs: options.regexTimeoutMs }),
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
