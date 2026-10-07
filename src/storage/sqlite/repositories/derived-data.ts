import { createHash } from "node:crypto";

import type {
  DerivedDataBatch,
  DerivedDataCommitResult,
  DerivedDataRepository,
} from "../../../contracts/ports.js";
import type { EvidenceChunk } from "../../../contracts/evidence.js";
import {
  collectMemoryEvidenceIds,
  type MemoryRecord,
} from "../../../contracts/memory.js";
import type { SqliteDatabase } from "../database.js";
import { stringifyJson } from "../database.js";
import type { StorageExecutor } from "../executor.js";
import { extractExactTerms, replaceExactTerms } from "../exact-terms.js";
import { withTransaction } from "../transaction.js";
import { enqueueEmbeddingJobs } from "./embedding-jobs.js";

export class SqliteDerivedDataRepository implements DerivedDataRepository {
  constructor(private readonly executor: StorageExecutor) {}

  commit(batch: DerivedDataBatch): Promise<DerivedDataCommitResult> {
    return this.executor.execute("derived.commit", batch);
  }
}

export function handleDerivedDataOperation(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  if (operation !== "derived.commit") {
    throw new Error(`Unknown derived-data repository operation: ${operation}`);
  }
  return commitDerivedData(database, argument as DerivedDataBatch);
}

export function commitDerivedData(
  database: SqliteDatabase,
  batch: DerivedDataBatch,
): DerivedDataCommitResult {
  return withTransaction(database, () => {
    let deletedChunks = 0;
    let deletedMemories = 0;

    for (const id of batch.deleteChunkIds) {
      database
        .prepare("DELETE FROM exact_terms WHERE entity_kind = 'chunk' AND entity_id = ?")
        .run(id);
      database
        .prepare("DELETE FROM search_content WHERE entity_kind = 'chunk' AND entity_id = ?")
        .run(id);
      deletedChunks += Number(
        database.prepare("DELETE FROM chunks WHERE chunk_id = ?").run(id).changes,
      );
    }
    for (const id of batch.deleteMemoryIds) {
      database
        .prepare("DELETE FROM exact_terms WHERE entity_kind = 'memory' AND entity_id = ?")
        .run(id);
      database
        .prepare("DELETE FROM search_content WHERE entity_kind = 'memory' AND entity_id = ?")
        .run(id);
      deletedMemories += Number(
        database.prepare("DELETE FROM memories WHERE memory_id = ?").run(id).changes,
      );
    }

    for (const chunk of batch.upsertChunks) {
      upsertChunk(database, chunk);
    }
    for (const memory of batch.upsertMemories) {
      upsertMemory(database, memory);
    }
    enqueueEmbeddingJobs(database, batch.embeddingJobs);

    return {
      upsertedChunks: batch.upsertChunks.length,
      deletedChunks,
      upsertedMemories: batch.upsertMemories.length,
      deletedMemories,
      enqueuedEmbeddingJobs: batch.embeddingJobs.length,
    };
  });
}

function upsertChunk(database: SqliteDatabase, chunk: EvidenceChunk): void {
  if (!Number.isSafeInteger(chunk.tokenCount) || chunk.tokenCount < 0) {
    throw new RangeError("Invalid chunk token count");
  }
  database
    .prepare(`
      INSERT INTO chunks(
        chunk_id, sequence, project_id, workstream_id, session_id, display_text,
        embedding_text, token_count, fingerprint, observed_from,
        observed_to, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        sequence = excluded.sequence,
        project_id = excluded.project_id,
        workstream_id = excluded.workstream_id,
        session_id = excluded.session_id,
        display_text = excluded.display_text,
        embedding_text = excluded.embedding_text,
        token_count = excluded.token_count,
        fingerprint = excluded.fingerprint,
        observed_from = excluded.observed_from,
        observed_to = excluded.observed_to,
        record_json = excluded.record_json
    `)
    .run(
      chunk.id,
      chunk.sequence,
      chunk.scope.projectId ?? null,
      chunk.scope.workstreamId ?? null,
      chunk.scope.sessionId,
      chunk.displayText,
      chunk.embeddingText,
      chunk.tokenCount,
      chunk.fingerprint,
      chunk.observedFrom ?? null,
      chunk.observedTo ?? null,
      stringifyJson(chunk),
    );

  database.prepare("DELETE FROM chunk_events WHERE chunk_id = ?").run(chunk.id);
  const link = database.prepare(`
    INSERT INTO chunk_events(chunk_id, event_id, position) VALUES (?, ?, ?)
  `);
  chunk.eventIds.forEach((eventId, position) => link.run(chunk.id, eventId, position));

  upsertSearchContent(database, {
    entityKind: "chunk",
    entityId: chunk.id,
    ...(chunk.scope.projectId === undefined
      ? {}
      : { projectId: chunk.scope.projectId }),
    ...(chunk.scope.workstreamId === undefined
      ? {}
      : { workstreamId: chunk.scope.workstreamId }),
    sessionId: chunk.scope.sessionId,
    hitType: "chunk",
    title: "",
    body: chunk.displayText,
    fingerprint: chunk.fingerprint,
    ...(chunk.observedTo ?? chunk.observedFrom) === undefined
      ? {}
      : { observedAt: chunk.observedTo ?? chunk.observedFrom },
  });
  replaceExactTerms(
    database,
    "chunk",
    chunk.id,
    extractExactTerms(`${chunk.displayText}\n${chunk.embeddingText}`),
  );
}

function upsertMemory(database: SqliteDatabase, memory: MemoryRecord): void {
  database
    .prepare(`
      INSERT INTO memories(
        memory_id, type, status, project_id, workstream_id, session_id,
        title, body, observed_from, observed_to, derived_at, updated_at,
        record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        type = excluded.type,
        status = excluded.status,
        project_id = excluded.project_id,
        workstream_id = excluded.workstream_id,
        session_id = excluded.session_id,
        title = excluded.title,
        body = excluded.body,
        observed_from = excluded.observed_from,
        observed_to = excluded.observed_to,
        derived_at = excluded.derived_at,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `)
    .run(
      memory.id,
      memory.type,
      memory.status,
      memory.scope.projectId ?? null,
      memory.scope.workstreamId ?? null,
      memory.scope.sessionId ?? null,
      memory.title,
      memory.body,
      memory.observedFrom ?? null,
      memory.observedTo ?? null,
      memory.derivedAt,
      memory.updatedAt,
      stringifyJson(memory),
    );

  database.prepare("DELETE FROM memory_evidence WHERE memory_id = ?").run(memory.id);
  const link = database.prepare(`
    INSERT INTO memory_evidence(memory_id, evidence_kind, evidence_id, position)
    VALUES (?, ?, ?, ?)
  `);
  collectMemoryEvidenceIds(memory).forEach((evidenceId, position) => {
    const kind = evidenceId.includes(":event:") ? "event" : "chunk";
    const evidence = database
      .prepare(
        kind === "event"
          ? "SELECT 1 AS present FROM events WHERE event_id = ?"
          : "SELECT 1 AS present FROM chunks WHERE chunk_id = ?",
      )
      .get(evidenceId);
    if (evidence === undefined) {
      throw new Error(`Memory references missing ${kind} evidence`);
    }
    link.run(memory.id, kind, evidenceId, position);
  });

  const fingerprint = createHash("sha256")
    .update(memory.title)
    .update("\0")
    .update(memory.body)
    .update("\0")
    .update(memory.extractorVersion)
    .digest("hex");
  upsertSearchContent(database, {
    entityKind: "memory",
    entityId: memory.id,
    ...(memory.scope.projectId === undefined
      ? {}
      : { projectId: memory.scope.projectId }),
    ...(memory.scope.workstreamId === undefined
      ? {}
      : { workstreamId: memory.scope.workstreamId }),
    ...(memory.scope.sessionId === undefined
      ? {}
      : { sessionId: memory.scope.sessionId }),
    hitType: memory.type,
    title: memory.title,
    body: memory.body,
    fingerprint,
    observedAt: memory.observedTo ?? memory.observedFrom ?? memory.updatedAt,
  });
  replaceExactTerms(
    database,
    "memory",
    memory.id,
    extractExactTerms(`${memory.title}\n${memory.body}`),
  );
}

interface SearchContentInput {
  readonly entityKind: "chunk" | "memory";
  readonly entityId: string;
  readonly projectId?: string;
  readonly workstreamId?: string;
  readonly sessionId?: string;
  readonly hitType: string;
  readonly title: string;
  readonly body: string;
  readonly fingerprint: string;
  readonly observedAt?: string;
}

function upsertSearchContent(
  database: SqliteDatabase,
  input: SearchContentInput,
): void {
  database
    .prepare(`
      INSERT INTO search_content(
        entity_kind, entity_id, project_id, workstream_id, session_id,
        hit_type, title, body, fingerprint, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
        project_id = excluded.project_id,
        workstream_id = excluded.workstream_id,
        session_id = excluded.session_id,
        hit_type = excluded.hit_type,
        title = excluded.title,
        body = excluded.body,
        fingerprint = excluded.fingerprint,
        observed_at = excluded.observed_at
    `)
    .run(
      input.entityKind,
      input.entityId,
      input.projectId ?? null,
      input.workstreamId ?? null,
      input.sessionId ?? null,
      input.hitType,
      input.title,
      input.body,
      input.fingerprint,
      input.observedAt ?? null,
    );
}
