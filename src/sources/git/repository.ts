import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  normalizeGitRemote,
  type NormalizedGitRemote,
} from "./remote.js";

export interface RepositoryRemote {
  readonly name: string;
  readonly remote: NormalizedGitRemote;
}

export interface RepositorySnapshot {
  /** Canonical worktree root. Kept local and never returned through MCP. */
  readonly root: string;
  /** Shared Git directory, useful for recognizing linked worktrees. */
  readonly commonDirectory: string;
  readonly remotes: readonly RepositoryRemote[];
  readonly primaryRemote?: RepositoryRemote;
  readonly branch?: string;
  readonly headCommit?: string;
}

export type RepositoryInspectionDiagnosticCode =
  | "COMMON_DIRECTORY_UNAVAILABLE"
  | "HEAD_UNAVAILABLE"
  | "REMOTE_LIST_UNAVAILABLE"
  | "REMOTE_READ_UNAVAILABLE"
  | "REMOTE_REJECTED";

export interface RepositoryInspectionDiagnostic {
  readonly code: RepositoryInspectionDiagnosticCode;
  readonly remoteName?: string;
}

export type RepositoryInspection =
  | {
      readonly status: "ok";
      readonly repository: RepositorySnapshot;
      readonly diagnostics: readonly RepositoryInspectionDiagnostic[];
    }
  | {
      readonly status:
        | "not_found"
        | "not_directory"
        | "not_repository"
        | "unreadable"
        | "timeout"
        | "git_unavailable";
      readonly diagnostics: readonly RepositoryInspectionDiagnostic[];
    };

export interface InspectRepositoryOptions {
  readonly timeoutMs?: number;
  readonly gitBinary?: string;
  readonly maxRemotes?: number;
}

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_REMOTES = 32;
const MAX_STDOUT_BYTES = 256 * 1_024;

/** Runs read-only Git plumbing commands under one overall deadline. */
export async function inspectRepository(
  cwd: string,
  options: InspectRepositoryOptions = {},
): Promise<RepositoryInspection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRemotes = options.maxRemotes ?? DEFAULT_MAX_REMOTES;
  const gitBinary = options.gitBinary ?? "git";
  validateOptions(cwd, timeoutMs, maxRemotes, gitBinary);

  let cwdDetails;
  try {
    cwdDetails = await stat(cwd);
  } catch (error) {
    return {
      status: getErrorCode(error) === "ENOENT" ? "not_found" : "unreadable",
      diagnostics: [],
    };
  }
  if (!cwdDetails.isDirectory()) {
    return { status: "not_directory", diagnostics: [] };
  }

  const deadline = Date.now() + timeoutMs;
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    return { status: "unreadable", diagnostics: [] };
  }

  let rootResult: GitResult;
  try {
    rootResult = await runGit(
      gitBinary,
      canonicalCwd,
      ["rev-parse", "--show-toplevel"],
      deadline,
    );
  } catch (error) {
    return failedInspection(error);
  }
  if (!rootResult.ok) {
    return { status: "not_repository", diagnostics: [] };
  }

  const rootOutput = singleOutputLine(rootResult.stdout);
  if (rootOutput === undefined) {
    return { status: "unreadable", diagnostics: [] };
  }
  let root: string;
  try {
    root = await realpath(rootOutput);
  } catch {
    return { status: "unreadable", diagnostics: [] };
  }

  const diagnostics: RepositoryInspectionDiagnostic[] = [];
  let commonDirectory = root;
  try {
    const commonResult = await runGit(
      gitBinary,
      canonicalCwd,
      ["rev-parse", "--git-common-dir"],
      deadline,
    );
    const commonOutput = commonResult.ok
      ? singleOutputLine(commonResult.stdout)
      : undefined;
    if (commonOutput === undefined) {
      diagnostics.push({ code: "COMMON_DIRECTORY_UNAVAILABLE" });
    } else {
      const commonPath = isAbsolute(commonOutput)
        ? commonOutput
        : resolve(canonicalCwd, commonOutput);
      commonDirectory = await realpath(commonPath).catch(() => commonPath);
    }
  } catch (error) {
    if (isFatalGitFailure(error)) return failedInspection(error);
    diagnostics.push({ code: "COMMON_DIRECTORY_UNAVAILABLE" });
  }

  let branch: string | undefined;
  try {
    const branchResult = await runGit(
      gitBinary,
      canonicalCwd,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      deadline,
    );
    branch = branchResult.ok ? safeReference(branchResult.stdout) : undefined;
  } catch (error) {
    if (isFatalGitFailure(error)) return failedInspection(error);
  }

  let headCommit: string | undefined;
  try {
    const headResult = await runGit(
      gitBinary,
      canonicalCwd,
      ["rev-parse", "--verify", "HEAD"],
      deadline,
    );
    const candidate = headResult.ok ? singleOutputLine(headResult.stdout) : undefined;
    if (candidate !== undefined && /^[0-9a-f]{40,64}$/iu.test(candidate)) {
      headCommit = candidate.toLowerCase();
    } else {
      diagnostics.push({ code: "HEAD_UNAVAILABLE" });
    }
  } catch (error) {
    if (isFatalGitFailure(error)) return failedInspection(error);
    diagnostics.push({ code: "HEAD_UNAVAILABLE" });
  }

  let remoteNames: readonly string[] = [];
  try {
    const remoteList = await runGit(
      gitBinary,
      canonicalCwd,
      ["remote"],
      deadline,
    );
    if (remoteList.ok) {
      remoteNames = outputLines(remoteList.stdout)
        .filter(isSafeRemoteName)
        .slice(0, maxRemotes);
    } else {
      diagnostics.push({ code: "REMOTE_LIST_UNAVAILABLE" });
    }
  } catch (error) {
    if (isFatalGitFailure(error)) return failedInspection(error);
    diagnostics.push({ code: "REMOTE_LIST_UNAVAILABLE" });
  }

  const remotes: RepositoryRemote[] = [];
  const seenRemoteKeys = new Set<string>();
  for (const name of remoteNames) {
    try {
      const remoteResult = await runGit(
        gitBinary,
        canonicalCwd,
        ["remote", "get-url", "--all", name],
        deadline,
      );
      if (!remoteResult.ok) {
        diagnostics.push({ code: "REMOTE_READ_UNAVAILABLE", remoteName: name });
        continue;
      }
      for (const url of outputLines(remoteResult.stdout)) {
        const normalized = normalizeGitRemote(url);
        if (!normalized.ok) {
          diagnostics.push({ code: "REMOTE_REJECTED", remoteName: name });
          continue;
        }
        const key = `${name}:${normalized.remote.canonical}`;
        if (seenRemoteKeys.has(key)) continue;
        seenRemoteKeys.add(key);
        remotes.push({ name, remote: normalized.remote });
      }
    } catch (error) {
      if (isFatalGitFailure(error)) return failedInspection(error);
      diagnostics.push({ code: "REMOTE_READ_UNAVAILABLE", remoteName: name });
    }
  }

  const primaryRemote = selectPrimaryRemote(remotes);
  return {
    status: "ok",
    repository: {
      root,
      commonDirectory,
      remotes,
      ...(primaryRemote === undefined ? {} : { primaryRemote }),
      ...(branch === undefined ? {} : { branch }),
      ...(headCommit === undefined ? {} : { headCommit }),
    },
    diagnostics,
  };
}

function runGit(
  binary: string,
  cwd: string,
  arguments_: readonly string[],
  deadline: number,
): Promise<GitResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new GitExecutionError("timeout"));
  }

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["-C", cwd, ...arguments_],
      {
        encoding: "utf8",
        timeout: remaining,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ ok: true, stdout });
          return;
        }
        const code = getErrorCode(error);
        if (code === "ENOENT") {
          reject(new GitExecutionError("git_unavailable"));
          return;
        }
        if (
          error.killed ||
          (error.signal !== undefined && error.signal !== null) ||
          code === "ETIMEDOUT"
        ) {
          reject(new GitExecutionError("timeout"));
          return;
        }
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new GitExecutionError("unreadable"));
          return;
        }
        resolve({ ok: false, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
  });
}

class GitExecutionError extends Error {
  constructor(
    readonly kind: "timeout" | "git_unavailable" | "unreadable",
  ) {
    super("Git inspection failed");
    this.name = "GitExecutionError";
  }
}

function failedInspection(error: unknown): RepositoryInspection {
  if (error instanceof GitExecutionError) {
    return { status: error.kind, diagnostics: [] };
  }
  return { status: "unreadable", diagnostics: [] };
}

function isFatalGitFailure(error: unknown): boolean {
  return error instanceof GitExecutionError;
}

function selectPrimaryRemote(
  remotes: readonly RepositoryRemote[],
): RepositoryRemote | undefined {
  return (
    remotes.find((entry) => entry.name === "origin") ??
    remotes.find((entry) => entry.name === "upstream") ??
    [...remotes].sort((left, right) =>
      left.name.localeCompare(right.name),
    )[0]
  );
}

function outputLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function singleOutputLine(value: string): string | undefined {
  const lines = outputLines(value);
  return lines.length === 1 && lines[0] !== undefined && lines[0].length <= 4_096
    ? lines[0]
    : undefined;
}

function safeReference(value: string): string | undefined {
  const reference = singleOutputLine(value);
  return reference !== undefined &&
    reference.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(reference)
    ? reference
    : undefined;
}

function isSafeRemoteName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u0020\u007f~^:?*[\\]/u.test(value)
  );
}

function validateOptions(
  cwd: string,
  timeoutMs: number,
  maxRemotes: number,
  gitBinary: string,
): void {
  if (
    cwd.length === 0 ||
    cwd.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(cwd) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxRemotes) ||
    maxRemotes < 1 ||
    maxRemotes > 128 ||
    gitBinary.length === 0 ||
    gitBinary.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(gitBinary)
  ) {
    throw new RangeError("Invalid repository inspection options");
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
  ) {
    return String(error.code);
  }
  return undefined;
}
