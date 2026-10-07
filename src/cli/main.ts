import {
  optionBoolean,
  optionString,
  parseCliArguments,
  type ParsedCliArguments,
} from "./arguments.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runExportCommand } from "./commands/export.js";
import { runForgetCommand } from "./commands/forget.js";
import { runIndexCommand } from "./commands/index.js";
import { runInitCommand } from "./commands/init.js";
import { runInspectCommand } from "./commands/inspect.js";
import { runOverviewCommand } from "./commands/overview.js";
import { runReindexCommand } from "./commands/reindex.js";
import { runScopesCommand } from "./commands/scopes.js";
import { runSearchCommand } from "./commands/search.js";
import { runServeCommand } from "./commands/serve.js";
import { runServiceCommand } from "./commands/service.js";
import { runSourcesCommand } from "./commands/sources.js";
import { renderCliError, renderCliResult } from "./render.js";
import {
  CliUsageError,
  type CliApplication,
  type CliApplicationOptions,
  type CliIo,
} from "./types.js";

export const CLI_VERSION = "0.0.0";
const COMMANDS = new Set([
  "init", "sources", "index", "scopes", "overview", "search", "inspect",
  "doctor", "service", "reindex", "forget", "export", "serve",
]);

export const CLI_HELP = `context-bridge <command> [options]

Read commands:
  scopes [query] [--limit N]
  overview --project ID [--workstream ID] [--session ID]
  search <query> [--project ID | --scope-query NAME] [--limit N]
  inspect <event-or-chunk-id>... [--before N] [--after N]

Local workflow:
  init [--codex-home PATH]... [--include-project ID | --exclude-project ID]...
  sources
  index [--initial]
  doctor
  serve <--stdio|--foreground>

Maintenance:
  reindex --project ID [--workstream ID] [--session ID]
  forget --project ID [--workstream ID] [--session ID] --yes
  export --project ID [--output FILE]
  service <install|uninstall|start|stop|status>

Global options: --config FILE --json --help --version
`;

export interface RunCliDependencies {
  readonly createApplication?: (options: CliApplicationOptions) => Promise<CliApplication>;
  readonly io?: CliIo;
}

export async function runCli(
  argv: readonly string[],
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? { stdout: process.stdout, stderr: process.stderr };
  let parsed: ParsedCliArguments;
  try {
    parsed = parseCliArguments(argv);
  } catch (error) {
    return writeFailure(error, false, io);
  }
  let json: boolean;
  try {
    json = optionBoolean(parsed, "json");
    if (parsed.options.has("help")) optionBoolean(parsed, "help");
    if (parsed.options.has("version")) optionBoolean(parsed, "version");
  } catch (error) {
    return writeFailure(error, false, io);
  }
  if (parsed.options.has("version") || parsed.command === "version") {
    io.stdout.write(json ? renderCliResult({ version: CLI_VERSION }, true) : `${CLI_VERSION}\n`);
    return 0;
  }
  if (parsed.command === undefined || parsed.options.has("help") || parsed.command === "help") {
    io.stdout.write(json ? renderCliResult({ help: CLI_HELP }, true) : CLI_HELP);
    return 0;
  }
  if (!COMMANDS.has(parsed.command)) {
    return writeFailure(new CliUsageError(`Unknown command: ${parsed.command}`, "UNKNOWN_COMMAND"), json, io);
  }

  let app: CliApplication | undefined;
  try {
    const configPath = optionString(parsed, "config");
    if (configPath !== undefined && (configPath.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(configPath))) {
      throw new CliUsageError("Configuration path must be bounded and contain no control characters");
    }
    const createApplication = dependencies.createApplication ?? (async (options: CliApplicationOptions) => {
      const module = await import("./bootstrap.js");
      return module.createLocalCliApplication(options);
    });
    app = await createApplication({
      ...(configPath === undefined ? {} : { configPath }),
    });
    const result = await executeCommand(parsed, app);
    if (result !== undefined) io.stdout.write(renderCliResult(result, json));
    return exitCodeFor(result);
  } catch (error) {
    return writeFailure(error, json, io);
  } finally {
    await app?.close().catch(() => undefined);
  }
}

async function executeCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object | undefined> {
  switch (parsed.command) {
    case "init": return runInitCommand(parsed, app);
    case "sources": return runSourcesCommand(parsed, app);
    case "index": return runIndexCommand(parsed, app);
    case "scopes": return runScopesCommand(parsed, app);
    case "overview": return runOverviewCommand(parsed, app);
    case "search": return runSearchCommand(parsed, app);
    case "inspect": return runInspectCommand(parsed, app);
    case "doctor": return runDoctorCommand(parsed, app);
    case "service": return runServiceCommand(parsed, app);
    case "reindex": return runReindexCommand(parsed, app);
    case "forget": return runForgetCommand(parsed, app);
    case "export": return runExportCommand(parsed, app);
    case "serve": return runServeCommand(parsed, app);
    default: throw new CliUsageError(`Unknown command: ${parsed.command}`, "UNKNOWN_COMMAND");
  }
}

function writeFailure(error: unknown, json: boolean, io: CliIo): number {
  if (error instanceof CliUsageError) {
    io.stderr.write(renderCliError(error.code, error.message, json));
    return 2;
  }
  const code = safeErrorCode(error);
  io.stderr.write(renderCliError(code, safeErrorMessage(error), json));
  return 1;
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) {
    return error.code;
  }
  if (error instanceof RangeError || error instanceof TypeError) return "INVALID_ARGUMENT";
  return "COMMAND_FAILED";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof RangeError || error instanceof TypeError) return error.message;
  return "Command failed; run context-bridge doctor for local diagnostics";
}

function exitCodeFor(result: object | undefined): number {
  if (result === undefined || !("status" in result)) return 0;
  const status = result.status;
  return status === "failed" || status === "unhealthy" || status === "unsupported" || status === "pending" ||
    status === "inactive" || status === "not_installed" ? 1 : 0;
}
