import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setDataValidationOp } from '../ops/structure.js';
import { ALL_OPS } from '../ops/index.js';
import { SheetsError } from '../lib/errors.js';

// The run() body needs Google API access for everything past arg validation, so
// unit tests exercise the schema + the pure validation paths (live probes cover
// the rest — see AGENTS.md testing note).

test('set_data_validation: schema rejects unknown types', () => {
  const schema = setDataValidationOp.inputSchema.jsonSchema as { properties: { type: { enum: string[] } } };
  // JSON Schema is derived from the zod enum, so the enum check covers type validation
  assert.ok(!schema.properties.type.enum.includes('DROPDOWN'));
});

test('set_data_validation: registered in core group with the checkbox enum fixed to BOOLEAN', () => {
  assert.equal(setDataValidationOp.group, 'core');
  assert.ok(ALL_OPS.includes(setDataValidationOp));
  const schema = setDataValidationOp.inputSchema.jsonSchema as { properties: { type: { enum: string[] } } };
  assert.ok(schema.properties.type.enum.includes('BOOLEAN'));
  assert.ok(!schema.properties.type.enum.includes('CHECKBOX')); // live-probed: Google rejects CHECKBOX
});

test('set_data_validation: clearValidation + type is rejected before any API call', async () => {
  await assert.rejects(
    () => setDataValidationOp.run(
      setDataValidationOp.inputSchema.parse({ spreadsheetId: 'TEST1234567890abcdefghijklmnopqrst', range: 'A1', clearValidation: true, type: 'BOOLEAN' }) as never,
      {} as never,
    ),
    (e: unknown) => {
      assert.ok(e instanceof SheetsError);
      assert.match(e.message, /EITHER clearValidation.*OR type\/values/);
      return true;
    },
  );
});

test('set_data_validation: missing type teaches next steps', async () => {
  await assert.rejects(
    () => setDataValidationOp.run(
      setDataValidationOp.inputSchema.parse({ spreadsheetId: 'TEST1234567890abcdefghijklmnopqrst', range: 'A1' }) as never,
      {} as never,
    ),
    (e: unknown) => {
      assert.ok(e instanceof SheetsError);
      assert.match(e.message, /ONE_OF_LIST/);
      assert.match(e.message, /clearValidation/);
      return true;
    },
  );
});