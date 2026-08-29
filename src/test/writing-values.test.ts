import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrayParam } from '../ops/writing-values.js';
import { SheetsError } from '../lib/errors.js';

test('arrayParam: arrays pass through untouched', () => {
  const arr = [{ range: 'A1:B2', values: [['a']] }];
  assert.equal(arrayParam(arr, 'writes'), arr);
  assert.deepEqual(arrayParam([], 'x'), []);
});

test('arrayParam: JSON string coercion (AC: array-as-string never reaches the SDK validator)', () => {
  // observed failure: model sends writes as a serialized string
  assert.deepEqual(arrayParam('[{"range":"A1","values":[["a"]]}]', 'writes'), [
    { range: 'A1', values: [['a']] },
  ]);
  assert.deepEqual(arrayParam('["A1:B2","C1:D2"]', 'ranges'), ['A1:B2', 'C1:D2']);
  // whitespace-padded and single-quoted variant (models do this too)
  assert.deepEqual(arrayParam(' [ [1, 2] ] ', 'values'), [[1, 2]]);
});

test('arrayParam: wrong shapes teach with the expected form', () => {
  // parses to an object, not an array
  assert.throws(() => arrayParam('{"range":"A1"}', 'writes'), (e: unknown) => {
    assert.ok(e instanceof SheetsError);
    assert.match(e.message, /parsed as an object, expected an array/);
    assert.match(e.message, /writes/);
    return true;
  });
  // not JSON at all → JSON error surfaced, param named
  assert.throws(() => arrayParam('[[a", [', 'values'), (e: unknown) => {
    assert.ok(e instanceof SheetsError);
    assert.match(e.message, /"values" is a string but not valid JSON/);
    return true;
  });
  // wrong type entirely
  assert.throws(() => arrayParam(42, 'rows'), /"rows" must be an array \(got number\)/);
  assert.throws(() => arrayParam(null, 'writes'), /"writes" must be an array \(got null\)/);
});