// This is a worker node that runs the regex acc to the rules provided and
// And it it gives the span of redaction to the main file
// who then actually redacts the text. 
// This specifically handles the arbitrary user given regexes other thatn the main engine.
// The main engine keeps on executing in the main process.

// The main reason is user defined explicit rule can be broken. 
// If used in the main process itself, it can result in timeouts and unnecessary

import { parentPort, workerData } from "node:worker_threads";

interface WorkerRule {
  readonly id: string;
  readonly pattern: string;
  readonly flags: string;
  readonly reason: "user_rule" | "policy";
}

interface RedactionWorkerInput {
  readonly text: string;
  readonly rules: readonly WorkerRule[];
  readonly maxMatches: number;
}

interface WorkerMatch {
  readonly start: number;
  readonly end: number;
  readonly reason: "user_rule" | "policy";
}

const input = workerData as RedactionWorkerInput; // as is used to convert a data type into other defined by an interface. 
const matches: WorkerMatch[] = [];
const rejectedRuleIds: string[] = [];
let limitReached = false;

for (const rule of input.rules) {
  if (matches.length >= input.maxMatches) {
    limitReached = true;
    break;
  }

  try {
    const expression = new RegExp(rule.pattern, `${rule.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = expression.exec(input.text)) !== null) {
      if (match[0].length === 0) {
        expression.lastIndex += 1;
        continue;
      }
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        reason: rule.reason,
      });
      if (matches.length >= input.maxMatches) {
        limitReached = true;
        break;
      }
    }
  } catch {
    rejectedRuleIds.push(rule.id);
  }
}

parentPort?.postMessage({ matches, rejectedRuleIds, limitReached });

