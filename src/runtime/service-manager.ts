import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export type RuntimeServiceAction = "install" | "uninstall" | "start" | "stop" | "status";

export interface RuntimeServiceResult {
  readonly status: "ok" | "inactive" | "not_installed" | "failed" | "unsupported";
  readonly action: RuntimeServiceAction;
  readonly manager: "systemd" | "launchd" | "scheduled_task" | "unsupported";
  readonly code?: string;
}

export interface CommandResult {
  readonly exitCode: number;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export interface RuntimeServiceManagerOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly configPath: string;
  readonly nodeExecutable?: string;
  readonly cliEntrypoint: string;
  readonly runCommand?: CommandRunner;
}

export interface RuntimeServiceManager {
  execute(action: RuntimeServiceAction): Promise<RuntimeServiceResult>;
}

export function createRuntimeServiceManager(options: RuntimeServiceManagerOptions): RuntimeServiceManager {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const node = options.nodeExecutable ?? process.execPath;
  const run = options.runCommand ?? runCommand;
  if (platform === "linux") return linuxManager(home, node, options.cliEntrypoint, options.configPath, run);
  if (platform === "darwin") return macManager(home, node, options.cliEntrypoint, options.configPath, run);
  if (platform === "win32") return windowsManager(node, options.cliEntrypoint, options.configPath, run);
  return {
    execute: async (action) => ({ status: "unsupported", action, manager: "unsupported" }),
  };
}

function linuxManager(
  home: string,
  node: string,
  cli: string,
  config: string,
  run: CommandRunner,
): RuntimeServiceManager {
  const unit = join(home, ".config", "systemd", "user", "context-bridge.service");
  const content = renderSystemdUnit(node, cli, config);
  return {
    async execute(action) {
      switch (action) {
        case "install": {
          await writePrivateFileAtomically(unit, content);
          const reload = await run("systemctl", ["--user", "daemon-reload"]);
          if (reload.exitCode !== 0) return failed(action, "systemd", "DAEMON_RELOAD_FAILED");
          const enabled = await run("systemctl", ["--user", "enable", "context-bridge.service"]);
          return enabled.exitCode === 0 ? ok(action, "systemd") : failed(action, "systemd", "ENABLE_FAILED");
        }
        case "uninstall": {
          await run("systemctl", ["--user", "disable", "--now", "context-bridge.service"]);
          const removed = await removeIfPresent(unit);
          await run("systemctl", ["--user", "daemon-reload"]);
          return removed ? ok(action, "systemd") : notInstalled(action, "systemd");
        }
        case "start": return commandStatus(action, "systemd", await run("systemctl", ["--user", "start", "context-bridge.service"]));
        case "stop": return commandStatus(action, "systemd", await run("systemctl", ["--user", "stop", "context-bridge.service"]));
        case "status": {
          const result = await run("systemctl", ["--user", "is-active", "--quiet", "context-bridge.service"]);
          return result.exitCode === 0 ? ok(action, "systemd") : { status: "inactive", action, manager: "systemd" };
        }
      }
    },
  };
}

function macManager(
  home: string,
  node: string,
  cli: string,
  config: string,
  run: CommandRunner,
): RuntimeServiceManager {
  const label = "dev.context-bridge";
  const plist = join(home, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${safeUid()}`;
  return {
    async execute(action) {
      switch (action) {
        case "install":
          await writePrivateFileAtomically(plist, renderLaunchdPlist(node, cli, config));
          return ok(action, "launchd");
        case "uninstall": {
          await run("launchctl", ["bootout", domain, plist]);
          return await removeIfPresent(plist) ? ok(action, "launchd") : notInstalled(action, "launchd");
        }
        case "start": return commandStatus(action, "launchd", await run("launchctl", ["bootstrap", domain, plist]));
        case "stop": return commandStatus(action, "launchd", await run("launchctl", ["bootout", domain, plist]));
        case "status": {
          const result = await run("launchctl", ["print", `${domain}/${label}`]);
          return result.exitCode === 0 ? ok(action, "launchd") : { status: "inactive", action, manager: "launchd" };
        }
      }
    },
  };
}

function windowsManager(
  node: string,
  cli: string,
  config: string,
  run: CommandRunner,
): RuntimeServiceManager {
  const task = "ContextBridge";
  const command = [node, cli, "serve", "--foreground", "--config", config]
    .map(quoteWindowsArgument)
    .join(" ");
  return {
    async execute(action) {
      switch (action) {
        case "install": return commandStatus(action, "scheduled_task", await run("schtasks", [
          "/Create", "/TN", task, "/SC", "ONLOGON", "/TR", command, "/F",
        ]));
        case "uninstall": return commandStatus(action, "scheduled_task", await run("schtasks", ["/Delete", "/TN", task, "/F"]));
        case "start": return commandStatus(action, "scheduled_task", await run("schtasks", ["/Run", "/TN", task]));
        case "stop": return commandStatus(action, "scheduled_task", await run("schtasks", ["/End", "/TN", task]));
        case "status": {
          const result = await run("schtasks", ["/Query", "/TN", task]);
          return result.exitCode === 0 ? ok(action, "scheduled_task") : notInstalled(action, "scheduled_task");
        }
      }
    },
  };
}

export function renderSystemdUnit(node: string, cli: string, config: string): string {
  const command = [node, cli, "serve", "--foreground", "--config", config].map(escapeSystemdArgument).join(" ");
  return `[Unit]\nDescription=Context Bridge local MCP service\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=true\nPrivateTmp=true\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderLaunchdPlist(node: string, cli: string, config: string): string {
  const args = [node, cli, "serve", "--foreground", "--config", config]
    .map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>dev.context-bridge</string>\n  <key>ProgramArguments</key>\n  <array>\n${args}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n</dict>\n</plist>\n`;
}

async function writePrivateFileAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function removeIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve({ exitCode: 127 }));
    child.once("exit", (code) => resolve({ exitCode: code ?? 1 }));
  });
}

function commandStatus(action: RuntimeServiceAction, manager: RuntimeServiceResult["manager"], result: CommandResult): RuntimeServiceResult {
  return result.exitCode === 0 ? ok(action, manager) : failed(action, manager, "COMMAND_FAILED");
}

function ok(action: RuntimeServiceAction, manager: RuntimeServiceResult["manager"]): RuntimeServiceResult {
  return { status: "ok", action, manager };
}

function failed(action: RuntimeServiceAction, manager: RuntimeServiceResult["manager"], code: string): RuntimeServiceResult {
  return { status: "failed", action, manager, code };
}

function notInstalled(action: RuntimeServiceAction, manager: RuntimeServiceResult["manager"]): RuntimeServiceResult {
  return { status: "not_installed", action, manager };
}

function escapeSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function safeUid(): number {
  try {
    return userInfo().uid;
  } catch {
    return process.getuid?.() ?? 0;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
