import { assertAllowedOptions, assertPositionalCount, optionBoolean, type ParsedCliArguments } from "../arguments.js";
import { CliUsageError, type CliApplication } from "../types.js";

export async function runServeCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<undefined> {
  assertAllowedOptions(parsed, ["stdio", "foreground"]);
  assertPositionalCount(parsed, 0, 0);
  const stdio = optionBoolean(parsed, "stdio");
  const foreground = optionBoolean(parsed, "foreground");
  if (stdio === foreground) throw new CliUsageError("serve requires exactly one of --stdio or --foreground");
  if (stdio) await app.serveStdio();
  else await app.serveHttp();
  return undefined;
}
