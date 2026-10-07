import type { MemoryType } from "../../contracts/memory.js";
import { parseSearchCursor, type SearchIntent } from "../../contracts/search.js";
import {
  assertAllowedOptions,
  optionInteger,
  optionString,
  optionStrings,
  type ParsedCliArguments,
} from "../arguments.js";
import { CliUsageError, type CliApplication } from "../types.js";
import { optionalScope } from "./common.js";

const INTENTS = new Set<SearchIntent>([
  "exact_identifier", "exact_error", "decision_rationale", "debugging_history",
  "chronology", "open_items", "latest_state", "broad_synthesis", "general",
]);
const MEMORY_TYPES = new Set<MemoryType>([
  "session_synopsis", "workstream_synopsis", "project_synopsis", "decision",
  "episode", "semantic_fact", "open_item",
]);

export async function runSearchCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, [
    "project", "workstream", "session", "scope-query", "intent", "type",
    "from", "to", "path", "branch", "limit", "max-tokens", "cursor",
  ]);
  const query = parsed.positionals.join(" ").trim();
  if (query.length === 0) throw new CliUsageError("search requires a query");
  if (query.length > 2_048) throw new CliUsageError("Search query cannot exceed 2048 characters");
  if (/[\u0000-\u001f\u007f]/u.test(query)) throw new CliUsageError("Search query contains control characters");
  const scope = optionalScope(parsed);
  const intent = optionString(parsed, "intent") as SearchIntent | undefined;
  if (intent !== undefined && !INTENTS.has(intent)) throw new CliUsageError(`Unknown search intent: ${intent}`);
  const memoryTypes = optionStrings(parsed, "type") as readonly MemoryType[];
  if (memoryTypes.length > 7) throw new CliUsageError("Search accepts at most 7 memory types");
  if (memoryTypes.some((type) => !MEMORY_TYPES.has(type))) throw new CliUsageError("Unknown memory type");
  const from = optionString(parsed, "from");
  const to = optionString(parsed, "to");
  const paths = optionStrings(parsed, "path");
  if (paths.length > 16) throw new CliUsageError("Search accepts at most 16 --path filters");
  if (paths.some((path) => path.length === 0 || path.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(path))) {
    throw new CliUsageError("Search paths must be bounded and contain no control characters");
  }
  const branch = optionString(parsed, "branch");
  if (branch !== undefined && (branch.length > 512 || /[\u0000-\u001f\u007f]/u.test(branch))) {
    throw new CliUsageError("Branch must be at most 512 characters with no control characters");
  }
  const filters = {
    ...(scope === undefined ? {} : { scope }),
    ...(memoryTypes.length === 0 ? {} : { memoryTypes }),
    ...(from === undefined && to === undefined ? {} : { timeRange: {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    } }),
    ...(paths.length === 0 ? {} : { paths }),
    ...(branch === undefined ? {} : { branch }),
  };
  const limit = optionInteger(parsed, "limit", 1, 20);
  const maxTokens = optionInteger(parsed, "max-tokens", 128, 6_000);
  const cursor = optionString(parsed, "cursor");
  const scopeQuery = optionString(parsed, "scope-query");
  if (scopeQuery !== undefined && (scopeQuery.length > 256 || /[\u0000-\u001f\u007f]/u.test(scopeQuery))) {
    throw new CliUsageError("Scope query must be at most 256 characters with no control characters");
  }
  if (scope !== undefined && scopeQuery !== undefined) {
    throw new CliUsageError("Use either an explicit scope or --scope-query, not both");
  }
  validateTimeRange(from, to);
  return app.searchMemory({
    query,
    ...(intent === undefined ? {} : { intent }),
    ...(scopeQuery === undefined ? {} : { scopeQuery }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
    ...(limit === undefined && maxTokens === undefined ? {} : { budget: {
      ...(limit === undefined ? {} : { maxItems: limit }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    } }),
    ...(cursor === undefined ? {} : { cursor: parseSearchCursor(cursor) }),
  });
}

function validateTimeRange(from: string | undefined, to: string | undefined): void {
  const parse = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
      throw new CliUsageError("Time filters must be ISO-8601 timestamps with an offset");
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new CliUsageError("Time filters must be valid ISO-8601 timestamps");
    return timestamp;
  };
  const fromTime = parse(from);
  const toTime = parse(to);
  if (fromTime !== undefined && toTime !== undefined && fromTime > toTime) {
    throw new CliUsageError("--from must not be later than --to");
  }
}
