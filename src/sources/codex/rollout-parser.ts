// This file gives the format and interfaces and the codex specific represnetation
// produced while parsing the raw JSONL.
// These are specific to CODEX specification and types.

// Once parsed, these data will be saved as the data types defined in the contracts.

export type CodexMessageRole = "user" | "assistant";

// The base class of different data structures used to parse codex data
interface ParsedRecordBase {
  readonly sourceOrdinal?: number;
  readonly observedAt?: string;
  readonly recordKey?: string;
}

// Data structure to parse Session meta data. 
export interface ParsedSessionMeta extends ParsedRecordBase {
  readonly kind: "session_meta";
  readonly sessionKey?: string;
  readonly cwd?: string;
  readonly git?: {
    readonly branch?: string;
    readonly commitHash?: string;
    readonly repositoryUrl?: string;
  };
}

// Interface to parse the message of codex, of both the roles. 
export interface ParsedMessage extends ParsedRecordBase {
  readonly kind: "message";
  readonly variant: "response_item" | "event_msg";
  readonly role: CodexMessageRole;
  readonly text: string;
  readonly unsupportedContentItems: number;
}

// Tool call parsing struct
export interface ParsedToolCall extends ParsedRecordBase {
  readonly kind: "tool_call";
  readonly toolName: string;
  readonly input: string;
  readonly toolCallId?: string;
}

export interface ParsedToolResult extends ParsedRecordBase {
  readonly kind: "tool_result";
  readonly output: string;
  readonly toolCallId?: string;
}

export interface ParsedIgnoredRecord extends ParsedRecordBase {
  readonly kind: "ignored";
  readonly reason:
    | "internal_record"
    | "forbidden_role"
    | "mirror_record"
    | "unsupported_record"
    | "unsupported_content";
}

export type ParsedRolloutRecord =
  | ParsedSessionMeta
  | ParsedMessage
  | ParsedToolCall
  | ParsedToolResult
  | ParsedIgnoredRecord;

export type RolloutParseErrorCode =
  | "EMPTY_LINE"
  | "LINE_TOO_LONG"
  | "INVALID_JSON"
  | "INVALID_ROOT"
  | "INVALID_RECORD";

export type RolloutParseResult =
  | { readonly ok: true; readonly record: ParsedRolloutRecord }
  | { readonly ok: false; readonly code: RolloutParseErrorCode };

const MAX_LINE_CHARACTERS = 4 * 1_024 * 1_024;
const MAX_TEXT_CHARACTERS = 2 * 1_024 * 1_024;
const MAX_IDENTIFIER_CHARACTERS = 512;

/** Parses only reviewed fields and never includes raw input in an error. */
export function parseRolloutLine(
  line: string,
  _formatVersion: string,
): RolloutParseResult {
  if (line.length === 0) return failure("EMPTY_LINE");
  if (line.length > MAX_LINE_CHARACTERS) return failure("LINE_TOO_LONG");

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return failure("INVALID_JSON");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return failure("INVALID_ROOT");
  }

  const base = parseBase(value);
  const payload = value.payload;
  if (!isRecord(payload)) {
    return failure("INVALID_RECORD");
  }

  switch (value.type) {
    case "session_meta":
      const git = parseGitMetadata(payload.git);
      return {
        ok: true,
        record: {
          kind: "session_meta",
          ...base,
          ...optionalProperty(
            "sessionKey",
            boundedIdentifier(payload.session_id) ?? boundedIdentifier(payload.id),
          ),
          ...optionalProperty("cwd", boundedString(payload.cwd, 4_096)),
          ...optionalProperty("git", git),
        },
      };
    case "response_item":
      return parseResponseItem(payload, base);
    case "event_msg":
      return parseEventMessage(payload, base);
    case "turn_context":
    case "token_usage_record":
    case "world_state":
      return ignored(base, "internal_record");
    default:
      return ignored(base, "unsupported_record");
  }
}

function parseGitMetadata(
  value: unknown,
): ParsedSessionMeta["git"] | undefined {
  if (!isRecord(value)) return undefined;
  const branch = boundedIdentifier(value.branch);
  const commitHash =
    typeof value.commit_hash === "string" &&
    /^[0-9a-f]{7,64}$/iu.test(value.commit_hash)
      ? value.commit_hash.toLowerCase()
      : undefined;
  const repositoryUrl = sanitizeRepositoryUrl(value.repository_url);
  if (
    branch === undefined &&
    commitHash === undefined &&
    repositoryUrl === undefined
  ) {
    return undefined;
  }
  return {
    ...optionalProperty("branch", branch),
    ...optionalProperty("commitHash", commitHash),
    ...optionalProperty("repositoryUrl", repositoryUrl),
  };
}

function sanitizeRepositoryUrl(value: unknown): string | undefined {
  const text = boundedString(value, 4_096);
  if (text === undefined) return undefined;
  const scp = text.includes("://")
    ? null
    : /^(?:[^@\s/:]+@)?([^\s/:]+):([^\s]+)$/u.exec(text);
  if (scp !== null && scp[1] !== undefined && scp[2] !== undefined) {
    return `${scp[1].toLowerCase()}:${scp[2]}`;
  }
  try {
    const url = new URL(text);
    if (
      !["https:", "http:", "ssh:", "git:"].includes(url.protocol) ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseResponseItem(
  payload: Record<string, unknown>,
  base: ParsedRecordBase,
): RolloutParseResult {
  switch (payload.type) {
    case "message": {
      if (payload.role !== "user" && payload.role !== "assistant") {
        return ignored(base, "forbidden_role");
      }
      const content = extractMessageContent(payload.content);
      if (content.text.length === 0) {
        return ignored(
          base,
          content.unsupportedItems > 0
            ? "unsupported_content"
            : "unsupported_record",
        );
      }
      return {
        ok: true,
        record: {
          kind: "message",
          variant: "response_item",
          ...base,
          ...optionalProperty("recordKey", boundedIdentifier(payload.id)),
          role: payload.role,
          text: content.text,
          unsupportedContentItems: content.unsupportedItems,
        },
      };
    }
    case "function_call":
    case "custom_tool_call": {
      const name = boundedIdentifier(payload.name) ?? boundedIdentifier(payload.tool);
      const input = serializeText(
        payload.type === "function_call" ? payload.arguments : payload.input,
      );
      if (name === undefined || input === undefined) {
        return failure("INVALID_RECORD");
      }
      const toolCallId = boundedIdentifier(payload.call_id);
      return {
        ok: true,
        record: {
          kind: "tool_call",
          ...base,
          ...optionalProperty(
            "recordKey",
            boundedIdentifier(payload.id) ?? toolCallId,
          ),
          toolName: name,
          input,
          ...optionalProperty("toolCallId", toolCallId),
        },
      };
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      if (!Object.hasOwn(payload, "output")) {
        return failure("INVALID_RECORD");
      }
      const output = serializeText(payload.output);
      if (output === undefined) return failure("INVALID_RECORD");
      const toolCallId = boundedIdentifier(payload.call_id);
      return {
        ok: true,
        record: {
          kind: "tool_result",
          ...base,
          ...optionalProperty(
            "recordKey",
            boundedIdentifier(payload.id) ?? toolCallId,
          ),
          output,
          ...optionalProperty("toolCallId", toolCallId),
        },
      };
    }
    case "web_search_call": {
      const input = serializeText(payload.action) ?? "";
      return {
        ok: true,
        record: {
          kind: "tool_call",
          ...base,
          ...optionalProperty("recordKey", boundedIdentifier(payload.id)),
          toolName: "web_search",
          input,
        },
      };
    }
    case "reasoning":
      return ignored(base, "internal_record");
    default:
      return ignored(base, "unsupported_record");
  }
}

function parseEventMessage(
  payload: Record<string, unknown>,
  base: ParsedRecordBase,
): RolloutParseResult {
  switch (payload.type) {
    case "user_message":
    case "agent_message": {
      const text =
        boundedString(payload.message, MAX_TEXT_CHARACTERS) ??
        boundedString(payload.text, MAX_TEXT_CHARACTERS);
      if (text === undefined || text.length === 0) {
        return failure("INVALID_RECORD");
      }
      return {
        ok: true,
        record: {
          kind: "message",
          variant: "event_msg",
          ...base,
          role: payload.type === "user_message" ? "user" : "assistant",
          text,
          unsupportedContentItems: 0,
        },
      };
    }
    case "item_completed":
      return ignored(base, "mirror_record");
    case "token_count":
    case "task_started":
    case "task_complete":
    case "thread_settings_applied":
      return ignored(base, "internal_record");
    default:
      return ignored(base, "unsupported_record");
  }
}

function extractMessageContent(value: unknown): {
  readonly text: string;
  readonly unsupportedItems: number;
} {
  if (typeof value === "string") {
    return {
      text: value.length <= MAX_TEXT_CHARACTERS ? value : "",
      unsupportedItems: value.length <= MAX_TEXT_CHARACTERS ? 0 : 1,
    };
  }
  if (!Array.isArray(value)) return { text: "", unsupportedItems: 0 };

  const parts: string[] = [];
  let total = 0;
  let unsupportedItems = 0;
  for (const item of value) {
    if (
      !isRecord(item) ||
      !["input_text", "output_text", "text", "Text"].includes(
        String(item.type),
      ) ||
      typeof item.text !== "string"
    ) {
      unsupportedItems += 1;
      continue;
    }
    total += item.text.length;
    if (total > MAX_TEXT_CHARACTERS) {
      unsupportedItems += 1;
      continue;
    }
    parts.push(item.text);
  }
  return { text: parts.join("\n"), unsupportedItems };
}

function parseBase(value: Record<string, unknown>): ParsedRecordBase {
  const ordinal =
    typeof value.ordinal === "number" &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 0
      ? value.ordinal
      : undefined;
  const observedAt = normalizeTimestamp(value.timestamp);
  return {
    ...optionalProperty("sourceOrdinal", ordinal),
    ...optionalProperty("observedAt", observedAt),
  };
}

export function normalizeTimestamp(value: unknown): string | undefined {
  let date: Date;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
  } else if (typeof value === "string" && value.length <= 128) {
    date = new Date(value);
  } else {
    return undefined;
  }
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function serializeText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length <= MAX_TEXT_CHARACTERS ? value : undefined;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    Array.isArray(value) ||
    isRecord(value)
  ) {
    try {
      const serialized = JSON.stringify(value);
      return serialized.length <= MAX_TEXT_CHARACTERS ? serialized : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function boundedString(
  value: unknown,
  maximum = MAX_IDENTIFIER_CHARACTERS,
): string | undefined {
  return typeof value === "string" &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedIdentifier(value: unknown): string | undefined {
  const text = boundedString(value);
  return text !== undefined && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : undefined;
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { readonly [K in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [K in Key]: Value });
}

function ignored(
  base: ParsedRecordBase,
  reason: ParsedIgnoredRecord["reason"],
): RolloutParseResult {
  return { ok: true, record: { kind: "ignored", ...base, reason } };
}

function failure(code: RolloutParseErrorCode): RolloutParseResult {
  return { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
