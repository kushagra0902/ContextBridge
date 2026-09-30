// This is the complete adapter file that orchestrates all the files of the codex parsing 
// into a complete pipeline. 

import type { CanonicalEvent } from "../../contracts/evidence.js";

import type {
  ReadLimit,
  SourceAdapter,
  SourceBatch,
  SourceConfig,
  SourceReadDiagnostic,
  SourceRecord,
  SourceRef,
} from "../../contracts/source.js";

import type { UserRedactionRule } from "../../security/redact.js";

import {
  discoverCodexSources,
  type CodexDiscoveryDiagnostic,
} from "./discover.js";

import { parseHistoryLine } from "./history-parser.js";
import { sourceSessionId } from "./identity.js";

import {
  normalizeCodexRecord,
  isCodexSourcePayload,
  type CodexSourcePayload,
  type NormalizeCodexOptions,
  type ParsedCodexSourceRecord,
} from "./normalize.js";

import { readCompleteLines } from "./rollout-reader.js";
import { parseRolloutLine } from "./rollout-parser.js";
import { parseSessionIndexLine } from "./session-index.js";

export interface CodexSourceAdapterOptions {
  readonly excludedRoots?: readonly string[];
  readonly redactionRules?: readonly UserRedactionRule[];
  readonly maxNormalizedTextCharacters?: number;
}


export class CodexSourceAdapter implements SourceAdapter {
  private readonly excludedRoots: readonly string[];
  private readonly normalizeOptions: NormalizeCodexOptions;
  private readonly sessionIds = new Map<string, ReturnType<typeof sourceSessionId>>();
  private readonly recentEvents = new Map<
    string,
    { readonly ordinal: number; readonly variant: "response_item" | "event_msg" }
  >();
  private discoveryDiagnostics: readonly CodexDiscoveryDiagnostic[] = [];

  constructor(options: CodexSourceAdapterOptions = {}) {
    this.excludedRoots = options.excludedRoots ?? [];
    this.normalizeOptions = {
      ...(options.redactionRules === undefined
        ? {}
        : { redactionRules: options.redactionRules }),
      ...(options.maxNormalizedTextCharacters === undefined
        ? {}
        : { maxTextCharacters: options.maxNormalizedTextCharacters }),
    };
  }

  async discover(config: SourceConfig): Promise<readonly SourceRef[]> {
    const result = await discoverCodexSources(config.roots, {
      includeHistory: config.includeHistory,
      includeSessionIndex: config.includeSessionIndex,
      excludedRoots: this.excludedRoots,
    });
    this.discoveryDiagnostics = result.diagnostics;
    for (const source of result.sources) {
      this.sessionIds.set(source.id, sourceSessionId(source));
    }
    return result.sources;
  }

  getDiscoveryDiagnostics(): readonly CodexDiscoveryDiagnostic[] {
    return this.discoveryDiagnostics;
  }

  async readBatch(
    source: SourceRef,
    cursor: Parameters<SourceAdapter["readBatch"]>[1],
    limit: ReadLimit,
  ): Promise<SourceBatch> {
    if (cursor !== undefined && cursor.sourceId !== source.id) {
      throw new TypeError("Source cursor belongs to a different source");
    }

    const read = await readCompleteLines(
      source.normalizedPath,
      cursor,
      limit.maxBytes,
      limit.maxRecords,
    );
    const records: SourceRecord[] = [];
    const diagnostics: SourceReadDiagnostic[] = [...read.diagnostics];
    const cursorWasReset = read.diagnostics.some((diagnostic) =>
      diagnostic.code.startsWith("CURSOR_RESET_"),
    );
    let sessionId = cursorWasReset
      ? sourceSessionId(source)
      : (this.sessionIds.get(source.id) ?? sourceSessionId(source));
    if (cursorWasReset) this.sessionIds.set(source.id, sessionId);

    for (const line of read.lines) {
      const parsed = parseSourceLine(source, line.text);
      if (!parsed.ok) {
        diagnostics.push({
          code: parsed.malformedJson ? "MALFORMED_JSON" : "INVALID_RECORD",
          byteStart: line.byteStart,
          byteEnd: line.byteEnd,
        });
        continue;
      }

      if (
        parsed.value.origin === "rollout" &&
        parsed.value.value.kind === "session_meta" &&
        parsed.value.value.sessionKey !== undefined
      ) {
        sessionId = sourceSessionId(source, parsed.value.value.sessionKey);
        this.sessionIds.set(source.id, sessionId);
      } else if (
        parsed.value.origin === "history" &&
        parsed.value.value.sessionKey !== undefined
      ) {
        sessionId = sourceSessionId(source, parsed.value.value.sessionKey);
      } else if (parsed.value.origin === "session_index") {
        sessionId = sourceSessionId(source, parsed.value.value.sessionKey);
      }

      if (
        parsed.value.origin === "rollout" &&
        parsed.value.value.kind === "ignored"
      ) {
        continue;
      }

      const payload: CodexSourcePayload = {
        schemaVersion: 1,
        sourceKind: source.kind,
        formatVersion: source.formatVersion,
        sessionId,
        parsed: parsed.value,
      };
      records.push({
        sourceId: source.id,
        ordinal: sourceOrdinal(parsed.value, line.byteStart),
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
        recordType: recordType(parsed.value),
        payload,
      });
    }

    const updatedSource: SourceRef = {
      ...source,
      fileIdentity: read.fileIdentity,
    };
    return {
      source: updatedSource,
      records,
      diagnostics,
      proposedCursor: {
        sourceId: source.id,
        fileFingerprint: read.fileFingerprint,
        committedByteOffset: read.nextByteOffset,
        ...(read.lastCompleteLineHash === undefined
          ? {}
          : { lastCompleteLineHash: read.lastCompleteLineHash }),
      },
      hasMore: read.hasMore,
    };
  }

  async normalize(record: SourceRecord): Promise<readonly CanonicalEvent[]> {
    const events = await normalizeCodexRecord(record, this.normalizeOptions);
    const variant = messageVariant(record);
    const accepted: CanonicalEvent[] = [];
    for (const event of events) {
      if (variant === undefined) {
        accepted.push(event);
        continue;
      }
      const key = mirrorFingerprint(event);
      const previous = this.recentEvents.get(key);
      if (
        previous !== undefined &&
        previous.variant !== variant &&
        Math.abs(previous.ordinal - event.ordinal) <= 8
      ) {
        continue;
      }
      this.recentEvents.set(key, { ordinal: event.ordinal, variant });
      accepted.push(event);
    }
    trimMap(this.recentEvents, 10_000);
    return accepted;
  }
}

type ParsedLineResult =
  | { readonly ok: true; readonly value: ParsedCodexSourceRecord }
  | { readonly ok: false; readonly malformedJson: boolean };

function parseSourceLine(source: SourceRef, line: string): ParsedLineResult {
  switch (source.kind) {
    case "codex_rollout": {
      const parsed = parseRolloutLine(line, source.formatVersion);
      return parsed.ok
        ? { ok: true, value: { origin: "rollout", value: parsed.record } }
        : { ok: false, malformedJson: isMalformedJsonCode(parsed.code) };
    }
    case "codex_history": {
      const parsed = parseHistoryLine(line);
      return parsed.ok
        ? { ok: true, value: { origin: "history", value: parsed.record } }
        : { ok: false, malformedJson: isMalformedJsonCode(parsed.code) };
    }
    case "codex_session_index": {
      const parsed = parseSessionIndexLine(line);
      return parsed.ok
        ? { ok: true, value: { origin: "session_index", value: parsed.entry } }
        : { ok: false, malformedJson: isMalformedJsonCode(parsed.code) };
    }
  }
}

function isMalformedJsonCode(code: string): boolean {
  return code === "INVALID_JSON" || code === "EMPTY_LINE";
}

function sourceOrdinal(parsed: ParsedCodexSourceRecord, fallback: number): number {
  return parsed.origin === "rollout" && parsed.value.sourceOrdinal !== undefined
    ? parsed.value.sourceOrdinal
    : fallback;
}

function recordType(parsed: ParsedCodexSourceRecord): string {
  return parsed.origin === "rollout"
    ? parsed.value.kind
    : parsed.origin === "history"
      ? `history_${parsed.value.kind}`
      : "session_index";
}

function mirrorFingerprint(event: CanonicalEvent): string {
  const observedSecond = event.observedAt?.slice(0, 19) ?? "undated";
  return [
    event.sessionId,
    event.kind,
    event.toolCallId ?? "",
    event.contentHash,
    observedSecond,
  ].join(":");
}

function messageVariant(
  record: SourceRecord,
): "response_item" | "event_msg" | undefined {
  const payload = record.payload;
  if (
    !isCodexSourcePayload(payload) ||
    payload.parsed.origin !== "rollout" ||
    payload.parsed.value.kind !== "message" ||
    (payload.parsed.value.variant !== "response_item" &&
      payload.parsed.value.variant !== "event_msg")
  ) {
    return undefined;
  }
  return payload.parsed.value.variant;
}

function trimMap<Key, Value>(map: Map<Key, Value>, maximum: number): void {
  while (map.size > maximum) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}
