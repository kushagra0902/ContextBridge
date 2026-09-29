// Defines what directories under the home directory are safe to read and
// which are not. By default the codex/sessions directory is allowed 
// but the other directories are restricted.

import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { SourceKind } from "../contracts/source.js";

// Defines the config of source policy 
export interface SourcePolicyConfig {
  readonly codexHomes: readonly string[];
  readonly excludedRoots: readonly string[];
  readonly includeHistory: boolean;
  readonly includeSessionIndex: boolean;
}

export type SourceDenialReason =
  | "outside_codex_home"
  | "excluded_root"
  | "forbidden_name"
  | "unsupported_path"
  | "symbolic_link"
  | "not_found"
  | "not_file"
  | "unreadable";

export type SourcePolicyDecision =
  | {
      readonly allowed: true;
      readonly path: string;
      readonly codexHome: string;
      readonly sourceKind: SourceKind;
    }
  | {
      readonly allowed: false;
      readonly path: string;
      readonly reason: SourceDenialReason;
    };


// Defines the set of names that are directly and strictly forbidden, even inside the allowed directories, have to be restircted.
const FORBIDDEN_NAMES = new Set([
  "auth.json",
  "credentials.json",
  ".env",
  "id_rsa",
  "id_ed25519",
]);

// Gives a decision acc to set config and path etc. 
export async function canReadSource(
  candidatePath: string,
  config: SourcePolicyConfig,
): Promise<SourcePolicyDecision> {
  const candidate = resolve(candidatePath);
  const normalizedName = basename(candidate).toLowerCase();

  if (FORBIDDEN_NAMES.has(normalizedName)) {
    return deny(candidate, "forbidden_name");
  }

  if (
    config.excludedRoots.some((root) => isPathWithin(resolve(root), candidate))
  ) {
    return deny(candidate, "excluded_root");
  }

  const codexHome = config.codexHomes
    .map((home) => resolve(home))
    .find((home) => isPathWithin(home, candidate));
  if (codexHome === undefined) {
    return deny(candidate, "outside_codex_home");
  }

  const sourceKind = classifyKnownSource(candidate, codexHome, config);
  if (sourceKind === undefined) {
    return deny(candidate, "unsupported_path");
  }

  try {
    if (await containsSymbolicLink(codexHome, candidate)) {
      return deny(candidate, "symbolic_link");
    }

    const details = await lstat(candidate);
    if (!details.isFile()) {
      return deny(candidate, "not_file");
    }
    await access(candidate, constants.R_OK);
  } catch (error) {
    return deny(
      candidate,
      getErrorCode(error) === "ENOENT" ? "not_found" : "unreadable",
    );
  }

  return { allowed: true, path: candidate, codexHome, sourceKind };
}

function classifyKnownSource(
  candidate: string,
  codexHome: string,
  config: SourcePolicyConfig,
): SourceKind | undefined {
  const childPath = relative(codexHome, candidate).split(sep).join("/");

  if (childPath === "history.jsonl") {
    return config.includeHistory ? "codex_history" : undefined;
  }
  if (childPath === "session_index.jsonl") {
    return config.includeSessionIndex ? "codex_session_index" : undefined;
  }
  if (/^sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/u.test(childPath)) {
    return "codex_rollout";
  }
  return undefined;
}

async function containsSymbolicLink(
  root: string,
  candidate: string,
): Promise<boolean> {
  const childPath = relative(root, candidate);
  const parts = childPath.split(sep).filter((part) => part.length > 0);
  let current = root;

  const rootDetails = await lstat(root);
  if (rootDetails.isSymbolicLink()) {
    return true;
  }

  for (const part of parts) {
    current = resolve(current, part);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

function isPathWithin(root: string, candidate: string): boolean {
  const childPath = relative(root, candidate);
  return (
    childPath === "" ||
    (!childPath.startsWith(`..${sep}`) && childPath !== ".." && !isAbsolute(childPath))
  );
}

function deny(path: string, reason: SourceDenialReason): SourcePolicyDecision {
  return { allowed: false, path, reason };
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
