import { createHash } from "node:crypto";

import type { MemoryRecord, MemoryType } from "../contracts/memory.js";
import type {
  EvidenceRepository,
  LexicalSearchRepository,
  MemoryRepository,
} from "../contracts/ports.js";
import type {
  RankedCandidate,
  SearchFilters,
  SearchIntent,
  SearchScope,
} from "../contracts/search.js";
import { scopeContains } from "../contracts/scope.js";
import { normalizeRetrievalQuery } from "./intent.js";

export interface LexicalRetrievalDependencies {
  readonly lexicalSearch: LexicalSearchRepository;
  readonly memories?: MemoryRepository;
  readonly evidence?: EvidenceRepository;
}

export interface LexicalRetrievalInput {
  readonly query: string;
  readonly intent: SearchIntent;
  readonly scope: SearchScope;
  readonly filters?: Omit<SearchFilters, "scope">;
  readonly limit?: number;
}

/** Combines authoritative FTS/exact results with bounded structured and recent rows. */
export async function retrieveLexical(
  input: LexicalRetrievalInput,
  dependencies: LexicalRetrievalDependencies,
): Promise<readonly RankedCandidate[]> {
  const query = normalizeRetrievalQuery(input.query);
  const limit = boundedLimit(input.limit ?? 50);
  const filters: SearchFilters = { ...input.filters, scope: input.scope };
  const lexical = await dependencies.lexicalSearch.search(query, filters, limit);
  const branches: RankedCandidate[][] = [lexical.slice()];

  if (dependencies.memories !== undefined) {
    const types = structuredTypes(input.intent, filters.memoryTypes);
    if (types !== undefined) {
      const memories = await dependencies.memories.findByScope(input.scope, types);
      branches.push(
        memories
          .filter((memory) => memoryIsWithin(memory, input.scope))
          .slice(0, limit)
          .map((memory, index) => memoryCandidate(memory, index + 1)),
      );
    }
  }

  if (
    dependencies.evidence !== undefined &&
    input.scope.sessionId !== undefined &&
    usesRecent(input.intent)
  ) {
    const chunks = await dependencies.evidence.listSessionChunks(input.scope.sessionId, limit);
    const recent = chunks
      .filter((chunk) => chunk.scope.projectId !== undefined && scopeContains(input.scope, {
        projectId: chunk.scope.projectId,
        ...(chunk.scope.workstreamId === undefined ? {} : { workstreamId: chunk.scope.workstreamId }),
        sessionId: chunk.scope.sessionId,
      }))
      .slice()
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, Math.min(limit, 10))
      .map<RankedCandidate>((chunk, index) => ({
        entity: { kind: "chunk", id: chunk.id },
        scope: {
          projectId: chunk.scope.projectId!,
          ...(chunk.scope.workstreamId === undefined ? {} : { workstreamId: chunk.scope.workstreamId }),
          sessionId: chunk.scope.sessionId,
        },
        channel: "recent",
        rank: index + 1,
        fingerprint: chunk.fingerprint,
      }));
    branches.push(recent);
  }

  return interleaveUnique(branches, limit);
}

function usesRecent(intent: SearchIntent): boolean {
  return intent === "latest_state" || intent === "chronology" || intent === "debugging_history";
}

function structuredTypes(
  intent: SearchIntent,
  requested: readonly MemoryType[] | undefined,
): readonly MemoryType[] | undefined {
  if (requested !== undefined) return requested;
  switch (intent) {
    case "decision_rationale": return ["decision"];
    case "debugging_history": return ["episode"];
    case "open_items": return ["open_item"];
    case "latest_state": return ["session_synopsis", "workstream_synopsis", "project_synopsis", "decision", "open_item"];
    case "chronology": return ["decision", "episode"];
    case "broad_synthesis": return ["session_synopsis", "workstream_synopsis", "project_synopsis"];
    case "exact_identifier":
    case "exact_error":
    case "general":
      return undefined;
  }
}

function memoryCandidate(memory: MemoryRecord, rank: number): RankedCandidate {
  return {
    entity: { kind: "memory", id: memory.id },
    scope: {
      projectId: memory.scope.projectId!,
      ...(memory.scope.workstreamId === undefined ? {} : { workstreamId: memory.scope.workstreamId }),
      ...(memory.scope.sessionId === undefined ? {} : { sessionId: memory.scope.sessionId }),
    },
    channel: "structured",
    rank,
    fingerprint: createHash("sha256")
      .update(memory.title).update("\0").update(memory.body).update("\0")
      .update(memory.extractorVersion).digest("hex"),
  };
}

function memoryIsWithin(memory: MemoryRecord, boundary: SearchScope): boolean {
  return memory.scope.projectId !== undefined && scopeContains(boundary, {
    projectId: memory.scope.projectId,
    ...(memory.scope.workstreamId === undefined ? {} : { workstreamId: memory.scope.workstreamId }),
    ...(memory.scope.sessionId === undefined ? {} : { sessionId: memory.scope.sessionId }),
  });
}

function interleaveUnique(
  branches: readonly (readonly RankedCandidate[])[],
  limit: number,
): readonly RankedCandidate[] {
  const output: RankedCandidate[] = [];
  const seen = new Set<string>();
  const maximum = Math.max(0, ...branches.map((branch) => branch.length));
  for (let index = 0; index < maximum && output.length < limit; index += 1) {
    for (const branch of branches) {
      const candidate = branch[index];
      if (candidate === undefined) continue;
      const key = `${candidate.entity.kind}\0${candidate.entity.id}\0${candidate.channel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(candidate);
      if (output.length === limit) break;
    }
  }
  return output;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RangeError("Lexical retrieval limit must be from 1 to 1000");
  }
  return value;
}
