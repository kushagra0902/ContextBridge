// The purpose of this file is to extract useful memory from the 

import type {
  ChunkId,
  EventId,
  MemoryId,
  ProjectId,
  SessionId,
  WorkstreamId,
} from "./ids.js";

// A source event or coherent chunk that supports a derived memory. In other words, ehat evidence or source supports that memory. 
export type MemoryEvidenceId = EventId | ChunkId;

export type MemoryType =
  | "session_synopsis"
  | "workstream_synopsis"
  | "project_synopsis"
  | "decision"
  | "episode"
  | "semantic_fact"
  | "open_item";

// Candidate records still require review or stronger extraction evidence.
// Superseded and resolved records remain searchable as historical memory.
// They provide temporal property to the memory.
 
export type MemoryStatus =
  | "candidate"
  | "tentative"
  | "active"
  | "conflicted"
  | "superseded"
  | "resolved"
  | "dismissed";

export type MemoryDerivation = "extractive" | "heuristic" | "model";

export interface MemoryScope {
  readonly projectId?: ProjectId;
  readonly workstreamId?: WorkstreamId;
  readonly sessionId?: SessionId;
}

export interface MemoryBase {
  readonly id: MemoryId;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly title: string;
  readonly body: string;
  readonly status: MemoryStatus;
  readonly evidenceIds: readonly MemoryEvidenceId[];
  readonly derivation: MemoryDerivation;
  readonly extractorVersion: string;
  readonly observedFrom?: string;
  readonly observedTo?: string;
  readonly derivedAt: string;
  readonly updatedAt: string;
  /** Older records that this record replaces. */
  readonly supersedes?: readonly MemoryId[];
  /** The newer record that made this record historical. */
  readonly supersededBy?: MemoryId;
}

export type SynopsisSectionName =
  | "goal"
  | "current_state"
  | "constraints"
  | "decisions"
  | "recent_changes"
  | "open_questions"
  | "important_entities"
  | "known_risks";

export interface SynopsisSection {
  readonly name: SynopsisSectionName;
  readonly text: string;
  readonly evidenceIds: readonly MemoryEvidenceId[];
}

export interface SessionSynopsisMemory extends MemoryBase {
  readonly type: "session_synopsis";
  readonly scope: MemoryScope & { readonly sessionId: SessionId }; // scope is defined by the memory scope along with the session ID.
  readonly sections: readonly SynopsisSection[]; // the complete synopsis memory has a well defined synopsis section,
  // that actually has the synopsis of the intended scope. 
}

export interface WorkstreamSynopsisMemory extends MemoryBase {
  readonly type: "workstream_synopsis";
  readonly scope: MemoryScope & {
    readonly projectId: ProjectId;
    readonly workstreamId: WorkstreamId;
  };
  readonly sections: readonly SynopsisSection[];
}

export interface ProjectSynopsisMemory extends MemoryBase {
  readonly type: "project_synopsis";
  readonly scope: MemoryScope & { readonly projectId: ProjectId };
  readonly sections: readonly SynopsisSection[];
}

export type DecisionAlternativeOutcome =
  | "considered"
  | "rejected"
  | "deferred";

export interface DecisionAlternative {
  readonly name: string;
  readonly outcome: DecisionAlternativeOutcome;
  readonly reason?: string;
}

export interface DecisionMemory extends MemoryBase {
  readonly type: "decision";
  readonly decision: string;
  readonly rationale: string;
  readonly alternatives: readonly DecisionAlternative[];
  readonly constraints: readonly string[];
  readonly affectedEntities: readonly string[];
}

export type EpisodeStepKind =
  | "attempt"
  | "observation"
  | "error"
  | "hypothesis"
  | "result";

export interface EpisodeStep {
  readonly ordinal: number;
  readonly kind: EpisodeStepKind;
  readonly description: string;
  readonly evidenceIds: readonly MemoryEvidenceId[];
}

export interface EpisodeMemory extends MemoryBase {
  readonly type: "episode";
  readonly steps: readonly EpisodeStep[];
  readonly outcome?: string;
}

export interface SemanticFactMemory extends MemoryBase {
  readonly type: "semantic_fact";
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

export type OpenItemKind =
  | "todo"
  | "question"
  | "risk"
  | "deferred_decision"
  | "follow_up";

export interface OpenItemMemory extends MemoryBase {
  readonly type: "open_item";
  readonly itemKind: OpenItemKind;
  readonly dueAt?: string;
  readonly resolvedBy?: MemoryId;
}

export type MemoryRecord =
  | SessionSynopsisMemory
  | WorkstreamSynopsisMemory
  | ProjectSynopsisMemory
  | DecisionMemory
  | EpisodeMemory
  | SemanticFactMemory
  | OpenItemMemory;

const MEMORY_TYPES: ReadonlySet<string> = new Set<MemoryType>([
  "session_synopsis",
  "workstream_synopsis",
  "project_synopsis",
  "decision",
  "episode",
  "semantic_fact",
  "open_item",
]);

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && MEMORY_TYPES.has(value);
}

export function isTerminalMemoryStatus(status: MemoryStatus): boolean {
  return status === "superseded" || status === "resolved" || status === "dismissed";
}

/**
 * Returns all evidence IDs used by a memory, including section/step evidence,
 * without changing their first-seen order.
 */
export function collectMemoryEvidenceIds(
  memory: MemoryRecord,
): readonly MemoryEvidenceId[] {
  const evidenceIds: MemoryEvidenceId[] = [...memory.evidenceIds];

  if (
    memory.type === "session_synopsis" ||
    memory.type === "workstream_synopsis" ||
    memory.type === "project_synopsis"
  ) {
    for (const section of memory.sections) {
      evidenceIds.push(...section.evidenceIds);
    }
  } else if (memory.type === "episode") {
    for (const step of memory.steps) {
      evidenceIds.push(...step.evidenceIds);
    }
  }

  return [...new Set(evidenceIds)];
}
