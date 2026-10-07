import { assertAllowedOptions, assertPositionalCount, optionBoolean, type ParsedCliArguments } from "../arguments.js";
import type { CliApplication } from "../types.js";

export async function runIndexCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["initial"]);
  assertPositionalCount(parsed, 0, 0);
  return app.index({ initial: optionBoolean(parsed, "initial") });
}
