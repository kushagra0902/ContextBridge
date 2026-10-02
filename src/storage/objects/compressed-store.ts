// This file performs the function to compress and store the larger objects
// That are should not be stored in SQLite.
// Compression format used is gzip, due to its streaming behaviour. 

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";

import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";

import { platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

// Promisifying the gzip and gunzip funcs to make them async
// ie form that returns promises as return value. 
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);


const OBJECT_ID_PATTERN = /^obj:sha256:([a-f0-9]{64})$/u;
const DEFAULT_MAX_OBJECT_BYTES = 16 * 1024 * 1024;

// object id is made from the sha256 hash of the object and a random string appended to it. 
export type ObjectId = `obj:sha256:${string}`;


export interface CompressedObjectStoreOptions {
  readonly rootDirectory: string;
  readonly maxObjectBytes?: number;
}


export interface StoredObject {
  readonly id: ObjectId;
  readonly uncompressedBytes: number;
  readonly compressedBytes: number;
  readonly created: boolean;
}

export interface StoredObjectEntry {
  readonly id: ObjectId;
  readonly modifiedAtMs: number;
  readonly compressedBytes: number;
}

export class CompressedObjectStore {
  readonly rootDirectory: string;
  readonly maxObjectBytes: number;

  constructor(options: CompressedObjectStoreOptions) {
    if (options.rootDirectory.length === 0 || options.rootDirectory.includes("\0")) {
      throw new TypeError("Invalid object-store directory");
    }
    const maximum = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_073_741_824) {
      throw new RangeError("Object size limit must be from 1 byte to 1 GiB");
    }
    this.rootDirectory = options.rootDirectory;
    this.maxObjectBytes = maximum;
  }


  async initialize(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 }); // 0o700 mode is for file owning perms and blocking other local/remote users
    if (platform() !== "win32") {
      await chmod(this.rootDirectory, 0o700);
    }
    const state = await lstat(this.rootDirectory); // lstat is for checking the status of the file
    // no explict perms req for this; but search perms req for directories mention in path. 
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error("Object-store root must be a real directory");
    }
  }

  // Makes the Stored Object for the given value and retrun the details. 
  async put(value: string | Uint8Array): Promise<StoredObject> {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    this.assertSize(bytes.byteLength);
    await this.initialize();

    const digest = createHash("sha256").update(bytes).digest("hex");
    const id = `obj:sha256:${digest}` as ObjectId;
    const directory = join(this.rootDirectory, digest.slice(0, 2));
    const target = join(directory, `${digest}.gz`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertRealDirectory(directory);
    if (await regularFileExists(target)) {
      const existing = await lstat(target);
      return {
        id,
        uncompressedBytes: bytes.byteLength,
        compressedBytes: existing.size,
        created: false,
      };
    }

    const compressed = await gzipAsync(bytes, { level: 9 });
    const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    let handle;
    try {
      // open returns an obj of type file handle, used to do opts etc on the file it refers to. 
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); // 0600 defines a file with reading and writing perms, but not execution perms. 
      await handle.writeFile(compressed);
      await handle.sync();
      await handle.close();
      handle = undefined;

      if (await regularFileExists(target)) {
        await unlink(temporary);
        const existing = await lstat(target);
        return {
          id,
          uncompressedBytes: bytes.byteLength,
          compressedBytes: existing.size,
          created: false,
        };
      }
      await rename(temporary, target);
      if (platform() !== "win32") {
        await chmod(target, 0o600);
      }
      return {
        id,
        uncompressedBytes: bytes.byteLength,
        compressedBytes: compressed.byteLength,
        created: true,
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  // Returns the unzipped bytes in the original form for the compressed object.
  async get(id: ObjectId): Promise<Uint8Array> {
    const { digest, path } = this.resolve(id);
    await assertRealDirectory(join(this.rootDirectory, digest.slice(0, 2)));
    const flags = platform() === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(path, flags);
    try {
      const state = await handle.stat();
      if (!state.isFile()) {
        throw new Error("Stored object is not a regular file");
      }
      const compressed = await handle.readFile();
      const bytes = await gunzipAsync(compressed, {
        maxOutputLength: this.maxObjectBytes + 1,
      });
      this.assertSize(bytes.byteLength);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== digest) {
        throw new Error("Stored object failed its content digest check");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async has(id: ObjectId): Promise<boolean> {
    const resolved = this.resolve(id);
    const shard = join(this.rootDirectory, resolved.digest.slice(0, 2));
    try {
      await assertRealDirectory(shard);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    return regularFileExists(resolved.path);
  }

  async delete(id: ObjectId): Promise<boolean> {
    const resolved = this.resolve(id);
    const shard = join(this.rootDirectory, resolved.digest.slice(0, 2));
    try {
      await assertRealDirectory(shard);
      await unlink(resolved.path);
      return true;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async list(): Promise<readonly StoredObjectEntry[]> {
    await this.initialize();
    const entries: StoredObjectEntry[] = [];
    const shards = await readdir(this.rootDirectory, { withFileTypes: true });
    for (const shard of shards) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/u.test(shard.name)) {
        continue;
      }
      const directory = join(this.rootDirectory, shard.name);
      const files = await readdir(directory, { withFileTypes: true });
      for (const file of files) {
        const match = /^([a-f0-9]{64})\.gz$/u.exec(file.name);
        if (!file.isFile() || match?.[1] === undefined || !match[1].startsWith(shard.name)) {
          continue;
        }
        const path = join(directory, file.name);
        const state = await lstat(path);
        if (state.isSymbolicLink()) {
          continue;
        }
        entries.push({
          id: `obj:sha256:${match[1]}` as ObjectId,
          modifiedAtMs: state.mtimeMs,
          compressedBytes: state.size,
        });
      }
    }
    return entries.sort((left, right) => left.id.localeCompare(right.id));
  }

  private resolve(id: ObjectId): { readonly digest: string; readonly path: string } {
    const match = OBJECT_ID_PATTERN.exec(id);
    const digest = match?.[1];
    if (digest === undefined) {
      throw new TypeError("Invalid object ID");
    }
    return {
      digest,
      path: join(this.rootDirectory, digest.slice(0, 2), `${digest}.gz`),
    };
  }

  private assertSize(size: number): void {
    if (size > this.maxObjectBytes) {
      throw new RangeError(`Object exceeds ${this.maxObjectBytes} bytes`);
    }
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error("Object-store shard must be a real directory");
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink()) {
      throw new Error("Refusing a symbolic link in the object store");
    }
    if (!state.isFile()) {
      throw new Error("Object path is not a regular file");
    }
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
