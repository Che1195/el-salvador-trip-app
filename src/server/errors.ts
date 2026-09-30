export type ErrorCode =
  | "unauthenticated"
  | "unavailable"
  | "forbidden"
  | "insufficient_scope"
  | "untrusted_origin"
  | "validation_failed"
  | "unknown_operation"
  | "not_found"
  | "conflict"
  | "confirmation_required"
  | "idempotency_key_reused"
  | "limit_exceeded"
  | "rate_limited"
  | "payload_too_large"
  | "unsupported_media_type"
  | "invalid_credentials"
  | "internal_error";

/** Extra fields on an error. Callers only ever put ids, revisions and field paths here. */
export type ErrorDetails = Record<string, unknown>;

/**
 * A failure the caller can act on. `message` and `details` are written by
 * this codebase, never copied from stored trip content, so they are safe to
 * return to a client.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  insufficient_scope: 403,
  untrusted_origin: 403,
  validation_failed: 400,
  unknown_operation: 400,
  confirmation_required: 400,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  limit_exceeded: 422,
  rate_limited: 429,
  internal_error: 500,
  unavailable: 503,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
