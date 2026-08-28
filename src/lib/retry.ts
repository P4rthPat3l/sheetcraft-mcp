import { SheetsError, SHEETS_ERROR_CODE, isSheetsError, type SheetsErrorCode } from './errors.js';

export interface RetryConfig {
  attempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryConfig = { attempts: 3, baseMs: 300, maxMs: 8_000 };

/** Classify a Google API error into a SheetsError code + retryability. */
export function classifyGoogleError(err: unknown): { code: SheetsErrorCode; retryable: boolean; message: string } {
  const anyErr = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: unknown };
    message?: string;
    type?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  } | null;
  const numericCode = typeof anyErr?.code === 'number' ? anyErr.code : undefined;
  const status: number | undefined =
    numericCode ?? anyErr?.status ?? anyErr?.response?.status;
  const gapiErrors = Array.isArray(anyErr?.errors) ? anyErr!.errors : [];
  const reason = gapiErrors[0]?.reason ?? '';
  const raw = anyErr?.message ?? String(err);

  // Extract Google's message body when available
  let message = raw;
  const data = anyErr?.response?.data;
  if (data && typeof data === 'object' && 'error' in data) {
    const e = (data as { error: { message?: string; status?: string } }).error;
    if (e?.message) message = e.message;
  }

  if (status === 400) return { code: SHEETS_ERROR_CODE.INVALID_ARGUMENT, retryable: false, message: `Bad request: ${message}` };
  if (status === 401) return { code: SHEETS_ERROR_CODE.PERMISSION_DENIED, retryable: false, message: `Authentication failed: ${message}` };
  if (status === 403) {
    if (reason === 'storageQuotaExceeded') {
      return {
        code: SHEETS_ERROR_CODE.PERMISSION_DENIED,
        retryable: false,
        message:
          'Cannot create the file: this account has no Google Drive storage (service accounts get 0 bytes by policy). ' +
          'Fix: run `sheets auth login` to act as your own Google account, or share an existing spreadsheet with the service account and work inside it.',
      };
    }
    const rateReasons = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded', 'quotaExceeded']);
    if (rateReasons.has(reason) || /rate limit/i.test(message)) {
      return { code: SHEETS_ERROR_CODE.RATE_LIMITED, retryable: true, message: `Google rate limit hit: ${message}` };
    }
    return { code: SHEETS_ERROR_CODE.PERMISSION_DENIED, retryable: false, message };
  }
  if (status === 404) return { code: SHEETS_ERROR_CODE.NOT_FOUND, retryable: false, message };
  if (status === 429) return { code: SHEETS_ERROR_CODE.RATE_LIMITED, retryable: true, message: `Google rate limit hit: ${message}` };
  if (status !== undefined && status >= 500) {
    return { code: SHEETS_ERROR_CODE.UPSTREAM_ERROR, retryable: true, message: `Google server error: ${message}` };
  }
  // Transient network failures (no HTTP status at all): connection resets,
  // DNS hiccups, timeouts. These are the most common transient errors for a
  // long-lived process — retry them like 5xx.
  const netCode = typeof anyErr?.code === 'string' ? anyErr.code : '';
  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(netCode)) {
    return { code: SHEETS_ERROR_CODE.UPSTREAM_ERROR, retryable: true, message: `Network error (${netCode}): ${message}` };
  }
  if (anyErr?.type === 'request-timeout' || /timeout|aborted/i.test(message)) {
    return { code: SHEETS_ERROR_CODE.UPSTREAM_ERROR, retryable: true, message: `Request timed out: ${message}` };
  }
  return { code: SHEETS_ERROR_CODE.INTERNAL, retryable: false, message: raw };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a Google API call with truncated exponential backoff + jitter.
 * Retries 429 / 5xx / 403-with-rate-limit-reason; surfaces SheetsError otherwise.
 */
export async function executeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  cfg: Partial<RetryConfig> = {},
): Promise<{ result: T; attempts: number }> {
  const c = { ...DEFAULT_RETRY, ...cfg };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= c.attempts; attempt++) {
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;
      const cls = classifyGoogleError(err);
      if (!cls.retryable || attempt === c.attempts) throw toSheetsLike(err, cls);
      const jitter = Math.floor(Math.random() * 250);
      const wait = Math.min(c.baseMs * 2 ** (attempt - 1) + jitter, c.maxMs);
      await sleep(wait);
    }
  }
  throw toSheetsLike(lastErr, classifyGoogleError(lastErr));
}

function toSheetsLike(err: unknown, cls: { code: SheetsErrorCode; retryable: boolean; message: string }): SheetsError {
  if (isSheetsError(err)) return err;
  return new SheetsError(cls.code, cls.message, { retryable: cls.retryable });
}