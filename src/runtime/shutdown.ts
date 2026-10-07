export interface ShutdownHandle {
  readonly signal: Promise<NodeJS.Signals>;
  dispose(): void;
}

export function listenForShutdownSignals(): ShutdownHandle {
  let resolveSignal!: (signal: NodeJS.Signals) => void;
  const signal = new Promise<NodeJS.Signals>((resolve) => { resolveSignal = resolve; });
  let settled = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (settled) return;
      settled = true;
      resolveSignal(name);
    };
    handlers.set(name, handler);
    process.once(name, handler);
  }
  return {
    signal,
    dispose() {
      for (const [name, handler] of handlers) process.off(name, handler);
    },
  };
}

export async function waitWithGrace<T>(
  operation: Promise<T> | undefined,
  graceMs: number,
): Promise<"complete" | "timed_out"> {
  if (operation === undefined) return "complete";
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => "complete" as const, () => "complete" as const),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), graceMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
