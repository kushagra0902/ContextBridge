import { assertAllowedOptions, type ParsedCliArguments } from "../arguments.js";
import { CliUsageError, type CliApplication, type ServiceAction } from "../types.js";

const ACTIONS = new Set<ServiceAction>(["install", "uninstall", "start", "stop", "status"]);

export async function runServiceCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, []);
  const [action, ...extra] = parsed.positionals;
  if (extra.length > 0 || action === undefined || !ACTIONS.has(action as ServiceAction)) {
    throw new CliUsageError("service requires install, uninstall, start, stop, or status");
  }
  return app.service(action as ServiceAction);
}
