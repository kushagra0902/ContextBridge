import { assertAllowedOptions, assertPositionalCount, optionInteger, type ParsedCliArguments } from "../arguments.js";
import type { CliApplication } from "../types.js";
import { requiredScope } from "./common.js";

export async function runOverviewCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["project", "workstream", "session", "max-tokens"]);
  assertPositionalCount(parsed, 0, 0);
  const maxTokens = optionInteger(parsed, "max-tokens", 128, 3_000);
  return app.getContextOverview({
    scope: requiredScope(parsed),
    ...(maxTokens === undefined ? {} : { budget: { maxTokens } }),
  });
}
