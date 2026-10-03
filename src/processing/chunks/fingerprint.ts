import { createHash } from "node:crypto";

import type { EventId } from "../../contracts/ids.js";
import { encodeParts } from "../../contracts/ids.js";

export interface ChunkFingerprintInput {
  readonly embeddingText: string;
  readonly eventIds: readonly EventId[];
  readonly chunkerVersion: string;
  readonly redactionVersion: string;
}

export function fingerprintChunk(input: ChunkFingerprintInput): string {
  if (input.chunkerVersion.length === 0 || input.redactionVersion.length === 0) {
    throw new TypeError("Chunk and redaction versions must not be empty");
  }
  return createHash("sha256")
    .update(encodeParts([
      input.embeddingText,
      ...input.eventIds,
      input.chunkerVersion,
      input.redactionVersion,
    ]))
    .digest("hex");
}
