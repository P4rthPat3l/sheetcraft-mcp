import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodSchema, zodToJsonSchema } from '../lib/schema.js';
import { z } from 'zod';
import { ALL_OPS } from '../ops/index.js';
import { TOOLSET_GROUPS, type Op } from '../lib/types.js';
import { selectToolsets, assertValidToolsets, getOp, listToolsets } from '../lib/registry.js';
import { zodSchema as zs } from '../lib/schema.js';

test('schema: parse returns normalized args on success', () => {
  const s = zodSchema(z.object({ n: z.number(), s: z.string().default('x') }));
  assert.throws(() => s.parse({ n: '5' }), /number/); // '5' string is rejected — wrappers coerce
  const ok = s.parse({ n: 5 });
  assert.deepEqual(ok, { n: 5, s: 'x' }); // default applied
});

test('schema: parse throws SheetsError with field path', async () => {
  const { zodSchema } = await import('../lib/schema.js');
  const { SheetsError } = await import('../lib/errors.js');
  const s = zodSchema(z.object({ range: z.string().min(1) }));
  try {
    s.parse({});
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.match(e.message, /range/);
  }
});

test('schema: jsonSchema derives required + properties + enum', async () => {
  const { zodSchema } = await import('../lib/schema.js');
  const schema = zodSchema(
    z.object({
      a: z.string().min(1).describe('A param'),
      b: z.enum(['x', 'y']).default('x'),
      n: z.number().int().optional(),
    }),
  );
  const js = schema.jsonSchema as { required?: string[]; properties: Record<string, { type?: string; enum?: string[]; description?: string; default?: unknown }> };
  assert.deepEqual(js.required, ['a']);
  assert.equal(js.properties.a?.type, 'string');
  assert.equal(js.properties.a?.description, 'A param');
  assert.deepEqual(js.properties.b?.enum, ['x', 'y']);
  assert.equal(js.properties.b?.default, 'x');
});

test('every op has a valid schema, annotations, and unique names', () => {
  const names = new Set<string>();
  for (const op of ALL_OPS) {
    assert.ok(op.name.length >= 3, `op name too short: ${op.name}`);
    assert.match(op.name, /^[a-z_]+$/);
    assert.ok(op.description.length > 10 && op.description.length < 400, `description length off for ${op.name}`);
    assert.ok(op.inputSchema.jsonSchema.type === 'object');
    assert.ok(typeof op.run === 'function');
    assert.ok(TOOLSET_GROUPS.includes(op.group));
    names.add(op.name);
    const a = op.annotations;
    if (a.readOnlyHint) assert.equal(a.destructiveHint, false, `${op.name}: read-only must not be destructive`);
  }
  assert.equal(names.size, ALL_OPS.length, 'duplicate op names');
});

test('registry: selectToolsets resolves groups and all', () => {
  const core = selectToolsets('core');
  assert.ok(core.length >= 10);
  assert.ok(core.every((op: Op) => op.group === 'core'));
  const both = selectToolsets('core,drive');
  assert.ok(both.some((op: Op) => op.group === 'drive'));
  const all = selectToolsets('all');
  assert.equal(all.length, ALL_OPS.length);
  // 'all' as part of a list
  const all2 = selectToolsets(['core', 'all']);
  assert.equal(all2.length, ALL_OPS.length);
});

test('registry: assertValidToolsets rejects typos', () => {
  assert.throws(() => assertValidToolsets('core,driv'), /Unknown toolset/);
  assert.doesNotThrow(() => assertValidToolsets('core,drive'));
  assert.doesNotThrow(() => assertValidToolsets('all'));
});

test('registry: getOp finds by name', () => {
  assert.ok(getOp('get_values'));
  assert.equal(getOp('nope'), undefined);
  assert.ok(listToolsets().length === 6);
});

// unused import guard
void zodToJsonSchema;
void z;