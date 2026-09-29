// This files ensures that even on local host mcp, the req are authenticated
// This means that any malicious application/webpage cannot make a requrest to the MCP
// and get access to information


// This files uses different methods to protect the secret containing file itself too.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { platform as currentPlatform } from "node:os";

import { ensurePrivateDirectory } from "../config/paths.js";

const SECRET_PREFIX = "cb1.";
const MAX_SECRET_FILE_BYTES = 512;

export type LocalAuthDenialReason =
  | "missing_host"
  | "invalid_host"
  | "invalid_origin"
  | "missing_token"
  | "invalid_token";

export type LocalAuthDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: LocalAuthDenialReason };

// Host and origin are important to reject the requests from other apps or webpages
export interface LocalRequestAuthInput {
  readonly host?: string;
  readonly origin?: string;
  readonly authorization?: string;
}

// Opt to add origins that are allowed.
export interface LocalRequestAuthOptions {
  readonly allowedOrigins?: readonly string[];
}

export class LocalSecretError extends Error {
  readonly code:
    | "INVALID_SECRET_PATH"
    | "INVALID_SECRET_FILE"
    | "INVALID_SECRET_CONTENT";

  constructor(
    code: LocalSecretError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalSecretError";
    this.code = code;
  }
}

// Creates a directory to safe the key file if it doesnt exist already
// and if it does exist, it tries to load the existing secret
// The parent directory is made private, ie only the current user can access
// the directory and the other user or remote user or group cannot.

// If the secret doesnt exist from before, it makes a new secret of the form
// cb1.[ 32 random chars]
export async function loadOrCreateLocalSecret(
  secretPath: string,
  platform: NodeJS.Platform = currentPlatform(),
): Promise<string> {
  await ensurePrivateDirectory(dirname(secretPath), platform);

  try {
    return await loadExistingSecret(secretPath, platform);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const secret = `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  try {
    const handle = await open(secretPath, "wx", 0o600);
    try {
      await handle.writeFile(`${secret}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (platform !== "win32") {
      await chmod(secretPath, 0o600);
    }
    return secret;
  } catch (error) {
    if (getErrorCode(error) === "EEXIST") {
      return loadExistingSecret(secretPath, platform);
    }
    throw new LocalSecretError(
      "INVALID_SECRET_PATH",
      "Unable to create the local authentication secret",
      { cause: error },
    );
  }
}


// It valdidates a request on the basis of origin, port, host name
// format of the secret,and the secret itself
// The expected secret and the received secret both are
// first passed through sha256 to ensure both are of same length and to ensure that
// the secret is not compromised.
export async function validateLocalRequest(
  input: LocalRequestAuthInput,
  expectedSecret: string,
  options: LocalRequestAuthOptions = {},
): Promise<LocalAuthDecision> {
  if (input.host === undefined || input.host.trim().length === 0) {
    return { allowed: false, reason: "missing_host" };
  }
  if (!isLoopbackAuthority(input.host)) {
    return { allowed: false, reason: "invalid_host" };
  }
  if (
    input.origin !== undefined &&
    !isAllowedOrigin(input.origin, options.allowedOrigins)
  ) {
    return { allowed: false, reason: "invalid_origin" };
  }

  const supplied = extractBearerToken(input.authorization);
  if (supplied === undefined) {
    return { allowed: false, reason: "missing_token" };
  }
  if (!verifyLocalToken(supplied, expectedSecret)) {
    return { allowed: false, reason: "invalid_token" };
  }
  return { allowed: true };
}


// helper func to get the bearer token from the req for validation. 
export function extractBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^Bearer ([^\s\u0000-\u001f\u007f]{16,512})$/u.exec(
    authorization,
  );
  return match?.[1];
}

export function verifyLocalToken(
  supplied: string,
  expected: string,
): boolean {
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function isLoopbackAuthority(authority: string): boolean {
  if (
    authority.length > 255 ||
    /[\s\u0000-\u001f\u007f/@?#]/u.test(authority)
  ) {
    return false;
  }
  try {
    const url = new URL(`http://${authority}/`);
    return (
      url.username.length === 0 &&
      url.password.length === 0 &&
      isLoopbackHostname(url.hostname) &&
      (url.port.length === 0 || isValidPort(url.port))
    );
  } catch {
    return false;
  }
}

function isAllowedOrigin(
  origin: string,
  allowedOrigins: readonly string[] | undefined,
): boolean {
  try {
    const url = new URL(origin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !isLoopbackHostname(url.hostname)
    ) {
      return false;
    }
    if (allowedOrigins === undefined) {
      return true;
    }
    const normalizedAllowed = allowedOrigins.map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "";
      }
    });
    return normalizedAllowed.includes(url.origin);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]"
  );
}

function isValidPort(port: string): boolean {
  const value = Number(port);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

async function loadExistingSecret(
  secretPath: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const pathDetails = await lstat(secretPath);
  if (!pathDetails.isFile() || pathDetails.isSymbolicLink()) {
    throw new LocalSecretError(
      "INVALID_SECRET_FILE",
      "Local authentication secret must be a regular file",
    );
  }
  let handle;
  try {
    handle = await open(
      secretPath,
      platform === "win32"
        ? "r"
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (getErrorCode(error) === "ELOOP") {
      throw new LocalSecretError(
        "INVALID_SECRET_FILE",
        "Local authentication secret must not be a symbolic link",
      );
    }
    throw error;
  }

  let secret: string;
  try {
    const details = await handle.stat();
    if (!details.isFile()) {
      throw new LocalSecretError(
        "INVALID_SECRET_FILE",
        "Local authentication secret must be a regular file",
      );
    }
    if (details.size > MAX_SECRET_FILE_BYTES) {
      throw new LocalSecretError(
        "INVALID_SECRET_CONTENT",
        "Local authentication secret file is too large",
      );
    }
    secret = (await handle.readFile({ encoding: "utf8" })).trim();
  } finally {
    await handle.close();
  }

  if (!/^cb1\.[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new LocalSecretError(
      "INVALID_SECRET_CONTENT",
      "Local authentication secret is invalid",
    );
  }
  if (platform !== "win32") {
    await chmod(secretPath, 0o600);
  }
  return secret;
}

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
