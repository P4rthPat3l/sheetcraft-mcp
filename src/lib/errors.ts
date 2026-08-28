/** Stable machine-readable code embedded in every SheetsError; the text is for the model. */
export const SHEETS_ERROR_CODE = {
  /** Bad A1 range / bad input the model can fix. Retry with corrected args. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** No access to the spreadsheet/file. Not fixable by retrying; check sharing. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Spreadsheet or file does not exist (or the SA can't see it). */
  NOT_FOUND: 'NOT_FOUND',
  /** Google quota exhausted after internal retries. Safe to retry later. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Google-side 5xx after retries; transient. */
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  /** Missing config (credentials, toolset typo). */
  CONFIG: 'CONFIG',
  /** Anything else. */
  INTERNAL: 'INTERNAL',
} as const;
export type SheetsErrorCode = (typeof SHEETS_ERROR_CODE)[keyof typeof SHEETS_ERROR_CODE];

/** Error type thrown by the shared core; wrappers render it, never swallow it. */
export class SheetsError extends Error {
  readonly code: SheetsErrorCode;
  readonly retryable: boolean;
  /** Extra context for structured results (e.g. parsed ranges on failure). */
  readonly details?: Record<string, unknown>;

  constructor(code: SheetsErrorCode, message: string, opts?: {
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(message);
    this.name = 'SheetsError';
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.details = opts?.details;
  }
}

export function isSheetsError(e: unknown): e is SheetsError {
  return e instanceof SheetsError;
}

export function toSheetsError(e: unknown): SheetsError {
  if (isSheetsError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new SheetsError(SHEETS_ERROR_CODE.INTERNAL, `Internal error: ${msg}`);
}

/** Convenience for ops that failed validation: throws SheetsError with INVALID_ARGUMENT. */
export function opError(message: string, details?: Record<string, unknown>): never {
  throw new SheetsError(SHEETS_ERROR_CODE.INVALID_ARGUMENT, message, { details });
}