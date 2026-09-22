export const ERROR_CODES = {
  NO_SOURCE: "NO_SOURCE",
  AMBIGUOUS_SCOPE: "AMBIGUOUS_SCOPE",
  EXCLUDED: "EXCLUDED",
  INDEXING: "INDEXING",
  SEMANTIC_UNAVAILABLE: "SEMANTIC_UNAVAILABLE",
  NOT_FOUND: "NOT_FOUND",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  CORRUPT_SOURCE: "CORRUPT_SOURCE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// interfaces are used to describe the shape of the objects. They keys are strings only and the values can be unknown type
export interface ErrorDetails {
  readonly [key: string]: unknown;
}

// This class defines the structure for a ContextBridge error.
export class ContextBridgeError extends Error {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;

  constructor(
    code: ErrorCode,
    message: string,
    details: ErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);

    this.name = "ContextBridgeError";
    this.code = code;
    this.details = details;
  }
}

export function isContextBridgeError(
  error: unknown,
): error is ContextBridgeError {
  return error instanceof ContextBridgeError;
}

export interface SerializedContextBridgeError {
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
}

export function serializeContextBridgeError(
  error: ContextBridgeError,
): SerializedContextBridgeError {
  return {
    code: error.code,
    message: error.message,
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}
