import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SheetsError, SHEETS_ERROR_CODE, isSheetsError, toSheetsError, opError } from '../lib/errors.js';
import { classifyGoogleError } from '../lib/retry.js';
import { executeWithRetry } from '../lib/retry.js';
import { renderError } from '../lib/run.js';

test('SheetsError carries code + retryability', () => {
  const e = new SheetsError(SHEETS_ERROR_CODE.RATE_LIMITED, 'slow down', { retryable: true });
  assert.equal(e.code, 'RATE_LIMITED');
  assert.equal(e.retryable, true);
  assert.equal(isSheetsError(e), true);
});

test('toSheetsError passes through SheetsError, wraps others', () => {
  const e = new SheetsError('INVALID_ARGUMENT', 'bad range');
  assert.equal(toSheetsError(e), e);
  const wrapped = toSheetsError(new Error('boom'));
  assert.equal(wrapped.code, 'INTERNAL');
});

test('classifyGoogleError: 403 permission vs rate limit', () => {
  const perm = { code: 403, errors: [{ reason: 'forbidden' }], message: 'The caller does not have permission' };
  assert.equal(classifyGoogleError(perm).code, 'PERMISSION_DENIED');
  assert.equal(classifyGoogleError(perm).retryable, false);
  const rate = { code: 403, errors: [{ reason: 'rateLimitExceeded' }], message: 'Quota exceeded' };
  assert.equal(classifyGoogleError(rate).code, 'RATE_LIMITED');
  assert.equal(classifyGoogleError(rate).retryable, true);
});

test('classifyGoogleError: 429/5xx retryable, 400/404 not', () => {
  assert.equal(classifyGoogleError({ code: 429 }).retryable, true);
  assert.equal(classifyGoogleError({ code: 503 }).retryable, true);
  assert.equal(classifyGoogleError({ code: 400 }).retryable, false);
  assert.equal(classifyGoogleError({ code: 404 }).retryable, false);
  assert.equal(classifyGoogleError({ code: 400, response: { data: { error: { message: 'Invalid range' } } } }).message, 'Bad request: Invalid range');
});

test('executeWithRetry retries retryable errors then succeeds', async () => {
  let calls = 0;
  const { result, attempts } = await executeWithRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const e = new Error('Rate limit exceeded') as Error & { code?: number };
        e.code = 429;
        throw e;
      }
      return 'ok';
    },
    { attempts: 5, baseMs: 1, maxMs: 2 },
  );
  assert.equal(calls, 3);
  assert.equal(attempts, 3);
  assert.equal(result, 'ok');
});

test('executeWithRetry does not retry invalid args', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeWithRetry(async () => {
        calls++;
        const e = new Error('bad range');
        (e as { code?: number }).code = 400;
        throw e;
      }),
    (err: unknown) => isSheetsError(err) && err.code === 'INVALID_ARGUMENT',
  );
  assert.equal(calls, 1);
});

test('executeWithRetry throws after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeWithRetry(
        () => {
          calls++;
          const e = new Error('Rate limit exceeded');
          (e as { code?: number }).code = 429;
          throw e;
        },
        { attempts: 2, baseMs: 1, maxMs: 2 },
      ),
    (err: unknown) => isSheetsError(err) && err.code === 'RATE_LIMITED',
  );
  assert.equal(calls, 2);
});

test('runOp renders failures as OpResult.error, never throws', async () => {
  const { runOp } = await import('../lib/run.js');
  const { SheetsError, SHEETS_ERROR_CODE } = await import('../lib/errors.js');
  const op = {
    name: 'x',
    group: 'core' as const,
    description: 'x',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      jsonSchema: { type: 'object' },
      parse: () => {
        // real schema failures throw SheetsError(INVALID_ARGUMENT); simulate one
        throw new SheetsError(SHEETS_ERROR_CODE.INVALID_ARGUMENT, 'Invalid arguments — range: Required');
      },
    },
    run: async () => 'ok',
  };
  const res = await runOp(op as never, {}, {} as never);
  assert.equal(typeof res.text, 'string');
  assert.equal(res.error?.code, 'INVALID_ARGUMENT');

  // op.run throwing a non-Sheets error is a bug → INTERNAL, still rendered not thrown
  const op2 = {
    ...op,
    inputSchema: { jsonSchema: { type: 'object' }, parse: () => ({}) },
    run: async () => {
      throw new Error('exploded');
    },
  };
  const res2 = await runOp(op2 as never, {}, {} as never);
  assert.equal(res2.error?.code, 'INTERNAL');
});

test('opError throws SheetsError with INVALID_ARGUMENT', () => {
  try {
    opError('nope', { x: 1 });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(isSheetsError(e));
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.deepEqual(e.details, { x: 1 });
  }
});

import { SheetsError as SE, SHEETS_ERROR_CODE as CODE } from '../lib/errors.js';