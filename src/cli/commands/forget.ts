import { assertAllowedOptions, assertPositionalCount, optionBoolean, type ParsedCliArguments } from "../arguments.js";
import { CliUsageError, type CliApplication } from "../types.js";
import { requiredScope } from "./common.js";

export async function runForgetCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["project", "workstream", "session", "yes"]);
  assertPositionalCount(parsed, 0, 0);
  if (!optionBoolean(parsed, "yes")) {
    throw new CliUsageError("forget is destructive and requires --yes");
  }
  return app.forget({ scope: requiredScope(parsed), reason: "forgotten" });
}
