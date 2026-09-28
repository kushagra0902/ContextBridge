/*
resp here:
need ids that are deterministic across all restarts.
need ids of  different types so that we can have different types of ids for different things.
need them strongly typed so that we can have type safety when using them.

can be serialized to string and deserialized from string.
*/

import { createHash } from "node:crypto";

type Brand<T, TBrand extends string> = T & {
  readonly __brand: TBrand;
};
// this is for type checking in ts, where if we define unique types for different ids.

export type ProjectId = Brand<string, "ProjectId">;
export type WorkstreamId = Brand<string, "WorkstreamId">;
export type SessionId = Brand<string, "SessionId">;
export type SourceId = Brand<string, "SourceId">;
export type EventId = Brand<string, "EventId">;
export type ChunkId = Brand<string, "ChunkId">;
export type MemoryId = Brand<string, "MemoryId">;
export type VectorId = Brand<string, "VectorId">;

// we made a reusable to make types in one sense. The brand function takes a type "T" and a generic TBrand which is a string literal type. It returns a new type that is the intersection of T and an object with a readonly property __brand of type TBrand. This allows us to create unique types for different ids while still being able to use them as strings.

export type StableID =
  | ProjectId
  | WorkstreamId
  | SessionId
  | SourceId
  | EventId
  | ChunkId
  | MemoryId
  | VectorId;

//this is just used for identifying what type or what entity is ts dealign with.
export type IdNamespace =
  | "project"
  | "workstream"
  | "session"
  | "source"
  | "event"
  | "chunk"
  | "memory"
  | "vector";

const ID_PREFIX = "ku:";
const HASH_ALGORITHM = "sha256";

export function encodeParts(parts: readonly string[]): string {
  return parts
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`) // joins the byte length along with the string itself
    .join("|");
}

// gives the stable key derived from the key types we selected.
export function stableId(
  namespace: IdNamespace,
  parts: readonly string[],
): string {
  if (parts.length === 0) {
    throw new Error("stableId requires at least one identity component");
  }

  const encoded = encodeParts(parts);

  const digest = createHash(HASH_ALGORITHM)
    .update(namespace)
    .update("\0")
    .update(encoded)
    .digest("hex");

  return `${ID_PREFIX}:${namespace}:${digest}`;
}

// checks if the given id is of type stableID that we produced
export function isStableId(
  value: unknown,
  namespace?: IdNamespace,
): value is string {
  // this is type predicate, and means if the function returns a true, treat the value as a string, otherwise return false or error
  if (typeof value !== "string") {
    return false;
  }

  const pattern = namespace
    ? new RegExp(`^${ID_PREFIX}:${namespace}:[a-f0-9]{64}$`)
    : new RegExp(
        `^${ID_PREFIX}:(project|workstream|session|source|event|chunk|memory|vector):[a-f0-9]{64}$`,
      );

  return pattern.test(value);
}

// a simple generic function to parse the IDs and return the vlaue, used by all the types further to give the result.
function parseId<T extends string>(value: unknown, namespace: IdNamespace): T {
  if (!isStableId(value, namespace)) {
    throw new TypeError(`Invalid ${namespace} ID`);
  }

  return value as T; // compatible value ko T ki tarah return kar dega
}

export function parseProjectId(value: unknown): ProjectId {
  return parseId<ProjectId>(value, "project");
}

export function parseWorkstreamId(value: unknown): WorkstreamId {
  return parseId<WorkstreamId>(value, "workstream");
}

export function parseSessionId(value: unknown): SessionId {
  return parseId<SessionId>(value, "session");
}

export function parseSourceId(value: unknown): SourceId {
  return parseId<SourceId>(value, "source");
}

export function parseEventId(value: unknown): EventId {
  return parseId<EventId>(value, "event");
}

export function parseChunkId(value: unknown): ChunkId {
  return parseId<ChunkId>(value, "chunk");
}

export function parseMemoryId(value: unknown): MemoryId {
  return parseId<MemoryId>(value, "memory");
}

export function parseVectorId(value: unknown): VectorId {
  return parseId<VectorId>(value, "vector");
}

export function projectId(parts: readonly string[]): ProjectId {
  return stableId("project", parts) as ProjectId;
}

//
export function workstreamId(parts: readonly string[]): WorkstreamId {
  return stableId("workstream", parts) as WorkstreamId;
}

export function sessionId(parts: readonly string[]): SessionId {
  return stableId("session", parts) as SessionId;
}

export function sourceId(parts: readonly string[]): SourceId {
  return stableId("source", parts) as SourceId;
}

export function eventId(parts: readonly string[]): EventId {
  return stableId("event", parts) as EventId;
}

export function chunkId(parts: readonly string[]): ChunkId {
  return stableId("chunk", parts) as ChunkId;
}

export function memoryId(parts: readonly string[]): MemoryId {
  return stableId("memory", parts) as MemoryId;
}

export function vectorId(parts: readonly string[]): VectorId {
  return stableId("vector", parts) as VectorId;
}
