import { assertAllowedOptions, assertPositionalCount, optionStrings, type ParsedCliArguments } from "../arguments.js";
import { parseProjectId } from "../../contracts/ids.js";
import { CliUsageError, type CliApplication } from "../types.js";

export async function runInitCommand(parsed: ParsedCliArguments, app: CliApplication): Promise<object> {
  assertAllowedOptions(parsed, ["codex-home", "include-project", "exclude-project"]);
  assertPositionalCount(parsed, 0, 0);
  const homes = optionStrings(parsed, "codex-home");
  if (homes.length > 32) throw new CliUsageError("init accepts at most 32 --codex-home values");
  if (homes.some((home) => home.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(home))) {
    throw new CliUsageError("Codex home paths must be bounded and contain no control characters");
  }
  const includeProjectIds = parseProjects(optionStrings(parsed, "include-project"));
  const excludeProjectIds = parseProjects(optionStrings(parsed, "exclude-project"));
  const overlap = includeProjectIds.find((id) => excludeProjectIds.includes(id));
  if (overlap !== undefined) throw new CliUsageError("A project cannot be both included and excluded");
  return app.initialize({
    ...(homes.length === 0 ? {} : { codexHomes: homes }),
    ...(includeProjectIds.length === 0 ? {} : { includeProjectIds }),
    ...(excludeProjectIds.length === 0 ? {} : { excludeProjectIds }),
  });
}

function parseProjects(values: readonly string[]) {
  if (values.length > 100) throw new CliUsageError("init accepts at most 100 project selections");
  try {
    return [...new Set(values.map(parseProjectId))];
  } catch {
    throw new CliUsageError("Project selections must contain valid opaque project IDs");
  }
}
