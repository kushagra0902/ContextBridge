import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";

export interface RuntimeLock {
  readonly path: string;
  release(): Promise<void>;
}

export class RuntimeAlreadyRunningError extends Error {
  readonly code = "ALREADY_RUNNING";

  constructor() {
    super("Context Bridge is already running for this local state directory");
    this.name = "RuntimeAlreadyRunningError";
  }
}

export async function acquireRuntimeLock(path: string): Promise<RuntimeLock> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nonce = randomUUID();
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        path,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(path, "utf8")) as { nonce?: unknown };
            if (current.nonce === nonce) await unlink(path);
          } catch {
            // A missing or replaced lock is not ours to remove.
          }
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const owner = await readOwner(path);
      if (owner !== undefined && processIsAlive(owner)) throw new RuntimeAlreadyRunningError();
      if (attempt === 0) {
        await unlink(path).catch((unlinkError) => {
          if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      throw new RuntimeAlreadyRunningError();
    }
  }
  throw new RuntimeAlreadyRunningError();
}

async function readOwner(path: string): Promise<number | undefined> {
  try {
    const value = JSON.parse((await readFile(path)).subarray(0, 4_096).toString("utf8")) as { pid?: unknown };
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
