// Simply commits the data to the database
// Ports let us have abstraction over db without need to know internals. 

import type {
  CommitResult,
  EvidenceRepository,
} from "../contracts/ports.js";
import type { IngestScan } from "./scan.js";

/** Commits canonical events and their cursor through the storage transaction. */
export function commitIngestBatch(
  evidence: EvidenceRepository,
  scan: IngestScan,
): Promise<CommitResult> {
  return evidence.commitBatch(
    { source: scan.source, events: scan.events },
    scan.proposedCursor,
    { cursorMode: scan.cursorMode },
  );
}
