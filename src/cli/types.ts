import type {
  ExportScopeInput,
  ExportScopeResult,
  ForgetScopeInput,
  ForgetScopeResult,
  ReindexInput,
  ReindexResult,
} from "../app/index.js";
import type { ProjectId } from "../contracts/ids.js";
import type { McpReadApplication } from "../mcp/index.js";

export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";

export interface CliApplication extends McpReadApplication {
  initialize(input: {
    readonly codexHomes?: readonly string[];
    readonly includeProjectIds?: readonly ProjectId[];
    readonly excludeProjectIds?: readonly ProjectId[];
  }): Promise<object>;
  listSources(): Promise<object>;
  index(input: { readonly initial: boolean }): Promise<object>;
  doctor(): Promise<object>;
  reindex(input: Omit<ReindexInput, "chunkPolicy">): Promise<ReindexResult>;
  forget(input: ForgetScopeInput): Promise<ForgetScopeResult>;
  exportScope(input: ExportScopeInput, outputPath?: string): Promise<ExportScopeResult | object>;
  service(action: ServiceAction): Promise<object>;
  serveStdio(): Promise<void>;
  serveHttp(): Promise<void>;
  close(): Promise<void>;
}

export interface CliApplicationOptions {
  readonly configPath?: string;
}

export interface CliIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export class CliUsageError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_ARGUMENT") {
    super(message);
    this.name = "CliUsageError";
    this.code = code;
  }
}
