import { parseChunkId, parseEventId } from "../../contracts/ids.js";
import {
  assertAllowedOptions,
  optionInteger,
  type ParsedCliArguments,
} from "../arguments.js";
import { CliUsageError, type CliApplication } from "../types.js";
import { optionalScope } from "./common.js";

export async function runInspectCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["project", "workstream", "session", "before", "after", "max-tokens"]);
  if (parsed.positionals.length < 1 || parsed.positionals.length > 5) {
    throw new CliUsageError("inspect requires from 1 to 5 event or chunk IDs");
  }
  const evidenceIds = parsed.positionals.map((id) => {
    try {
      return id.startsWith("ku::event:") ? parseEventId(id) : parseChunkId(id);
    } catch {
      throw new CliUsageError(`Invalid evidence ID: ${id}`);
    }
  });
  const scope = optionalScope(parsed);
  const beforeEvents = optionInteger(parsed, "before", 0, 20);
  const afterEvents = optionInteger(parsed, "after", 0, 20);
  const maxTokens = optionInteger(parsed, "max-tokens", 128, 5_000);
  return app.getEvidence({
    evidenceIds,
    ...(scope === undefined ? {} : { scope }),
    ...(beforeEvents === undefined ? {} : { beforeEvents }),
    ...(afterEvents === undefined ? {} : { afterEvents }),
    ...(maxTokens === undefined ? {} : { budget: { maxTokens } }),
  });
}
