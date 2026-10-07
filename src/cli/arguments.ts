import { CliUsageError } from "./types.js";

const BOOLEAN_OPTIONS = new Set(["help", "json", "initial", "yes", "stdio", "foreground", "version"]);

export interface ParsedCliArguments {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly (string | true)[]>;
}

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
  let command: string | undefined;
  const positionals: string[] = [];
  const options = new Map<string, (string | true)[]>();
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--")) {
      const equal = argument.indexOf("=");
      const name = argument.slice(2, equal === -1 ? undefined : equal);
      if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new CliUsageError(`Invalid option: ${argument}`);
      let value: string | true;
      if (equal !== -1) {
        value = argument.slice(equal + 1);
        if (value.length === 0) throw new CliUsageError(`Option --${name} requires a value`);
      } else if (BOOLEAN_OPTIONS.has(name)) {
        value = true;
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new CliUsageError(`Option --${name} requires a value`);
        }
        value = next;
        index += 1;
      }
      options.set(name, [...(options.get(name) ?? []), value]);
      continue;
    }
    if (command === undefined) command = argument;
    else positionals.push(argument);
  }
  return { ...(command === undefined ? {} : { command }), positionals, options };
}

export function assertAllowedOptions(
  parsed: ParsedCliArguments,
  commandOptions: readonly string[],
): void {
  const allowed = new Set(["help", "json", "config", ...commandOptions]);
  for (const option of parsed.options.keys()) {
    if (!allowed.has(option)) throw new CliUsageError(`Unknown option for ${parsed.command}: --${option}`);
  }
}

export function assertPositionalCount(
  parsed: ParsedCliArguments,
  minimum: number,
  maximum: number,
): void {
  if (parsed.positionals.length < minimum || parsed.positionals.length > maximum) {
    const expectation = minimum === maximum
      ? `${minimum}`
      : `${minimum} to ${maximum}`;
    throw new CliUsageError(`${parsed.command} expects ${expectation} positional argument(s)`);
  }
}

export function optionString(parsed: ParsedCliArguments, name: string): string | undefined {
  const values = parsed.options.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string") {
    throw new CliUsageError(`Option --${name} must be supplied exactly once with a value`);
  }
  return values[0];
}

export function optionStrings(parsed: ParsedCliArguments, name: string): readonly string[] {
  const values = parsed.options.get(name) ?? [];
  if (values.some((value) => typeof value !== "string")) {
    throw new CliUsageError(`Option --${name} requires a value`);
  }
  return values as readonly string[];
}

export function optionBoolean(parsed: ParsedCliArguments, name: string): boolean {
  const values = parsed.options.get(name);
  if (values === undefined) return false;
  if (values.length !== 1 || values[0] !== true) {
    throw new CliUsageError(`Option --${name} is a flag and may be supplied once`);
  }
  return true;
}

export function optionInteger(
  parsed: ParsedCliArguments,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = optionString(parsed, name);
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) throw new CliUsageError(`Option --${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliUsageError(`Option --${name} must be from ${minimum} to ${maximum}`);
  }
  return value;
}
