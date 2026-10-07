import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireRuntimeLock,
  createRuntimeServiceManager,
  RuntimeAlreadyRunningError,
} from "../../../dist/runtime/index.js";

test("runtime lock prevents a second writer and can be reacquired after release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "context-bridge-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "runtime.lock");
  const first = await acquireRuntimeLock(path);
  await assert.rejects(() => acquireRuntimeLock(path), RuntimeAlreadyRunningError);
  await first.release();
  const second = await acquireRuntimeLock(path);
  await second.release();
});

test("Linux service manager writes a hardened user unit and invokes systemd safely", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "context-bridge-service-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const manager = createRuntimeServiceManager({
    platform: "linux",
    homeDir: home,
    configPath: "/tmp/context bridge/config.toml",
    nodeExecutable: "/opt/node 24/bin/node",
    cliEntrypoint: "/opt/context bridge/dist/cli/bin.js",
    runCommand: async (command, args) => {
      calls.push([command, [...args]]);
      return { exitCode: 0 };
    },
  });

  assert.equal((await manager.execute("install")).status, "ok");
  const unit = await readFile(join(home, ".config", "systemd", "user", "context-bridge.service"), "utf8");
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /"\/opt\/node 24\/bin\/node"/);
  assert.deepEqual(calls, [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "context-bridge.service"]],
  ]);
});
