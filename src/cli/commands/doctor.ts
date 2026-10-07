import { assertAllowedOptions, assertPositionalCount, type ParsedCliArguments } from "../arguments.js";
import type { CliApplication } from "../types.js";

export async function runDoctorCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, []);
  assertPositionalCount(parsed, 0, 0);
  return app.doctor();
}
