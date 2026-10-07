import type {
  GetContextOverviewInput,
  GetContextOverviewResult,
  GetEvidenceInput,
  GetEvidenceResult,
  ListContextScopesInput,
  ListContextScopesResult,
  SearchMemoryInput,
  SearchMemoryResult,
} from "../app/index.js";
import {
  parseChunkId,
  parseEventId,
  parseProjectId,
  parseSessionId,
  parseWorkstreamId,
} from "../contracts/ids.js";
import type { ScopeAddress } from "../contracts/scope.js";
import { parseSearchCursor } from "../contracts/search.js";
import { toMcpError, toMcpResult } from "./responses.js";
import type {
  GetContextOverviewToolInput,
  GetEvidenceToolInput,
  ListContextScopesToolInput,
  SearchMemoryToolInput,
} from "./tool-schemas.js";
import type { McpSessionReferenceApplication } from "./session-references.js";

export interface McpReadApplication extends Partial<McpSessionReferenceApplication> {
  listContextScopes(input: ListContextScopesInput): Promise<ListContextScopesResult>;
  getContextOverview(input: GetContextOverviewInput): Promise<GetContextOverviewResult>;
  searchMemory(input: SearchMemoryInput): Promise<SearchMemoryResult>;
  getEvidence(input: GetEvidenceInput): Promise<GetEvidenceResult>;
}

export function createMcpHandlers(app: McpReadApplication) {
  return {
    listContextScopes: safe(async (input: ListContextScopesToolInput) => app.listContextScopes({
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.limit === undefined ? {} : { budget: { maxItems: input.limit } }),
    })),
    getContextOverview: safe(async (input: GetContextOverviewToolInput) => app.getContextOverview({
      scope: parseScope(input.scope),
      ...(input.maxTokens === undefined ? {} : { budget: { maxTokens: input.maxTokens } }),
    })),
    searchMemory: safe(async (input: SearchMemoryToolInput) => app.searchMemory({
      query: input.query,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.scopeQuery === undefined ? {} : { scopeQuery: input.scopeQuery }),
      ...filtersFor(input),
      ...budgetFor(input.limit, input.maxTokens),
      ...(input.cursor === undefined ? {} : { cursor: parseSearchCursor(input.cursor) }),
    })),
    getEvidence: safe(async (input: GetEvidenceToolInput) => app.getEvidence({
      evidenceIds: input.evidenceIds.map((id) => id.startsWith("ku::event:") ? parseEventId(id) : parseChunkId(id)),
      ...(input.scope === undefined ? {} : { scope: parseScope(input.scope) }),
      ...(input.beforeEvents === undefined ? {} : { beforeEvents: input.beforeEvents }),
      ...(input.afterEvents === undefined ? {} : { afterEvents: input.afterEvents }),
      ...(input.maxTokens === undefined ? {} : { budget: { maxTokens: input.maxTokens } }),
    })),
  };
}

function safe<TInput>(operation: (input: TInput) => Promise<object>) {
  return async (input: TInput) => {
    try {
      return toMcpResult(await operation(input));
    } catch (error) {
      return toMcpError(error);
    }
  };
}

function parseScope(scope: {
  projectId: string;
  workstreamId?: string | undefined;
  sessionId?: string | undefined;
}): ScopeAddress {
  return {
    projectId: parseProjectId(scope.projectId),
    ...(scope.workstreamId === undefined ? {} : { workstreamId: parseWorkstreamId(scope.workstreamId) }),
    ...(scope.sessionId === undefined ? {} : { sessionId: parseSessionId(scope.sessionId) }),
  };
}

function filtersFor(input: SearchMemoryToolInput): Pick<SearchMemoryInput, "filters"> {
  const timeRange = input.from === undefined && input.to === undefined
    ? undefined
    : {
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
      };
  const filters = {
    ...(input.scope === undefined ? {} : { scope: parseScope(input.scope) }),
    ...(input.memoryTypes === undefined ? {} : { memoryTypes: input.memoryTypes }),
    ...(timeRange === undefined ? {} : { timeRange }),
    ...(input.paths === undefined ? {} : { paths: input.paths }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  };
  return Object.keys(filters).length === 0 ? {} : { filters };
}

function budgetFor(limit: number | undefined, maxTokens: number | undefined): Pick<SearchMemoryInput, "budget"> {
  if (limit === undefined && maxTokens === undefined) return {};
  return {
    budget: {
      ...(limit === undefined ? {} : { maxItems: limit }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
  };
}
