import { join } from "node:path";

import { createRuntimeApplication, type RuntimeApplication, type RuntimeApplicationOptions } from "./create-app.js";
import { startMcpHttpServer, type McpHttpServerHandle } from "./http.js";
import { acquireRuntimeLock, type RuntimeLock } from "./lock.js";
import { listenForShutdownSignals, waitWithGrace } from "./shutdown.js";

export interface RuntimeDaemonStatus {
  readonly state: "starting" | "ready" | "stopping" | "stopped";
  readonly startedAt: string;
  readonly cycles: number;
  readonly failedCycles: number;
  readonly lastCycleAt?: string;
  readonly lastCycleStatus?: string;
}

export interface RuntimeDaemonHandle {
  readonly http: McpHttpServerHandle;
  status(): RuntimeDaemonStatus;
  stop(): Promise<void>;
}

export async function startRuntimeDaemon(runtime: RuntimeApplication): Promise<RuntimeDaemonHandle> {
  const lock = await acquireRuntimeLock(join(runtime.paths.stateDir, "runtime.lock"));
  let http: McpHttpServerHandle | undefined;
  try {
    http = await startMcpHttpServer({
      app: runtime.readApp,
      secret: runtime.httpSecret,
      host: runtime.config.runtime.host,
      port: runtime.config.runtime.port,
      maxRequestBytes: runtime.config.runtime.maxRequestBytes,
      maxConcurrentRequests: runtime.config.runtime.maxConcurrentRequests,
    });
    return startLoop(runtime, http, lock);
  } catch (error) {
    await http?.close().catch(() => undefined);
    await lock.release();
    throw error;
  }
}

export async function runRuntimeDaemon(options: RuntimeApplicationOptions = {}): Promise<void> {
  const runtime = await createRuntimeApplication(options);
  let daemon: RuntimeDaemonHandle | undefined;
  try {
    daemon = await startRuntimeDaemon(runtime);
    const shutdown = listenForShutdownSignals();
    try {
      await shutdown.signal;
    } finally {
      shutdown.dispose();
    }
  } finally {
    if (daemon !== undefined) await daemon.stop();
    else await runtime.close().catch(() => undefined);
  }
}

function startLoop(
  runtime: RuntimeApplication,
  http: McpHttpServerHandle,
  lock: RuntimeLock,
): RuntimeDaemonHandle {
  const state: {
    value: RuntimeDaemonStatus["state"];
    cycles: number;
    failedCycles: number;
    lastCycleAt?: string;
    lastCycleStatus?: string;
  } = { value: "starting", cycles: 0, failedCycles: 0 };
  const startedAt = new Date().toISOString();
  let inFlight: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;

  const cycle = () => {
    if (state.value === "stopping" || state.value === "stopped" || inFlight !== undefined) return;
    inFlight = runtime.runIndexCycle({ processExisting: false })
      .then((result) => {
        state.cycles += 1;
        state.lastCycleAt = new Date().toISOString();
        state.lastCycleStatus = result.status;
      })
      .catch(() => {
        state.cycles += 1;
        state.failedCycles += 1;
        state.lastCycleAt = new Date().toISOString();
        state.lastCycleStatus = "failed";
      })
      .finally(() => { inFlight = undefined; });
  };
  state.value = "ready";
  cycle();
  const interval = setInterval(cycle, runtime.config.sources.pollingIntervalMs);

  return {
    http,
    status: () => ({
      state: state.value,
      startedAt,
      cycles: state.cycles,
      failedCycles: state.failedCycles,
      ...(state.lastCycleAt === undefined ? {} : { lastCycleAt: state.lastCycleAt }),
      ...(state.lastCycleStatus === undefined ? {} : { lastCycleStatus: state.lastCycleStatus }),
    }),
    stop() {
      if (stopped !== undefined) return stopped;
      stopped = (async () => {
        state.value = "stopping";
        clearInterval(interval);
        const drained = await waitWithGrace(inFlight, runtime.config.runtime.shutdownGraceMs);
        await http.close().catch(() => undefined);
        if (drained === "complete") await runtime.close().catch(() => undefined);
        else await runtime.close().catch(() => undefined);
        await lock.release();
        state.value = "stopped";
      })();
      return stopped;
    },
  };
}
