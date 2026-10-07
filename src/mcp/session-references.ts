export const SESSION_RESOURCE_TEMPLATE = "context-bridge://sessions/{sessionId}";

export interface McpSessionReference {
  readonly uri: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly description?: string;
  readonly lastModified?: string;
}

export interface McpSessionReferenceApplication {
  searchSessionReferences(query: string): Promise<readonly McpSessionReference[]>;
  readSessionReference(uri: string): Promise<object | undefined>;
}

export function sessionResourceUri(sessionId: string): string {
  return `context-bridge://sessions/${encodeURIComponent(sessionId)}`;
}
