import type {
  EmbeddingJobRepository,
  EmbeddingJobClaim,
} from "../../../contracts/ports.js";
import type {
  EmbeddableEntity,
  EmbeddingJob,
  EmbeddingJobId,
  EmbeddingRecord,
  EmbeddingSpace,
  EmbeddingSpaceId,
} from "../../../contracts/embedding.js";
import { embeddingSpacesAreCompatible } from "../../../contracts/embedding.js";
import type { ChunkId, MemoryId, VectorId } from "../../../contracts/ids.js";
import type { SqliteDatabase, SqliteRow } from "../database.js";
import {
  optionalString,
  parseJson,
  requiredNumber,
  requiredString,
  stringifyJson,
} from "../database.js";
import type { StorageExecutor } from "../executor.js";
import { withTransaction } from "../transaction.js";

export class SqliteEmbeddingJobRepository implements EmbeddingJobRepository {
  constructor(private readonly executor: StorageExecutor) {}

  upsertSpace(space: EmbeddingSpace): Promise<void> {
    return this.executor.execute("embedding.upsertSpace", space);
  }

  getSpace(spaceId: EmbeddingSpaceId): Promise<EmbeddingSpace | undefined> {
    return this.executor.execute("embedding.getSpace", spaceId);
  }

  getActiveSpace(): Promise<EmbeddingSpace | undefined> {
    return this.executor.execute("embedding.getActiveSpace");
  }

  enqueue(jobs: readonly EmbeddingJob[]): Promise<void> {
    return this.executor.execute("embedding.enqueue", jobs);
  }

  claim(input: EmbeddingJobClaim): Promise<readonly EmbeddingJob[]> {
    return this.executor.execute("embedding.claim", input);
  }

  requeueExpiredLeases(now: Date): Promise<number> {
    return this.executor.execute("embedding.requeueExpiredLeases", now);
  }

  acknowledge(
    jobId: EmbeddingJobId,
    indexedFingerprint: string,
    vectorId: VectorId,
  ): Promise<boolean> {
    return this.executor.execute("embedding.acknowledge", {
      jobId,
      indexedFingerprint,
      vectorId,
    });
  }

  retry(jobId: EmbeddingJobId, retryAt: Date, errorCode: string): Promise<void> {
    return this.executor.execute("embedding.retry", { jobId, retryAt, errorCode });
  }

  fail(jobId: EmbeddingJobId, errorCode: string): Promise<void> {
    return this.executor.execute("embedding.fail", { jobId, errorCode });
  }

  getRecords(
    entities: readonly EmbeddingJob["entity"][],
    spaceId: EmbeddingSpaceId,
  ): Promise<readonly EmbeddingRecord[]> {
    return this.executor.execute("embedding.getRecords", { entities, spaceId });
  }
}

export function handleEmbeddingJobsOperation(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  switch (operation) {
    case "embedding.upsertSpace":
      upsertEmbeddingSpace(database, argument as EmbeddingSpace);
      return undefined;
    case "embedding.getSpace":
      return getEmbeddingSpace(database, argument as EmbeddingSpaceId);
    case "embedding.getActiveSpace":
      return getActiveEmbeddingSpace(database);
    case "embedding.enqueue":
      withTransaction(database, () => {
        enqueueEmbeddingJobs(database, argument as readonly EmbeddingJob[]);
      });
      return undefined;
    case "embedding.claim":
      return claimEmbeddingJobs(database, argument as EmbeddingJobClaim);
    case "embedding.requeueExpiredLeases":
      return requeueExpiredLeases(database, asDate(argument));
    case "embedding.acknowledge": {
      const input = argument as {
        jobId: EmbeddingJobId;
        indexedFingerprint: string;
        vectorId: VectorId;
      };
      return acknowledgeEmbeddingJob(
        database,
        input.jobId,
        input.indexedFingerprint,
        input.vectorId,
      );
    }
    case "embedding.retry": {
      const input = argument as {
        jobId: EmbeddingJobId;
        retryAt: Date | string;
        errorCode: string;
      };
      updateFailedJob(database, input.jobId, "retry", asDate(input.retryAt), input.errorCode);
      return undefined;
    }
    case "embedding.fail": {
      const input = argument as { jobId: EmbeddingJobId; errorCode: string };
      updateFailedJob(database, input.jobId, "failed", undefined, input.errorCode);
      return undefined;
    }
    case "embedding.getRecords": {
      const input = argument as {
        entities: readonly EmbeddableEntity[];
        spaceId: EmbeddingSpaceId;
      };
      return getEmbeddingRecords(database, input.entities, input.spaceId);
    }
    default:
      throw new Error(`Unknown embedding repository operation: ${operation}`);
  }
}

export function upsertEmbeddingSpace(
  database: SqliteDatabase,
  space: EmbeddingSpace,
): void {
  if (!Number.isSafeInteger(space.dimension) || space.dimension <= 0) {
    throw new RangeError("Embedding dimension must be a positive integer");
  }
  withTransaction(database, () => {
    const existing = getEmbeddingSpace(database, space.id);
    if (
      existing !== undefined &&
      !embeddingSpacesAreCompatible(existing, space)
    ) {
      throw new Error("An embedding-space ID cannot be reused for an incompatible model");
    }
    if (space.status === "active") {
      database
        .prepare(`
          UPDATE embedding_spaces
          SET status = 'retiring',
              record_json = json_set(record_json, '$.status', 'retiring')
          WHERE status = 'active' AND space_id != ?
        `)
        .run(space.id);
    }
    database
      .prepare(`
        INSERT INTO embedding_spaces(
          space_id, provider, model_id, model_revision, dimension,
          distance_metric, normalization, tokenizer_version,
          preprocessing_version, redaction_version, status, created_at,
          record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(space_id) DO UPDATE SET
          provider = excluded.provider,
          model_id = excluded.model_id,
          model_revision = excluded.model_revision,
          dimension = excluded.dimension,
          distance_metric = excluded.distance_metric,
          normalization = excluded.normalization,
          tokenizer_version = excluded.tokenizer_version,
          preprocessing_version = excluded.preprocessing_version,
          redaction_version = excluded.redaction_version,
          status = excluded.status,
          record_json = excluded.record_json
      `)
      .run(
        space.id,
        space.provider,
        space.modelId,
        space.modelRevision,
        space.dimension,
        space.distanceMetric,
        space.normalization,
        space.tokenizerVersion,
        space.preprocessingVersion,
        space.redactionVersion,
        space.status,
        space.createdAt,
        stringifyJson(space),
      );
  });
}

export function getEmbeddingSpace(
  database: SqliteDatabase,
  spaceId: EmbeddingSpaceId,
): EmbeddingSpace | undefined {
  const row = database
    .prepare("SELECT record_json FROM embedding_spaces WHERE space_id = ?")
    .get(spaceId) as SqliteRow | undefined;
  return row === undefined
    ? undefined
    : parseJson<EmbeddingSpace>(requiredString(row, "record_json"), "embedding space");
}

export function getActiveEmbeddingSpace(
  database: SqliteDatabase,
): EmbeddingSpace | undefined {
  const row = database
    .prepare("SELECT record_json FROM embedding_spaces WHERE status = 'active' LIMIT 1")
    .get() as SqliteRow | undefined;
  return row === undefined
    ? undefined
    : parseJson<EmbeddingSpace>(requiredString(row, "record_json"), "embedding space");
}

export function enqueueEmbeddingJobs(
  database: SqliteDatabase,
  jobs: readonly EmbeddingJob[],
): void {
  const insert = database.prepare(`
    INSERT INTO embedding_jobs(
      job_id, entity_kind, entity_id, memory_type, space_id,
      desired_fingerprint, operation, state, attempts, retry_at,
      error_code, lease_owner, lease_expires_at, created_at, updated_at,
      record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      desired_fingerprint = excluded.desired_fingerprint,
      operation = excluded.operation,
      state = excluded.state,
      attempts = excluded.attempts,
      retry_at = excluded.retry_at,
      error_code = excluded.error_code,
      lease_owner = excluded.lease_owner,
      lease_expires_at = excluded.lease_expires_at,
      updated_at = excluded.updated_at,
      record_json = excluded.record_json
  `);
  const desire = database.prepare(`
    INSERT INTO embedding_desires(
      entity_kind, entity_id, space_id, desired_fingerprint, operation, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_kind, entity_id, space_id) DO UPDATE SET
      desired_fingerprint = excluded.desired_fingerprint,
      operation = excluded.operation,
      updated_at = excluded.updated_at
  `);

  for (const job of jobs) {
    if (getEmbeddingSpace(database, job.spaceId) === undefined) {
      throw new Error(`Unknown embedding space: ${job.spaceId}`);
    }
    insert.run(
      job.id,
      job.entity.kind,
      job.entity.id,
      job.entity.kind === "memory" ? job.entity.memoryType : null,
      job.spaceId,
      job.desiredFingerprint,
      job.operation,
      job.state,
      job.attempts,
      job.retryAt ?? null,
      job.errorCode ?? null,
      job.leaseOwner ?? null,
      job.leaseExpiresAt ?? null,
      job.createdAt,
      job.updatedAt,
      stringifyJson(job),
    );
    desire.run(
      job.entity.kind,
      job.entity.id,
      job.spaceId,
      job.desiredFingerprint,
      job.operation,
      job.updatedAt,
    );
  }
}

export function claimEmbeddingJobs(
  database: SqliteDatabase,
  input: EmbeddingJobClaim,
): readonly EmbeddingJob[] {
  validateClaim(input);
  const now = asDate(input.now);
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseDurationMs).toISOString();
  return withTransaction(database, () => {
    const rows = database
      .prepare(`
        SELECT job_id
        FROM embedding_jobs
        WHERE state = 'pending'
           OR (state = 'retry' AND retry_at IS NOT NULL AND retry_at <= ?)
        ORDER BY created_at, job_id
        LIMIT ?
      `)
      .all(nowIso, input.limit) as SqliteRow[];
    const getJob = database.prepare("SELECT * FROM embedding_jobs WHERE job_id = ?");
    const update = database.prepare(`
      UPDATE embedding_jobs
      SET state = 'processing', attempts = attempts + 1,
          lease_owner = ?, lease_expires_at = ?, updated_at = ?,
          retry_at = NULL, error_code = NULL
      WHERE job_id = ?
    `);
    const claimed: EmbeddingJob[] = [];
    for (const row of rows) {
      const jobId = requiredString(row, "job_id");
      update.run(input.workerId, leaseExpiresAt, nowIso, jobId);
      const updated = getJob.get(jobId) as SqliteRow | undefined;
      if (updated !== undefined) {
        claimed.push(rowToJob(updated));
      }
    }
    return claimed;
  });
}

export function requeueExpiredLeases(
  database: SqliteDatabase,
  now: Date,
): number {
  const result = database
    .prepare(`
      UPDATE embedding_jobs
      SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
          updated_at = ?
      WHERE state = 'processing'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
    `)
    .run(now.toISOString(), now.toISOString());
  return Number(result.changes);
}

export function acknowledgeEmbeddingJob(
  database: SqliteDatabase,
  jobId: EmbeddingJobId,
  indexedFingerprint: string,
  vectorId: VectorId,
): boolean {
  return withTransaction(database, () => {
    const row = database
      .prepare(`
        SELECT embedding_jobs.*,
               embedding_desires.desired_fingerprint AS current_fingerprint,
               embedding_desires.operation AS current_operation
        FROM embedding_jobs
        JOIN embedding_desires USING (entity_kind, entity_id, space_id)
        WHERE job_id = ?
      `)
      .get(jobId) as SqliteRow | undefined;
    if (
      row === undefined ||
      row.state !== "processing" ||
      row.desired_fingerprint !== indexedFingerprint ||
      row.current_fingerprint !== indexedFingerprint ||
      row.operation !== row.current_operation
    ) {
      return false;
    }

    const now = new Date().toISOString();
    if (row.operation === "delete") {
      database
        .prepare(`
          DELETE FROM embedding_records
          WHERE entity_kind = ? AND entity_id = ? AND space_id = ?
        `)
        .run(row.entity_kind as string, row.entity_id as string, row.space_id as string);
    } else {
      database
        .prepare(`
          INSERT INTO embedding_records(
            entity_kind, entity_id, memory_type, space_id, fingerprint,
            vector_id, indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_kind, entity_id, space_id) DO UPDATE SET
            memory_type = excluded.memory_type,
            fingerprint = excluded.fingerprint,
            vector_id = excluded.vector_id,
            indexed_at = excluded.indexed_at
        `)
        .run(
          row.entity_kind as string,
          row.entity_id as string,
          row.memory_type as string | null,
          row.space_id as string,
          indexedFingerprint,
          vectorId,
          now,
        );
    }
    database
      .prepare(`
        UPDATE embedding_jobs
        SET state = 'ready', lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, error_code = NULL
        WHERE job_id = ?
      `)
      .run(now, jobId);
    return true;
  });
}

export function getEmbeddingRecords(
  database: SqliteDatabase,
  entities: readonly EmbeddableEntity[],
  spaceId: EmbeddingSpaceId,
): readonly EmbeddingRecord[] {
  if (entities.length === 0) {
    return [];
  }
  if (entities.length > 1_000) {
    throw new RangeError("At most 1000 embedding records can be read at once");
  }
  const clauses = entities
    .map(() => "(embedding_records.entity_kind = ? AND embedding_records.entity_id = ?)")
    .join(" OR ");
  const parameters = entities.flatMap((entity) => [entity.kind, entity.id]);
  const rows = database
    .prepare(`
      SELECT embedding_records.* FROM embedding_records
      JOIN embedding_desires
        ON embedding_desires.entity_kind = embedding_records.entity_kind
       AND embedding_desires.entity_id = embedding_records.entity_id
       AND embedding_desires.space_id = embedding_records.space_id
       AND embedding_desires.operation = 'upsert'
       AND embedding_desires.desired_fingerprint = embedding_records.fingerprint
      WHERE embedding_records.space_id = ? AND (${clauses})
    `)
    .all(spaceId, ...parameters) as SqliteRow[];
  const byEntity = new Map(
    rows.map((row) => [`${row.entity_kind as string}\0${row.entity_id as string}`, rowToRecord(row)]),
  );
  return entities.flatMap((entity) => {
    const record = byEntity.get(`${entity.kind}\0${entity.id}`);
    return record === undefined ? [] : [record];
  });
}

function updateFailedJob(
  database: SqliteDatabase,
  jobId: EmbeddingJobId,
  state: "retry" | "failed",
  retryAt: Date | undefined,
  errorCode: string,
): void {
  if (errorCode.length === 0 || errorCode.length > 128) {
    throw new TypeError("Invalid embedding error code");
  }
  const result = database
    .prepare(`
      UPDATE embedding_jobs
      SET state = ?, retry_at = ?, error_code = ?, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND state = 'processing'
    `)
    .run(
      state,
      retryAt?.toISOString() ?? null,
      errorCode,
      new Date().toISOString(),
      jobId,
    );
  if (result.changes === 0) {
    throw new Error("Embedding job is not currently leased");
  }
}

function rowToJob(row: SqliteRow): EmbeddingJob {
  const kind = requiredString(row, "entity_kind");
  const memoryType = optionalString(row, "memory_type");
  const entity: EmbeddableEntity = kind === "chunk"
    ? { kind: "chunk", id: requiredString(row, "entity_id") as ChunkId }
    : {
        kind: "memory",
        id: requiredString(row, "entity_id") as MemoryId,
        memoryType: memoryType as Extract<EmbeddableEntity, { kind: "memory" }>["memoryType"],
      };
  const retryAt = optionalString(row, "retry_at");
  const errorCode = optionalString(row, "error_code");
  const leaseOwner = optionalString(row, "lease_owner");
  const leaseExpiresAt = optionalString(row, "lease_expires_at");
  return {
    id: requiredString(row, "job_id"),
    entity,
    spaceId: requiredString(row, "space_id"),
    desiredFingerprint: requiredString(row, "desired_fingerprint"),
    operation: requiredString(row, "operation") as EmbeddingJob["operation"],
    state: requiredString(row, "state") as EmbeddingJob["state"],
    attempts: requiredNumber(row, "attempts"),
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    createdAt: requiredString(row, "created_at"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

function rowToRecord(row: SqliteRow): EmbeddingRecord {
  const kind = requiredString(row, "entity_kind");
  const memoryType = optionalString(row, "memory_type");
  return {
    entity: kind === "chunk"
      ? { kind: "chunk", id: requiredString(row, "entity_id") as ChunkId }
      : {
          kind: "memory",
          id: requiredString(row, "entity_id") as MemoryId,
          memoryType: memoryType as Extract<EmbeddableEntity, { kind: "memory" }>["memoryType"],
        },
    spaceId: requiredString(row, "space_id"),
    fingerprint: requiredString(row, "fingerprint"),
    vectorId: requiredString(row, "vector_id") as VectorId,
    indexedAt: requiredString(row, "indexed_at"),
  };
}

function validateClaim(input: EmbeddingJobClaim): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw new RangeError("Embedding claim limit must be from 1 to 1000");
  }
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1_000 ||
    input.leaseDurationMs > 3_600_000
  ) {
    throw new RangeError("Embedding lease must be from 1 second to 1 hour");
  }
  if (input.workerId.length === 0 || input.workerId.length > 128) {
    throw new TypeError("Invalid embedding worker ID");
  }
  asDate(input.now);
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(value as string);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid date");
  }
  return date;
}
