export interface CliErrorResult {
  readonly status: "error";
  readonly error: { readonly code: string; readonly message: string };
}

export function renderCliResult(value: object, json: boolean): string {
  return `${JSON.stringify(value, null, json ? 0 : 2)}\n`;
}

export function renderCliError(code: string, message: string, json: boolean): string {
  return renderCliResult({ status: "error", error: { code, message } }, json);
}
