import type { LexicalSearchRepository } from "../../../contracts/ports.js";
import type {
  RankedCandidate,
  SearchFilters,
} from "../../../contracts/search.js";
import type { SqliteDatabase } from "../database.js";
import type { StorageExecutor } from "../executor.js";
import { searchExactTerms } from "../exact-terms.js";
import { searchFts } from "../fts.js";

export class SqliteLexicalSearchRepository implements LexicalSearchRepository {
  constructor(private readonly executor: StorageExecutor) {}

  search(
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<readonly RankedCandidate[]> {
    return this.executor.execute("lexical.search", { query, filters, limit });
  }
}

export function handleLexicalSearchOperation(
  database: SqliteDatabase,
  operation: string,
  argument: unknown,
): unknown {
  if (operation !== "lexical.search") {
    throw new Error(`Unknown lexical repository operation: ${operation}`);
  }
  const input = argument as {
    query: string;
    filters: SearchFilters;
    limit: number;
  };
  return searchLexical(database, input.query, input.filters, input.limit);
}

export function searchLexical(
  database: SqliteDatabase,
  query: string,
  filters: SearchFilters,
  limit: number,
): readonly RankedCandidate[] {
  if (query.normalize("NFKC").trim().length === 0) {
    return [];
  }
  const exact = searchExactTerms(database, query, filters, limit);
  const fts = searchFts(database, query, filters, limit);

  const seen = new Set<string>();
  const fused: RankedCandidate[] = [];
  for (const candidate of [...exact, ...fts]) {
    const key = `${candidate.entity.kind}\0${candidate.entity.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    fused.push({ ...candidate, rank: fused.length + 1 });
    if (fused.length === limit) {
      break;
    }
  }
  return fused;
}
