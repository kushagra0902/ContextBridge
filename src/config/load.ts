// Actually read the config, parses it, validates it acc to the defined schema in schema.ts, 
// and makes objects of the config after parsing for use. 

import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { TomlTableWithoutBigInt } from "smol-toml";
import { ZodError } from "zod";

import {
  type ContextBridgeConfig,
  ConfigVersionError,
  parseConfig,
} from "./schema.js";

import {
  ensurePrivateDirectory,
  resolveAppDataPaths,
} from "./paths.js";

const MAX_CONFIG_BYTES = 1_048_576;

export type ConfigFileErrorCode =
  | "CONFIG_TOO_LARGE"
  | "CONFIG_PARSE_FAILED"
  | "CONFIG_VALIDATION_FAILED"
  | "CONFIG_READ_FAILED"
  | "CONFIG_WRITE_FAILED";

export class ConfigFileError extends Error {
  readonly code: ConfigFileErrorCode;
  readonly configPath: string;
  readonly issues?: readonly string[];

  constructor(
    code: ConfigFileErrorCode,
    message: string,
    configPath: string,
    options?: ErrorOptions & { readonly issues?: readonly string[] },
  ) {
    super(message, options);
    this.name = "ConfigFileError";
    this.code = code;
    this.configPath = configPath;
    if (options?.issues !== undefined) {
      this.issues = options.issues;
    }
  }
}

export async function loadConfig(configPath?: string): Promise<ContextBridgeConfig> {
  const resolvedPath = resolveConfigPath(configPath);
  let source: string;

  try {
    const configStat = await stat(resolvedPath);
    if (configStat.size > MAX_CONFIG_BYTES) {
      throw new ConfigFileError(
        "CONFIG_TOO_LARGE",
        `Configuration exceeds ${MAX_CONFIG_BYTES} bytes`,
        resolvedPath,
      );
    }
    const contents = await readFile(resolvedPath);
    if (contents.byteLength > MAX_CONFIG_BYTES) {
      throw new ConfigFileError(
        "CONFIG_TOO_LARGE",
        `Configuration exceeds ${MAX_CONFIG_BYTES} bytes`,
        resolvedPath,
      );
    }
    source = contents.toString("utf8");
  } catch (error) {
    if (error instanceof ConfigFileError) {
      throw error;
    }
    if (getErrorCode(error) === "ENOENT") {
      return parseConfig({ version: 1 });
    }
    throw new ConfigFileError(
      "CONFIG_READ_FAILED",
      "Unable to read configuration",
      resolvedPath,
      { cause: error },
    );
  }

  return parseConfigToml(source, resolvedPath);
}

export function parseConfigToml(
  source: string,
  configPath = "<memory>",
): ContextBridgeConfig {
  let raw: unknown;
  try {
    raw = parseToml(source);
  } catch (error) {
    throw new ConfigFileError(
      "CONFIG_PARSE_FAILED",
      "Configuration is not valid TOML",
      configPath,
      { cause: error },
    );
  }

  try {
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigFileError(
        "CONFIG_VALIDATION_FAILED",
        "Configuration does not match the supported schema",
        configPath,
        {
          cause: error,
          issues: error.issues.map(
            (issue) => `${issue.path.join(".") || "config"}: ${issue.message}`,
          ),
        },
      );
    }
    if (error instanceof ConfigVersionError) {
      throw new ConfigFileError(
        "CONFIG_VALIDATION_FAILED",
        error.message,
        configPath,
        { cause: error },
      );
    }
    throw error;
  }
}

export function stringifyConfig(config: ContextBridgeConfig): string {
  const validated = parseConfig(config);
  const serialized = stringifyToml(
    validated as unknown as TomlTableWithoutBigInt,
  );
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

export async function saveConfigAtomically(
  config: ContextBridgeConfig,
  configPath?: string,
): Promise<string> {
  const resolvedPath = resolveConfigPath(configPath);
  const platform = process.platform;
  const parent = dirname(resolvedPath);
  const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = stringifyConfig(config);
  let temporaryCreated = false;

  try {
    await ensurePrivateDirectory(parent, platform);
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, resolvedPath);
    temporaryCreated = false;
    if (platform !== "win32") {
      await chmod(resolvedPath, 0o600);
      await syncDirectory(parent);
    }
    return resolvedPath;
  } catch (error) {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    if (error instanceof ConfigFileError) {
      throw error;
    }
    throw new ConfigFileError(
      "CONFIG_WRITE_FAILED",
      "Unable to save configuration atomically",
      resolvedPath,
      { cause: error },
    );
  }
}

function resolveConfigPath(configPath: string | undefined): string {
  return resolveAppDataPaths(
    configPath === undefined ? {} : { configFile: configPath },
  ).configFile;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
