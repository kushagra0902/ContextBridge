import { assertAllowedOptions, assertPositionalCount, optionInteger, optionString, type ParsedCliArguments } from "../arguments.js";
import type { CliApplication } from "../types.js";
import { requiredScope } from "./common.js";

export async function runExportCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["project", "workstream", "session", "output", "max-tokens"]);
  assertPositionalCount(parsed, 0, 0);
  const value = optionInteger(parsed, "max-tokens", 128, 10_000);
  return app.exportScope({
    scope: requiredScope(parsed),
    ...(value === undefined ? {} : { budget: { maxTokens: value } }),
  }, optionString(parsed, "output"));
}
