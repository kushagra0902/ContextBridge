// Gives the specific user instrcution to ignore or restrict files/folders
// that are normally allowed. 

import { isAbsolute } from "node:path";

import type { ProjectId } from "../contracts/ids.js";

export type IgnoreRuleAction = "exclude" | "include";

export interface IgnoreRule {
  readonly line: number;
  readonly pattern: string;
  readonly action: IgnoreRuleAction;
  readonly matches: (relativePath: string) => boolean;
}

export type IgnoreRuleDiagnosticCode =
  | "PATTERN_TOO_LONG"
  | "ABSOLUTE_PATTERN"
  | "PARENT_TRAVERSAL"
  | "UNSUPPORTED_PATTERN"
  | "EMPTY_NEGATION";

export interface IgnoreRuleDiagnostic {
  readonly line: number;
  readonly code: IgnoreRuleDiagnosticCode;
}

export interface ParsedIgnoreRules {
  readonly rules: readonly IgnoreRule[];
  readonly diagnostics: readonly IgnoreRuleDiagnostic[];
}

export type ExplicitSelection = "include" | "exclude" | undefined;

export interface IgnoreEvaluation {
  readonly projectId: ProjectId;
  readonly relativePath: string;
  readonly explicitSelection?: ExplicitSelection;
}

export interface IgnoreDecision {
  readonly excluded: boolean;
  readonly reason: "explicit_include" | "explicit_exclude" | "ignore_rule" | "none";
  readonly matchedLine?: number;
}

export function parseIgnoreRules(source: string): ParsedIgnoreRules {
  const rules: IgnoreRule[] = [];
  const diagnostics: IgnoreRuleDiagnostic[] = [];

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = index + 1;
    let pattern = rawLine.trim();
    if (pattern.length === 0 || pattern.startsWith("#")) {
      continue;
    }

    let action: IgnoreRuleAction = "exclude";
    if (pattern.startsWith("!")) {
      action = "include";
      pattern = pattern.slice(1);
      if (pattern.length === 0) {
        diagnostics.push({ line, code: "EMPTY_NEGATION" });
        continue;
      }
    }

    const diagnostic = validatePattern(pattern);
    if (diagnostic !== undefined) {
      diagnostics.push({ line, code: diagnostic });
      continue;
    }

    const matcher = compileGlob(pattern);
    rules.push({ line, pattern, action, matches: matcher });
  }

  return { rules, diagnostics };
}

export function isExcluded(
  input: IgnoreEvaluation,
  parsed: ParsedIgnoreRules,
): IgnoreDecision {
  if (input.explicitSelection === "include") {
    return { excluded: false, reason: "explicit_include" };
  }
  if (input.explicitSelection === "exclude") {
    return { excluded: true, reason: "explicit_exclude" };
  }

  const relativePath = normalizeRelativePath(input.relativePath);
  let matchedRule: IgnoreRule | undefined;
  for (const rule of parsed.rules) {
    if (rule.matches(relativePath)) {
      matchedRule = rule;
    }
  }

  if (matchedRule === undefined) {
    return { excluded: false, reason: "none" };
  }

  return {
    excluded: matchedRule.action === "exclude",
    reason: "ignore_rule",
    matchedLine: matchedRule.line,
  };
}

function validatePattern(pattern: string): IgnoreRuleDiagnosticCode | undefined {
  if (pattern.length > 1_024) {
    return "PATTERN_TOO_LONG";
  }
  if (isAbsolute(pattern) || /^[A-Za-z]:[\\/]/u.test(pattern)) {
    return "ABSOLUTE_PATTERN";
  }
  if (pattern.split(/[\\/]/u).includes("..")) {
    return "PARENT_TRAVERSAL";
  }
  if (/[\u0000-\u001f\u007f[\]{}]/u.test(pattern)) {
    return "UNSUPPORTED_PATTERN";
  }
  return undefined;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new TypeError("Ignore evaluation requires a safe project-relative path");
  }
  return normalized;
}

function compileGlob(input: string): (relativePath: string) => boolean {
  let pattern = input.replace(/\\/gu, "/");
  const anchored = pattern.startsWith("/");
  if (anchored) {
    pattern = pattern.slice(1);
  }
  const directoryPattern = pattern.endsWith("/");
  if (directoryPattern) {
    pattern = pattern.slice(0, -1);
  }
  const containsSlash = pattern.includes("/");
  const prefix = anchored || containsSlash ? "^" : "(?:^|.*/)";
  const suffix = directoryPattern ? "(?:/.*)?$" : "$";
  const expression = new RegExp(`${prefix}${globBody(pattern)}${suffix}`, "u");
  return (relativePath) => expression.test(relativePath);
}

function globBody(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          output += "(?:.*/)?";
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += escapeRegExp(character ?? "");
    }
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

