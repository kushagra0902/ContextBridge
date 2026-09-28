// This file actually connects the paths defined to the actual OS paths usign system libraries.

import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, stat } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import { posix, win32 } from "node:path";

export interface AppPathOverrides {
  readonly configDir?: string;
  readonly configFile?: string;
  readonly dataDir?: string;
  readonly cacheDir?: string;
  readonly modelCacheDir?: string;
  readonly logsDir?: string;
  readonly exportsDir?: string;
}

export interface PathResolutionContext {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

export interface AppDataPaths {
  readonly platform: NodeJS.Platform;
  readonly configDir: string;
  readonly configFile: string;
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly objectsDir: string;
  readonly vectorDir: string;
  readonly cacheDir: string;
  readonly modelCacheDir: string;
  readonly stateDir: string;
  readonly logsDir: string;
  readonly exportsDir: string;
}

export type CodexHomeSource = "configured" | "environment" | "default";

export type CodexHomeDiagnosticCode =
  | "CODEX_HOME_NOT_FOUND"
  | "CODEX_HOME_NOT_DIRECTORY"
  | "CODEX_HOME_UNREADABLE"
  | "NO_AVAILABLE_CODEX_HOME";

export interface CodexHomeDiagnostic {
  readonly code: CodexHomeDiagnosticCode;
  readonly path?: string;
}

export interface CodexHomeResolution {
  readonly source: CodexHomeSource;
  readonly homes: readonly string[];
  readonly diagnostics: readonly CodexHomeDiagnostic[];
}

export interface ResolveCodexHomesOptions extends PathResolutionContext {
  readonly configuredHomes?: readonly string[];
}

export interface PrivateDirectoryState {
  readonly path: string;
  readonly enforcement: "posix_mode_0700" | "user_profile_boundary";
}

export function resolveAppDataPaths(
  overrides: AppPathOverrides = {},
  context: PathResolutionContext = {},
): AppDataPaths {
  const platform = context.platform ?? currentPlatform();
  const env = context.env ?? process.env;
  const home = context.homeDir ?? resolveHome(platform, env);
  const pathApi = platform === "win32" ? win32 : posix;

  let defaultConfigDir: string;
  let defaultDataDir: string;
  let defaultCacheDir: string;
  let defaultStateDir: string;
  let defaultLogsDir: string;

  if (platform === "win32") {
    const roaming = env.APPDATA ?? pathApi.join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local");
    defaultConfigDir = pathApi.join(roaming, "ContextBridge");
    defaultDataDir = pathApi.join(local, "ContextBridge");
    defaultCacheDir = pathApi.join(local, "ContextBridge", "cache");
    defaultStateDir = pathApi.join(local, "ContextBridge", "state");
    defaultLogsDir = pathApi.join(defaultStateDir, "logs");
  } else if (platform === "darwin") {
    defaultConfigDir = pathApi.join(
      home,
      "Library",
      "Application Support",
      "ContextBridge",
    );
    defaultDataDir = defaultConfigDir;
    defaultCacheDir = pathApi.join(home, "Library", "Caches", "ContextBridge");
    defaultStateDir = pathApi.join(
      home,
      "Library",
      "Application Support",
      "ContextBridge",
      "state",
    );
    defaultLogsDir = pathApi.join(home, "Library", "Logs", "ContextBridge");
  } else {
    defaultConfigDir = pathApi.join(
      absoluteEnvironmentPath(env.XDG_CONFIG_HOME, pathApi, home) ??
        pathApi.join(home, ".config"),
      "context-bridge",
    );
    defaultDataDir = pathApi.join(
      absoluteEnvironmentPath(env.XDG_DATA_HOME, pathApi, home) ??
        pathApi.join(home, ".local", "share"),
      "context-bridge",
    );
    defaultCacheDir = pathApi.join(
      absoluteEnvironmentPath(env.XDG_CACHE_HOME, pathApi, home) ??
        pathApi.join(home, ".cache"),
      "context-bridge",
    );
    defaultStateDir = pathApi.join(
      absoluteEnvironmentPath(env.XDG_STATE_HOME, pathApi, home) ??
        pathApi.join(home, ".local", "state"),
      "context-bridge",
    );
    defaultLogsDir = pathApi.join(defaultStateDir, "logs");
  }

  const configuredConfigDir = resolvePath(
    overrides.configDir,
    defaultConfigDir,
    home,
    pathApi,
  );
  const configFile = resolvePath(
    overrides.configFile,
    pathApi.join(configuredConfigDir, "config.toml"),
    home,
    pathApi,
  );
  const configDir = pathApi.dirname(configFile);
  const dataDir = resolvePath(overrides.dataDir, defaultDataDir, home, pathApi);
  const cacheDir = resolvePath(overrides.cacheDir, defaultCacheDir, home, pathApi);
  const stateDir = defaultStateDir;

  return {
    platform,
    configDir,
    configFile,
    dataDir,
    databaseFile: pathApi.join(dataDir, "context-bridge.sqlite"),
    objectsDir: pathApi.join(dataDir, "objects"),
    vectorDir: pathApi.join(dataDir, "vectors"),
    cacheDir,
    modelCacheDir: resolvePath(
      overrides.modelCacheDir,
      pathApi.join(cacheDir, "models"),
      home,
      pathApi,
    ),
    stateDir,
    logsDir: resolvePath(
      overrides.logsDir,
      defaultLogsDir,
      home,
      pathApi,
    ),
    exportsDir: resolvePath(
      overrides.exportsDir,
      pathApi.join(dataDir, "exports"),
      home,
      pathApi,
    ),
  };
}

export async function resolveCodexHomes(
  options: ResolveCodexHomesOptions = {},
): Promise<CodexHomeResolution> {
  const platform = options.platform ?? currentPlatform();
  const env = options.env ?? process.env;
  const home = options.homeDir ?? resolveHome(platform, env);
  const pathApi = platform === "win32" ? win32 : posix;

  const configured = options.configuredHomes?.filter(
    (candidate) => candidate.trim().length > 0,
  );
  const environmentHome = env.CODEX_HOME?.trim();
  const source: CodexHomeSource =
    configured !== undefined && configured.length > 0
      ? "configured"
      : environmentHome !== undefined && environmentHome.length > 0
        ? "environment"
        : "default";
  const candidates =
    source === "configured"
      ? configured ?? []
      : source === "environment"
        ? [environmentHome as string]
        : [pathApi.join(home, ".codex")];

  const homes: string[] = [];
  const diagnostics: CodexHomeDiagnostic[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const resolved = resolvePath(candidate, candidate, home, pathApi);
    const key = platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    try {
      const candidateStat = await stat(resolved);
      if (!candidateStat.isDirectory()) {
        diagnostics.push({ code: "CODEX_HOME_NOT_DIRECTORY", path: resolved });
        continue;
      }
      await access(resolved, constants.R_OK);
      homes.push(resolved);
    } catch (error) {
      const code = getErrorCode(error);
      diagnostics.push({
        code:
          code === "ENOENT"
            ? "CODEX_HOME_NOT_FOUND"
            : "CODEX_HOME_UNREADABLE",
        path: resolved,
      });
    }
  }

  if (homes.length === 0) {
    diagnostics.push({ code: "NO_AVAILABLE_CODEX_HOME" });
  }

  return { source, homes, diagnostics };
}

export async function ensurePrivateDirectories(
  paths: AppDataPaths,
): Promise<readonly PrivateDirectoryState[]> {
  const directories = [
    paths.configDir,
    paths.dataDir,
    paths.objectsDir,
    paths.vectorDir,
    paths.cacheDir,
    paths.modelCacheDir,
    paths.stateDir,
    paths.logsDir,
    paths.exportsDir,
  ];
  const results: PrivateDirectoryState[] = [];

  for (const directory of new Set(directories)) {
    results.push(await ensurePrivateDirectory(directory, paths.platform));
  }

  return results;
}

export async function ensurePrivateDirectory(
  directory: string,
  platform: NodeJS.Platform = currentPlatform(),
): Promise<PrivateDirectoryState> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);

  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Private state path is not a real directory: ${directory}`);
  }

  if (platform !== "win32") {
    await chmod(directory, 0o700);
    return { path: directory, enforcement: "posix_mode_0700" };
  }

  return { path: directory, enforcement: "user_profile_boundary" };
}

function resolveHome(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return (
    (platform === "win32" ? env.USERPROFILE : env.HOME) ??
    env.HOME ??
    homedir()
  );
}

function absoluteEnvironmentPath(
  value: string | undefined,
  pathApi: typeof posix | typeof win32,
  home: string,
): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const expanded = expandHome(value, home, pathApi);
  return pathApi.isAbsolute(expanded) ? pathApi.normalize(expanded) : undefined;
}

function resolvePath(
  value: string | undefined,
  fallback: string,
  home: string,
  pathApi: typeof posix | typeof win32,
): string {
  const expanded = expandHome(value ?? fallback, home, pathApi);
  return pathApi.resolve(expanded);
}

function expandHome(
  value: string,
  home: string,
  pathApi: typeof posix | typeof win32,
): string {
  if (value === "~") {
    return home;
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return pathApi.join(home, value.slice(2));
  }

  return value;
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
