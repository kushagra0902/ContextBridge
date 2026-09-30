export type GitRemoteTransport = "https" | "http" | "ssh" | "git" | "scp";

export interface NormalizedGitRemote {
  /** Stable host/path identity used for project grouping. */
  readonly canonical: string;
  readonly host: string;
  readonly repositoryPath: string;
  readonly provenance: {
    readonly transport: GitRemoteTransport;
    /** Credential-free form suitable for local diagnostics and persistence. */
    readonly sanitized: string;
    readonly credentialsStripped: boolean;
  };
}

export type GitRemoteRejectionReason =
  | "empty"
  | "too_long"
  | "control_character"
  | "local_path"
  | "unsupported_protocol"
  | "query_or_fragment"
  | "missing_host"
  | "missing_repository_path"
  | "invalid";

export type GitRemoteNormalization =
  | { readonly ok: true; readonly remote: NormalizedGitRemote }
  | { readonly ok: false; readonly reason: GitRemoteRejectionReason };

const CASE_INSENSITIVE_PATH_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "dev.azure.com",
]);

/** Normalizes network Git remotes without retaining embedded credentials. */
export function normalizeGitRemote(input: string): GitRemoteNormalization {
  const value = input.trim();
  if (value.length === 0) return reject("empty");
  if (value.length > 4_096) return reject("too_long");
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return reject("control_character");
  }
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
  ) {
    return reject("local_path");
  }

  if (!value.includes("://")) {
    return normalizeScpRemote(value);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject("invalid");
  }
  const transport = protocolTransport(url.protocol);
  if (transport === undefined) return reject("unsupported_protocol");
  if (url.search.length > 0 || url.hash.length > 0) {
    return reject("query_or_fragment");
  }
  if (url.hostname.length === 0) return reject("missing_host");

  const repositoryPath = normalizeRepositoryPath(url.pathname, url.hostname);
  if (repositoryPath === undefined) return reject("missing_repository_path");
  const host = canonicalHost(url.hostname, url.port);
  const hadCredentials = url.username.length > 0 || url.password.length > 0;
  const sanitized = `${transport}://${host}/${repositoryPath}`;
  return success(host, repositoryPath, {
    transport,
    sanitized,
    credentialsStripped: hadCredentials,
  });
}

function normalizeScpRemote(value: string): GitRemoteNormalization {
  // Windows drive paths were rejected before this point.
  const match = /^(?:([^@\s/:]+)@)?([^\s/:]+):(.+)$/u.exec(value);
  if (match === null) return reject("invalid");
  const user = match[1];
  const rawHost = match[2];
  const rawPath = match[3];
  if (rawHost === undefined || rawHost.length === 0) {
    return reject("missing_host");
  }
  const host = rawHost.toLowerCase();
  const repositoryPath = normalizeRepositoryPath(rawPath ?? "", host);
  if (repositoryPath === undefined) return reject("missing_repository_path");

  return success(host, repositoryPath, {
    transport: "scp",
    sanitized: `${host}:${repositoryPath}`,
    credentialsStripped: user !== undefined && user !== "git",
  });
}

function success(
  host: string,
  repositoryPath: string,
  provenance: NormalizedGitRemote["provenance"],
): GitRemoteNormalization {
  return {
    ok: true,
    remote: {
      canonical: `${host}/${repositoryPath}`,
      host,
      repositoryPath,
      provenance,
    },
  };
}

function normalizeRepositoryPath(
  rawPath: string,
  hostname: string,
): string | undefined {
  let path = rawPath
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\/{2,}/gu, "/");
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  path = path.normalize("NFKC");
  if (
    path.length === 0 ||
    path.length > 3_072 ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f?#]/u.test(path)
  ) {
    return undefined;
  }
  return CASE_INSENSITIVE_PATH_HOSTS.has(hostname.toLowerCase())
    ? path.toLowerCase()
    : path;
}

function canonicalHost(hostname: string, port: string): string {
  const host = hostname.toLowerCase();
  return port.length === 0 ? host : `${host}:${port}`;
}

function protocolTransport(protocol: string): Exclude<GitRemoteTransport, "scp"> | undefined {
  switch (protocol) {
    case "https:":
      return "https";
    case "http:":
      return "http";
    case "ssh:":
      return "ssh";
    case "git:":
      return "git";
    default:
      return undefined;
  }
}

function reject(reason: GitRemoteRejectionReason): GitRemoteNormalization {
  return { ok: false, reason };
}
