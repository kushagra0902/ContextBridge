import {
  parseProjectId,
  parseSessionId,
  parseWorkstreamId,
} from "../../contracts/ids.js";
import type { ScopeAddress } from "../../contracts/scope.js";
import { optionString, type ParsedCliArguments } from "../arguments.js";
import { CliUsageError } from "../types.js";

export function optionalScope(parsed: ParsedCliArguments): ScopeAddress | undefined {
  const project = optionString(parsed, "project");
  const workstream = optionString(parsed, "workstream");
  const session = optionString(parsed, "session");
  if (project === undefined) {
    if (workstream !== undefined || session !== undefined) {
      throw new CliUsageError("--workstream and --session require --project");
    }
    return undefined;
  }
  try {
    return {
      projectId: parseProjectId(project),
      ...(workstream === undefined ? {} : { workstreamId: parseWorkstreamId(workstream) }),
      ...(session === undefined ? {} : { sessionId: parseSessionId(session) }),
    };
  } catch {
    throw new CliUsageError("Scope options must contain valid opaque IDs");
  }
}

export function requiredScope(parsed: ParsedCliArguments): ScopeAddress {
  const scope = optionalScope(parsed);
  if (scope === undefined) throw new CliUsageError("This command requires --project <opaque-project-id>");
  return scope;
}
