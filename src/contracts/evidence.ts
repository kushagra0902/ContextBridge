// Represents the final format of the info we try to get from the CODEX.
// two entities needed, one the smallest unit we get from the codex,
// ie the user message the assisstant message and any other info
// and the other being grouped events together maybe for one session or something

// Represents the final format of the info we try to get from the CODEX.
// two entities needed, one the smallest unit we get from the codex,
// ie the user message the assisstant message and any other info
// and the other being grouped events together maybe for one session or something

import type {
  ChunkId,
  EventId,
  ProjectId,
  SessionId,
  SourceId,
  WorkstreamId,
} from "./ids.js";

// The smallest unit of event
export type CanonicalEventKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result";

// defines from where the event came
export interface EvidenceSource {
  sourceId: SourceId;
  sourceOrdinal: number;
  byteStart?: number;
  byteEnd?: number;
  formatVersion: string;
}

// tells the reason why a particular info was omitted from the message
export interface RedactionSpan {
  start: number;
  end: number;
  reason: "secret" | "credential" | "user_rule" | "policy";
}

// Event description
export interface CanonicalEvent {
  id: EventId;
  sessionId: SessionId;
  ordinal: number; // number of the event
  kind: CanonicalEventKind;
  observedAt?: string;
  text: string;
  contentHash: string;
  EvidenceSource: EvidenceSource;
  redactions?: readonly RedactionSpan[];
  toolCallId?: string;
}

// specifies the reason for omission of specific chunks
export type OmissionReason =
  | "output_limit"
  | "repetitive_output"
  | "policy"
  | "unsupported_content";

// Marker of the omission chunks
export interface OmissionMarker {
  eventId: EventId;
  reason: OmissionReason;
  omittedCharacters?: number;
}

// Defines the scope of evidence, from where the evidence was collected
export interface EvidenceScope {
  sessionId: SessionId;
  projectId?: ProjectId;
  workstreamId?: WorkstreamId;
}

// Represents the combination of events together to form a single chunk
// gives opportunity for searching in combined manner.
export interface EvidenceChunk {
  id: ChunkId;
  sequence: number; // deterministic position within the session's derived chunk stream
  scope: EvidenceScope;
  eventIds: readonly EventId[];
  displayText: string; // raw display text of the EvidentChunk
  embeddingText: string; // tokens optimized or prepared for embedding. 
  tokenCount: number;
  fingerprint: string; // represents fingerprint of the chunk content or event membership etc
  omissions?: readonly OmissionMarker[];
  observedFrom?: string; // represents the time of latest and first evidences contained in this.
  observedTo?: string;
}




