// This file handles searching for exact common terms,  
// that will be handled by full text search poorly.
// It creates a separate reference table types for these words so that they can be 
// searched faster. 

import type { RankedCandidate, SearchFilters } from "../../contracts/search.js";
import type { SqliteDatabase, SqliteRow } from "./database.js";
import {
  buildSearchWhere,
  normalizeExactTerm,
  rowToCandidate,
  visibleSearchContentSql,
} from "./fts.js";

export type ExactTermKind = "path" | "symbol" | "error" | "identifier";

export interface ExactTerm {
  readonly kind: ExactTermKind;
  readonly value: string;
}

const PATH_PATTERN = /(?:\.{0,2}\/)?(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_.@-]+/gu;
const SYMBOL_PATTERN = /\b[A-Za-z_$][\w$]*(?:(?:::|\.|#)[A-Za-z_$][\w$]*)+\b/gu;
const IDENTIFIER_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$-]{2,}\b/gu;

export function extractExactTerms(text: string): readonly ExactTerm[] {
  const terms = new Map<string, ExactTerm>();
  addMatches(terms, text, PATH_PATTERN, "path");
  addMatches(terms, text, SYMBOL_PATTERN, "symbol");
  addMatches(terms, text, IDENTIFIER_PATTERN, "identifier");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (
      trimmed.length >= 4 &&
      trimmed.length <= 512 &&
      /(?:error|exception|failed|failure|panic|traceback|\bE[A-Z0-9_]{3,}\b)/iu.test(trimmed)
    ) {
      addTerm(terms, { kind: "error", value: trimmed });
    }
  }
  return [...terms.values()].slice(0, 1_000);
}

export function replaceExactTerms(
  database: SqliteDatabase,
  entityKind: "chunk" | "memory",
  entityId: string,
  terms: readonly ExactTerm[],
): void {
  database
    .prepare("DELETE FROM exact_terms WHERE entity_kind = ? AND entity_id = ?")
    .run(entityKind, entityId);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO exact_terms(
      entity_kind, entity_id, term_kind, term, normalized_term
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const term of terms.slice(0, 1_000)) {
    const normalized = normalizeExactTerm(term.value);
    if (normalized.length > 0 && normalized.length <= 512) {
      insert.run(entityKind, entityId, term.kind, term.value, normalized);
    }
  }
}

export function searchExactTerms(
  database: SqliteDatabase,
  query: string,
  filters: SearchFilters,
  limit: number,
): readonly RankedCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Search limit must be from 1 to 1000");
  }
  const normalized = normalizeExactTerm(query);
  if (normalized.length === 0 || normalized.length > 512 || /\0/u.test(query)) {
    return [];
  }
  const where = buildSearchWhere(filters);
  const rows = database
    .prepare(`
      SELECT
        search_content.entity_kind,
        search_content.entity_id,
        search_content.project_id,
        search_content.workstream_id,
        search_content.session_id,
        search_content.fingerprint,
        MIN(CASE
          WHEN exact_terms.normalized_term = ? THEN 0
          WHEN exact_terms.normalized_term LIKE ? ESCAPE '\\' THEN 1
          ELSE 2
        END) AS score
      FROM exact_terms
      JOIN search_content
        ON search_content.entity_kind = exact_terms.entity_kind
       AND search_content.entity_id = exact_terms.entity_id
      LEFT JOIN sessions ON sessions.session_id = search_content.session_id
      WHERE (
        exact_terms.normalized_term = ? OR
        exact_terms.normalized_term LIKE ? ESCAPE '\\' OR
        exact_terms.normalized_term LIKE ? ESCAPE '\\'
      )
        AND ${visibleSearchContentSql()}
        ${where.sql}
      GROUP BY search_content.entity_kind, search_content.entity_id
      ORDER BY score, search_content.rowid
      LIMIT ?
    `)
    .all(
      normalized,
      `${escapeLike(normalized)}%`,
      normalized,
      `${escapeLike(normalized)}%`,
      `%${escapeLike(normalized)}%`,
      ...where.parameters,
      limit,
    ) as SqliteRow[];
  return rows.flatMap((row, index) => {
    const candidate = rowToCandidate(row, "exact", index + 1);
    return candidate === undefined ? [] : [candidate];
  });
}

function addMatches(
  target: Map<string, ExactTerm>,
  text: string,
  pattern: RegExp,
  kind: ExactTermKind,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    if (value !== undefined) {
      addTerm(target, { kind, value });
    }
  }
}

function addTerm(target: Map<string, ExactTerm>, term: ExactTerm): void {
  const normalized = normalizeExactTerm(term.value);
  if (normalized.length > 0 && normalized.length <= 512) {
    target.set(`${term.kind}\0${normalized}`, term);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}
