import { toSheetsError, SHEETS_ERROR_CODE } from './errors.js';
import type { Op, OpResult } from './types.js';
import type { Svc } from './ctx.js';

export interface RunOptions {
  /** Render structured data as JSON text block too (default true). */
  json?: boolean;
}

/**
 * Execute an op and render the result for a wrapper.
 * Never throws: failures come back as OpResult.error with a teaching message,
 * so MCP maps directly to isError:true and the CLI exits non-zero with the text.
 */
export async function runOp(op: Op, args: unknown, svc: Svc, opts: RunOptions = {}): Promise<OpResult> {
  try {
    const parsed = op.inputSchema.parse(args);
    const data = await op.run(parsed, svc);
    return render(data, opts);
  } catch (err) {
    return renderError(err);
  }
}

function render(data: unknown, opts: RunOptions): OpResult {
  if (isOpResult(data)) return data;
  if (typeof data === 'string') return { text: data };
  if (opts.json !== false && data !== null && typeof data === 'object') {
    return {
      text: JSON.stringify(data, null, 2),
      structured: data as Record<string, unknown>,
    };
  }
  return { text: String(data) };
}

export function renderError(err: unknown): OpResult {
  const e = toSheetsError(err);
  const lines = [messageOf(e)];
  return {
    text: lines.join('\n'),
    error: { code: e.code, retryable: e.retryable, details: e.details },
  };
}

function messageOf(e: import('./errors.ts').SheetsError): string {
  if (e.code === SHEETS_ERROR_CODE.RATE_LIMITED) {
    return `${e.message} (retried automatically; if it persists, wait a minute and retry — Google quota refills per minute)`;
  }
  return e.message;
}

function isOpResult(x: unknown): x is OpResult {
  return (
    x !== null &&
    typeof x === 'object' &&
    'text' in x &&
    typeof (x as { text: unknown }).text === 'string'
  );
}