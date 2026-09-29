// Main redaction engine/orchestrator
// This is used by redation-worker to redact at appropraite places.

import { Worker } from "node:worker_threads";

import type { RedactionSpan } from "../contracts/evidence.js";

export type UserRedactionRule =
  | {
      readonly id: string;
      readonly kind: "literal";
      readonly value: string;
      readonly reason?: "user_rule" | "policy";
    }
  | {
      readonly id: string;
      readonly kind: "regex";
      readonly pattern: string;
      readonly flags?: string;
      readonly reason?: "user_rule" | "policy";
    };

export interface RedactionOptions {
  readonly maxInputCharacters?: number;
  readonly maxMatches?: number;
  readonly regexTimeoutMs?: number;
  readonly placeholder?: string;
}

export type RedactionWarningCode =
  | "RULE_REJECTED"
  | "REGEX_TIMEOUT"
  | "MATCH_LIMIT_REACHED";

export interface RedactionWarning {
  readonly code: RedactionWarningCode;
  readonly ruleId?: string;
}

export interface RedactionResult {
  readonly text: string;
  /** Spans refer to offsets in the returned redacted text. */
  readonly spans: readonly RedactionSpan[];
  readonly redactionCount: number;
  readonly warnings: readonly RedactionWarning[];
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly reason: RedactionSpan["reason"];
}

const DEFAULT_MAX_INPUT_CHARACTERS = 1_048_576;
const DEFAULT_MAX_MATCHES = 10_000;
const DEFAULT_REGEX_TIMEOUT_MS = 500;
const DEFAULT_PLACEHOLDER = "[REDACTED]";

const BUILTIN_PATTERNS: ReadonlyArray<{
  readonly expression: RegExp;
  readonly reason: RedactionSpan["reason"];
}> = [
  {
    expression:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{0,65536}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    reason: "credential",
  },
  {
    expression: /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
    reason: "credential",
  },
  {
    expression: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/gu,
    reason: "credential",
  },
  {
    expression: /\bAKIA[A-Z0-9]{16}\b/gu,
    reason: "credential",
  },
  {
    expression: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
    reason: "credential",
  },
  {
    expression: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/gu,
    reason: "credential",
  },
  {
    expression: /\bAIza[A-Za-z0-9_-]{30,}\b/gu,
    reason: "credential",
  },
  {
    expression: /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}/giu,
    reason: "credential",
  },
  {
    expression:
      /\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\b\s*[:=]\s*["']?[^\s"',;]{8,}/giu,
    reason: "secret",
  },
  {
    expression: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/giu,
    reason: "credential",
  },
  {
    expression:
      /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9/+]{40}["']?/giu,
    reason: "secret",
  },
];

export class RedactionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedactionLimitError";
  }
}

export async function redactText(
  text: string,
  rules: readonly UserRedactionRule[] = [],
  options: RedactionOptions = {},
): Promise<RedactionResult> {
  const maxInputCharacters =
    options.maxInputCharacters ?? DEFAULT_MAX_INPUT_CHARACTERS;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const regexTimeoutMs = options.regexTimeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS;
  const placeholder = options.placeholder ?? DEFAULT_PLACEHOLDER;

  if (
    !Number.isSafeInteger(maxInputCharacters) ||
    maxInputCharacters < 1 ||
    maxInputCharacters > 16_777_216 ||
    !Number.isSafeInteger(maxMatches) ||
    maxMatches < 1 ||
    maxMatches > 100_000 ||
    !Number.isSafeInteger(regexTimeoutMs) ||
    regexTimeoutMs < 10 ||
    regexTimeoutMs > 5_000
  ) {
    throw new RedactionLimitError("Invalid redaction limits");
  }
  if (text.length > maxInputCharacters) {
    throw new RedactionLimitError("Text exceeds the redaction input limit");
  }
  if (rules.length > 32) {
    throw new RedactionLimitError("Too many user redaction rules");
  }
  if (placeholder.length === 0 || placeholder.length > 64) {
    throw new RedactionLimitError("Invalid redaction placeholder");
  }

  const matches = collectBuiltinMatches(text, maxMatches);
  const warnings: RedactionWarning[] = [];
  assertMatchCapacity(matches.length, maxMatches);
  collectLiteralMatches(text, rules, matches, warnings, maxMatches);
  assertMatchCapacity(matches.length, maxMatches);

  const remaining = Math.max(0, maxMatches - matches.length);
  const regexRules = validateRegexRules(rules, warnings);
  if (regexRules.length > 0 && remaining > 0) {
    const workerResult = await collectRegexMatches(
      text,
      regexRules,
      remaining,
      regexTimeoutMs,
    );
    matches.push(...workerResult.matches);
    warnings.push(...workerResult.warnings);
    if (
      workerResult.warnings.some(
        (warning) =>
          warning.code === "REGEX_TIMEOUT" ||
          warning.code === "MATCH_LIMIT_REACHED" ||
          (warning.code === "RULE_REJECTED" && warning.ruleId === undefined),
      )
    ) {
      throw new RedactionLimitError("User regex redaction could not complete safely");
    }
  }

  assertMatchCapacity(matches.length, maxMatches);

  return applyMatches(text, matches, placeholder, deduplicateWarnings(warnings));
}

function collectBuiltinMatches(text: string, maxMatches: number): Match[] {
  const matches: Match[] = [];
  for (const pattern of BUILTIN_PATTERNS) {
    pattern.expression.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.expression.exec(text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        reason: pattern.reason,
      });
      if (matches.length >= maxMatches) {
        return matches;
      }
    }
  }
  return matches;
}

function collectLiteralMatches(
  text: string,
  rules: readonly UserRedactionRule[],
  matches: Match[],
  warnings: RedactionWarning[],
  maxMatches: number,
): void {
  for (const rule of rules) {
    if (rule.kind !== "literal") {
      continue;
    }
    if (
      !isValidRuleId(rule.id) ||
      rule.value.length === 0 ||
      rule.value.length > 512
    ) {
      warnings.push({ code: "RULE_REJECTED", ruleId: rule.id });
      continue;
    }

    let offset = 0;
    while (matches.length < maxMatches) {
      const index = text.indexOf(rule.value, offset);
      if (index === -1) {
        break;
      }
      matches.push({
        start: index,
        end: index + rule.value.length,
        reason: rule.reason ?? "user_rule",
      });
      offset = index + rule.value.length;
    }
  }
}

function validateRegexRules(
  rules: readonly UserRedactionRule[],
  warnings: RedactionWarning[],
): ReadonlyArray<{
  readonly id: string;
  readonly pattern: string;
  readonly flags: string;
  readonly reason: "user_rule" | "policy";
}> {
  const valid = [];
  for (const rule of rules) {
    if (rule.kind !== "regex") {
      continue;
    }
    const flags = rule.flags ?? "u";
    if (
      !isValidRuleId(rule.id) ||
      rule.pattern.length === 0 ||
      rule.pattern.length > 512 ||
      /[^imsu]/u.test(flags) ||
      new Set(flags).size !== flags.length
    ) {
      warnings.push({ code: "RULE_REJECTED", ruleId: rule.id });
      continue;
    }
    valid.push({
      id: rule.id,
      pattern: rule.pattern,
      flags,
      reason: rule.reason ?? "user_rule",
    });
  }
  return valid;
}

async function collectRegexMatches(
  text: string,
  rules: ReturnType<typeof validateRegexRules>,
  maxMatches: number,
  timeoutMs: number,
): Promise<{
  readonly matches: readonly Match[];
  readonly warnings: readonly RedactionWarning[];
}> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./redact-worker.js", import.meta.url), {
      workerData: { text, rules, maxMatches },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    let settled = false;
    const finish = (result: {
      readonly matches: readonly Match[];
      readonly warnings: readonly RedactionWarning[];
    }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ matches: [], warnings: [{ code: "REGEX_TIMEOUT" }] });
    }, timeoutMs);

    worker.once(
      "message",
      (message: {
        readonly matches: readonly Match[];
        readonly rejectedRuleIds: readonly string[];
        readonly limitReached: boolean;
      }) => {
        finish({
          matches: message.matches,
          warnings: [
            ...message.rejectedRuleIds.map((ruleId) => ({
              code: "RULE_REJECTED" as const,
              ruleId,
            })),
            ...(message.limitReached
              ? [{ code: "MATCH_LIMIT_REACHED" as const }]
              : []),
          ],
        });
      },
    );
    worker.once("error", () => {
      finish({ matches: [], warnings: [{ code: "RULE_REJECTED" }] });
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish({ matches: [], warnings: [{ code: "RULE_REJECTED" }] });
      }
    });
  });
}

function assertMatchCapacity(count: number, maximum: number): void {
  if (count >= maximum) {
    throw new RedactionLimitError("Redaction match limit reached");
  }
}

function isValidRuleId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function applyMatches(
  text: string,
  matches: readonly Match[],
  placeholder: string,
  warnings: readonly RedactionWarning[],
): RedactionResult {
  const merged = mergeMatches(matches);
  const parts: string[] = [];
  const spans: RedactionSpan[] = [];
  let sourceOffset = 0;
  let outputLength = 0;

  for (const match of merged) {
    const prefix = text.slice(sourceOffset, match.start);
    parts.push(prefix, placeholder);
    outputLength += prefix.length;
    spans.push({
      start: outputLength,
      end: outputLength + placeholder.length,
      reason: match.reason,
    });
    outputLength += placeholder.length;
    sourceOffset = match.end;
  }
  parts.push(text.slice(sourceOffset));

  return {
    text: parts.join(""),
    spans,
    redactionCount: merged.length,
    warnings,
  };
}

function mergeMatches(matches: readonly Match[]): Match[] {
  const sorted = [...matches]
    .filter((match) => match.start >= 0 && match.end > match.start)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Match[] = [];

  for (const match of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || match.start >= previous.end) {
      merged.push(match);
      continue;
    }
    merged[merged.length - 1] = {
      start: previous.start,
      end: Math.max(previous.end, match.end),
      reason:
        reasonPriority(match.reason) > reasonPriority(previous.reason)
          ? match.reason
          : previous.reason,
    };
  }
  return merged;
}

function reasonPriority(reason: RedactionSpan["reason"]): number {
  switch (reason) {
    case "credential":
      return 4;
    case "secret":
      return 3;
    case "policy":
      return 2;
    case "user_rule":
      return 1;
  }
}

function deduplicateWarnings(
  warnings: readonly RedactionWarning[],
): readonly RedactionWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.ruleId ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
