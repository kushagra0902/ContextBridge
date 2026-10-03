// Handles the boundaries of chunks, ie where one chunk should end 
// and other chunk ends.  

// It identifies the boundaries such as user turn, assisstant turn 
// tool cal etc; keeping related events together

import type { CanonicalEvent } from "../../contracts/evidence.js";

export type EventGroupBoundary = "session_start" | "user_turn";

export interface EventGroup {
  readonly boundary: EventGroupBoundary;
  readonly events: readonly CanonicalEvent[];
}

export interface ToolEventPair {
  readonly call: CanonicalEvent;
  readonly result: CanonicalEvent;
  readonly toolCallId: string;
}

export interface BoundaryAnalysis {
  readonly groups: readonly EventGroup[];
  readonly toolPairs: readonly ToolEventPair[];
  readonly unmatchedToolCalls: readonly CanonicalEvent[];
  readonly unmatchedToolResults: readonly CanonicalEvent[];
}

/**
 * Establishes deterministic event order and user-turn boundaries. A boundary
 * that would separate a tool call from its matching result is removed so the
 * pair remains a coherent retrieval unit without reordering intervening events.
 */
export function analyzeEventBoundaries(
  input: readonly CanonicalEvent[],
): BoundaryAnalysis {
  if (input.length === 0) {
    return {
      groups: [],
      toolPairs: [],
      unmatchedToolCalls: [],
      unmatchedToolResults: [],
    };
  }

  const events = orderAndValidateEvents(input);
  const indexById = new Map(events.map((event, index) => [event.id, index]));
  const pendingCalls = new Map<string, CanonicalEvent[]>();
  const toolPairs: ToolEventPair[] = [];
  const callsWithoutIds: CanonicalEvent[] = [];
  const unmatchedToolResults: CanonicalEvent[] = [];

  for (const event of events) {
    if (event.kind === "tool_call") {
      if (event.toolCallId === undefined) {
        callsWithoutIds.push(event);
        continue;
      }
      const pending = pendingCalls.get(event.toolCallId) ?? [];
      pending.push(event);
      pendingCalls.set(event.toolCallId, pending);
      continue;
    }
    if (event.kind !== "tool_result") continue;
    if (event.toolCallId === undefined) {
      unmatchedToolResults.push(event);
      continue;
    }
    const pending = pendingCalls.get(event.toolCallId);
    const call = pending?.shift();
    if (call === undefined) {
      unmatchedToolResults.push(event);
      continue;
    }
    if (pending?.length === 0) pendingCalls.delete(event.toolCallId);
    toolPairs.push({ call, result: event, toolCallId: event.toolCallId });
  }

  const boundaryIndexes = new Set<number>([0]);
  events.forEach((event, index) => {
    if (index > 0 && event.kind === "user_message") boundaryIndexes.add(index);
  });
  for (const pair of toolPairs) {
    const callIndex = indexById.get(pair.call.id);
    const resultIndex = indexById.get(pair.result.id);
    if (callIndex === undefined || resultIndex === undefined) continue;
    for (const boundary of boundaryIndexes) {
      if (boundary > callIndex && boundary <= resultIndex) {
        boundaryIndexes.delete(boundary);
      }
    }
  }

  const starts = [...boundaryIndexes].sort((left, right) => left - right);
  const groups = starts.map((start, index): EventGroup => ({
    boundary: start === 0 ? "session_start" : "user_turn",
    events: events.slice(start, starts[index + 1] ?? events.length),
  }));
  const unmatchedToolCalls = [
    ...callsWithoutIds,
    ...[...pendingCalls.values()].flat(),
  ]
    .sort(compareEvents);

  return { groups, toolPairs, unmatchedToolCalls, unmatchedToolResults };
}

// Orders the events by the ordinal
export function orderAndValidateEvents(
  input: readonly CanonicalEvent[],
): readonly CanonicalEvent[] {
  if (input.length === 0) return [];
  const sessionId = input[0]?.sessionId;
  const ids = new Set<string>();
  for (const event of input) {
    if (event.sessionId !== sessionId) {
      throw new TypeError("Chunk input may contain events from only one session");
    }
    if (!Number.isSafeInteger(event.ordinal) || event.ordinal < 0) {
      throw new RangeError("Chunk input contains an invalid event ordinal");
    }
    if (ids.has(event.id)) {
      throw new Error("Chunk input contains a duplicate event ID");
    }
    ids.add(event.id);
  }
  return [...input].sort(compareEvents);
}

function compareEvents(left: CanonicalEvent, right: CanonicalEvent): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}
