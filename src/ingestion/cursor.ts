// Defines valid cursor movement scopes. Bakcward movement only allowed 
// when we are in replay mode. 

import type { SourceCursor, SourceReadDiagnostic } from "../contracts/source.js";

export type IngestCursorMode = "append" | "replay";

export type CursorTransition =
  | { readonly allowed: true; readonly mode: IngestCursorMode }
  | {
      readonly allowed: false;
      readonly reason: "source_mismatch" | "unexplained_backward_move";
    };

/**
 * Converts reader continuity diagnostics into an explicit storage decision.
 * SQLite only permits a backwards move when this function identifies a
 * reader-verified replay.
 */
export function decideCursorTransition(
  previous: SourceCursor | undefined,
  proposed: SourceCursor,
  diagnostics: readonly SourceReadDiagnostic[],
): CursorTransition {
  if (previous !== undefined && previous.sourceId !== proposed.sourceId) {
    return { allowed: false, reason: "source_mismatch" };
  }

  const replay = diagnostics.some((diagnostic) =>
    diagnostic.code.startsWith("CURSOR_RESET_"),
  );
  if (
    previous !== undefined &&
    proposed.committedByteOffset < previous.committedByteOffset &&
    !replay
  ) {
    return { allowed: false, reason: "unexplained_backward_move" };
  }
  return { allowed: true, mode: replay ? "replay" : "append" };
}
