import { assertAllowedOptions, assertPositionalCount, optionInteger, type ParsedCliArguments } from "../arguments.js";
import type { CliApplication } from "../types.js";
import { requiredScope } from "./common.js";

export async function runReindexCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["project", "workstream", "session", "max-sessions"]);
  assertPositionalCount(parsed, 0, 0);
  const maxSessions = optionInteger(parsed, "max-sessions", 1, 1_000);
  return app.reindex({
    scope: requiredScope(parsed),
    ...(maxSessions === undefined ? {} : { maxSessions }),
  });
}
