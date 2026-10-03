// This file implements safely parsing and readig the codex session files,
// it keeps track of the cursor, changes in the file, reading only valid 
// non corrupted strings from the sessions data saved by codex. 

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { platform as currentPlatform } from "node:os";

import type {
  FileIdentity,
  SourceCursor,
  SourceReadDiagnostic,
  SourceReadDiagnosticCode,
} from "../../contracts/source.js";

import {
  fileIdentityFromStats,
  sourceFingerprint,
} from "./identity.js";

export interface CompleteSourceLine {
  readonly text: string;
  readonly byteStart: number;
  /** Offset immediately after the terminating newline. */
  readonly byteEnd: number;
  readonly hash: string;
}

export interface CompleteLineReadResult {
  readonly lines: readonly CompleteSourceLine[];
  readonly diagnostics: readonly SourceReadDiagnostic[];
  readonly fileIdentity: FileIdentity;
  readonly fileFingerprint: string;
  readonly nextByteOffset: number;
  readonly lastCompleteLineHash?: string;
  readonly hasMore: boolean;
  readonly pendingPartialLine: boolean;
}

export class CodexSourceReadError extends Error {
  readonly code:
    | "INVALID_LIMIT"
    | "NOT_REGULAR_FILE"
    | "SYMBOLIC_LINK"
    | "RECORD_SCAN_LIMIT";

  constructor(code: CodexSourceReadError["code"], message: string) {
    super(message);
    this.name = "CodexSourceReadError";
    this.code = code;
  }
}

const MAX_READ_BYTES = 64 * 1_024 * 1_024;
const MAX_LINES = 10_000;
const OVERSIZED_LINE_SCAN_BYTES = 16 * 1_024 * 1_024;
// A line accepted by skipOversizedLine must also be fully hashable when the
// next batch validates its cursor. Keeping these limits identical prevents a
// valid oversized-line cursor from being falsely reset to byte zero.
const CURSOR_VALIDATION_BYTES = OVERSIZED_LINE_SCAN_BYTES;
const SCAN_CHUNK_BYTES = 64 * 1_024;

/**
 * Reads newline-terminated records only. A trailing partial line stays behind
 * the proposed cursor and becomes visible after a later append completes it.
 */
export async function readCompleteLines(
  path: string,
  cursor: SourceCursor | undefined,
  maxBytes: number,
  maxLines = MAX_LINES,
): Promise<CompleteLineReadResult> {
  validateLimits(maxBytes, maxLines);

  let handle;
  try {
    handle = await open(
      path,
      currentPlatform() === "win32"
        ? "r"
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (getErrorCode(error) === "ELOOP") {
      throw new CodexSourceReadError(
        "SYMBOLIC_LINK",
        "Codex source must not be a symbolic link",
      );
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new CodexSourceReadError(
        "NOT_REGULAR_FILE",
        "Codex source must be a regular file",
      );
    }

    const fileIdentity = fileIdentityFromStats(stats);
    const fileFingerprint = sourceFingerprint(path, fileIdentity);
    const diagnostics: SourceReadDiagnostic[] = [];
    let offset = cursor?.committedByteOffset ?? 0;
    let lastCompleteLineHash = cursor?.lastCompleteLineHash;

    if (cursor !== undefined && cursor.fileFingerprint !== fileFingerprint) {
      diagnostics.push(cursorResetDiagnostic("CURSOR_RESET_ROTATED", offset));
      offset = 0;
      lastCompleteLineHash = undefined;
    } else if (offset > fileIdentity.size) {
      diagnostics.push(cursorResetDiagnostic("CURSOR_RESET_TRUNCATED", offset));
      offset = 0;
      lastCompleteLineHash = undefined;
    } else if (offset > 0 && lastCompleteLineHash !== undefined) {
      const actualHash = await hashPreviousCompleteLine(handle, offset);
      if (actualHash === undefined || actualHash !== lastCompleteLineHash) {
        diagnostics.push(cursorResetDiagnostic("CURSOR_RESET_MISMATCH", offset));
        offset = 0;
        lastCompleteLineHash = undefined;
      }
    }

    if (offset === fileIdentity.size) {
      return {
        lines: [],
        diagnostics,
        fileIdentity,
        fileFingerprint,
        nextByteOffset: offset,
        ...(lastCompleteLineHash === undefined ? {} : { lastCompleteLineHash }),
        hasMore: false,
        pendingPartialLine: false,
      };
    }

    const bytesToRead = Math.min(maxBytes, fileIdentity.size - offset);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    const data = buffer.subarray(0, bytesRead);
    const lineBreaks = newlineOffsets(data, maxLines);

    if (lineBreaks.length === 0) {
      if (offset + bytesRead >= fileIdentity.size) {
        return {
          lines: [],
          diagnostics,
          fileIdentity,
          fileFingerprint,
          nextByteOffset: offset,
          ...(lastCompleteLineHash === undefined ? {} : { lastCompleteLineHash }),
          hasMore: false,
          pendingPartialLine: bytesRead > 0,
        };
      }

      const skipped = await skipOversizedLine(handle, offset, data);
      if (!skipped.complete) {
        return {
          lines: [],
          diagnostics,
          fileIdentity,
          fileFingerprint,
          nextByteOffset: offset,
          ...(lastCompleteLineHash === undefined ? {} : { lastCompleteLineHash }),
          hasMore: false,
          pendingPartialLine: true,
        };
      }
      diagnostics.push({
        code: "OVERSIZED_RECORD",
        byteStart: offset,
        byteEnd: skipped.byteEnd,
      });
      return {
        lines: [],
        diagnostics,
        fileIdentity,
        fileFingerprint,
        nextByteOffset: skipped.byteEnd,
        lastCompleteLineHash: skipped.hash,
        hasMore: skipped.byteEnd < fileIdentity.size,
        pendingPartialLine: false,
      };
    }

    const lines: CompleteSourceLine[] = [];
    let lineStart = 0;
    let nextByteOffset = offset;
    for (const newlineOffset of lineBreaks) {
      const rawLine = data.subarray(lineStart, newlineOffset);
      const byteStart = offset + lineStart;
      const byteEnd = offset + newlineOffset + 1;
      const hash = hashLine(rawLine);
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawLine);
        lines.push({
          text: decoded.endsWith("\r") ? decoded.slice(0, -1) : decoded,
          byteStart,
          byteEnd,
          hash,
        });
      } catch {
        diagnostics.push({ code: "INVALID_UTF8", byteStart, byteEnd });
      }
      lastCompleteLineHash = hash;
      nextByteOffset = byteEnd;
      lineStart = newlineOffset + 1;
    }

    const reachedPhysicalEnd = offset + bytesRead >= fileIdentity.size;
    const reachedRecordLimit =
      lineBreaks.length === maxLines && nextByteOffset < offset + bytesRead;
    const pendingPartialLine =
      reachedPhysicalEnd &&
      nextByteOffset < fileIdentity.size &&
      !reachedRecordLimit;
    return {
      lines,
      diagnostics,
      fileIdentity,
      fileFingerprint,
      nextByteOffset,
      ...(lastCompleteLineHash === undefined ? {} : { lastCompleteLineHash }),
      hasMore:
        reachedRecordLimit ||
        (!pendingPartialLine && nextByteOffset < fileIdentity.size),
      pendingPartialLine,
    };
  } finally {
    await handle.close();
  }
}

function newlineOffsets(data: Buffer, maxLines: number): number[] {
  const offsets: number[] = [];
  let index = -1;
  while (offsets.length < maxLines) {
    index = data.indexOf(0x0a, index + 1);
    if (index === -1) break;
    offsets.push(index);
  }
  return offsets;
}

async function skipOversizedLine(
  handle: Awaited<ReturnType<typeof open>>,
  byteStart: number,
  initial: Buffer,
): Promise<
  | { readonly complete: true; readonly byteEnd: number; readonly hash: string }
  | { readonly complete: false }
> {
  const hash = createHash("sha256");
  hash.update(initial);
  let position = byteStart + initial.length;
  let scanned = initial.length;

  while (scanned < OVERSIZED_LINE_SCAN_BYTES) {
    const buffer = Buffer.allocUnsafe(
      Math.min(SCAN_CHUNK_BYTES, OVERSIZED_LINE_SCAN_BYTES - scanned),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return { complete: false };
    }
    const chunk = buffer.subarray(0, bytesRead);
    const newline = chunk.indexOf(0x0a);
    if (newline !== -1) {
      hash.update(chunk.subarray(0, newline));
      return {
        complete: true,
        byteEnd: position + newline + 1,
        hash: hash.digest("hex"),
      };
    }
    hash.update(chunk);
    position += bytesRead;
    scanned += bytesRead;
  }

  throw new CodexSourceReadError(
    "RECORD_SCAN_LIMIT",
    "Codex record exceeds the safe scan limit",
  );
}

async function hashPreviousCompleteLine(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
): Promise<string | undefined> {
  if (offset < 1) return undefined;
  const ending = Buffer.allocUnsafe(1);
  const endingRead = await handle.read(ending, 0, 1, offset - 1);
  if (endingRead.bytesRead !== 1 || ending[0] !== 0x0a) return undefined;

  const start = Math.max(0, offset - 1 - CURSOR_VALIDATION_BYTES);
  const length = offset - 1 - start;
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  const data = buffer.subarray(0, bytesRead);
  const previousNewline = data.lastIndexOf(0x0a);
  if (previousNewline === -1 && start > 0) return undefined;
  return hashLine(data.subarray(previousNewline + 1));
}

function hashLine(line: Buffer): string {
  return createHash("sha256").update(line).digest("hex");
}

function cursorResetDiagnostic(
  code: Extract<SourceReadDiagnosticCode, `CURSOR_RESET_${string}`>,
  previousOffset: number,
): SourceReadDiagnostic {
  return { code, byteStart: 0, byteEnd: previousOffset };
}

function validateLimits(maxBytes: number, maxLines: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_READ_BYTES ||
    !Number.isSafeInteger(maxLines) ||
    maxLines < 1 ||
    maxLines > MAX_LINES
  ) {
    throw new CodexSourceReadError("INVALID_LIMIT", "Invalid source read limits");
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
