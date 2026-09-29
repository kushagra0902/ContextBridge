// This is for mapping the Codex token or event or context format 
// to the custom contracts set up in evidence.ts.
// This ensures that even if the GPTs own format changes, 
// changes are not req anywhere else in the codebase

import type {
  SourceId,
} from "./ids.js";

import type {
  CanonicalEvent,
} from "./evidence.js";

// mentions the names and kind of sources currently there. 
export type SourceKind =
  | "codex_rollout"
  | "codex_history"
  | "codex_session_index";

// identity of the source file that is being used.
// a simple path cannot be used as the file being pointed by the path may change over time
export interface FileIdentity {
  readonly device?: string; // optional device id if that can be extracted. Helpful for future if multidevice done later. 
  readonly inode?: string; // inode or index node is the data structure used in os to save info about files
  // it is unique identifier of any file
  readonly size: number;
  readonly modifiedAtMs: number;
}

// Actual Source reference that is used. 
export interface SourceRef {
  readonly id: SourceId;

  readonly kind: SourceKind;

  readonly normalizedPath: string;

  readonly formatVersion: string;

  readonly fileIdentity: FileIdentity;
}

// The cursor represnets the position in the source we are at currently in the source.
// everything upto the cursor is already done and committed, not just read.
export interface SourceCursor {
  readonly sourceId: SourceId;
  readonly fileFingerprint: string;
  readonly committedByteOffset: number;
  readonly lastCompleteLineHash?: string; // this is for checking the file in case the model truncated the file, edited the file or changed the content of the same file. Then the whole file needs re parsing. 
}

export type SourceReadDiagnosticCode =
  | "MALFORMED_JSON"
  | "INVALID_RECORD"
  | "INVALID_UTF8"
  | "OVERSIZED_RECORD"
  | "CURSOR_RESET_ROTATED"
  | "CURSOR_RESET_TRUNCATED"
  | "CURSOR_RESET_MISMATCH";

/** Safe read diagnostics never contain the source line or transcript text. */
export interface SourceReadDiagnostic {
  readonly code: SourceReadDiagnosticCode;
  readonly byteStart: number;
  readonly byteEnd: number;
}

/**
 * Limits how much a source adapter may read during one batch.
 *
 * This prevents extremely large source files from monopolizing
 * the ingestion process.
 */
export interface ReadLimit {
  readonly maxBytes: number;
  readonly maxRecords: number;
}

// intermediate representation of the record. 
// the payload is unknown and the sources normlaisation function will decide 
// its shape
export interface SourceRecord {
  readonly sourceId: SourceId;

  readonly ordinal: number; // pos of record within the source

  // byte offsets for incremental and gradual reading
  readonly byteStart: number;
  readonly byteEnd: number;

  // format specific record type detected by the parser.
  readonly recordType: string;

  // the normalize func parses makes the row, column acc to format
  readonly payload: unknown;
}

// result of one batched read of records. 
export interface SourceBatch {
  readonly source: SourceRef;

  readonly records: readonly SourceRecord[];

  readonly diagnostics: readonly SourceReadDiagnostic[];

  // the cursor updated to; if the batch is successfully committed. Not just read
  readonly proposedCursor: SourceCursor;

  // Whether more complete records were available beyond this batch.
  readonly hasMore: boolean;
}

/**
 * Configuration passed to source discovery.
 *
 * This is deliberately generic. More detailed Codex configuration
 * belongs under src/config or src/sources/codex.
 */
export interface SourceConfig {
  readonly roots: readonly string[];

  readonly includeHistory: boolean;

  readonly includeSessionIndex: boolean;
}

// any codex adapter will provide these functions/contracts
export interface SourceAdapter {

    // find approved sources
  discover(
    config: SourceConfig,
  ): Promise<readonly SourceRef[]>;

  /**
   * Read a bounded set of complete source records starting from
   * a previously committed cursor.
   */
  readBatch(
    source: SourceRef,
    cursor: SourceCursor | undefined,
    limit: ReadLimit,
  ): Promise<SourceBatch>;

  /**
   * Convert one source-specific record into zero or more canonical
   * events.
   *
   * Zero events is valid when the record is intentionally ignored,
   * such as internal reasoning or unsupported metadata.
   */
  normalize(record: SourceRecord): Promise<readonly CanonicalEvent[]>;
}
