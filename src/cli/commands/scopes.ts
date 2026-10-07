import { assertAllowedOptions, optionInteger, type ParsedCliArguments } from "../arguments.js";
import { CliUsageError, type CliApplication } from "../types.js";

export async function runScopesCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["limit"]);
  const query = parsed.positionals.join(" ").trim();
  if (query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new CliUsageError("Scope query must be at most 256 characters with no control characters");
  }
  const limit = optionInteger(parsed, "limit", 1, 20);
  return app.listContextScopes({
    ...(query.length === 0 ? {} : { query }),
    ...(limit === undefined ? {} : { limit, budget: { maxItems: limit } }),
  });
}
