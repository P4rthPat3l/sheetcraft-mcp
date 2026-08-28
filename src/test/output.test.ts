import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatValuesOutput, cellCap, truncationNotice, recordsOf, MAX_CELLS_DEFAULT } from '../lib/output.js';

const rows: (string | number | boolean | null)[][] = [
  ['name', 'qty', 'ok'],
  ['Widget', 5, true],
  ['Do, "Re" Mi', 2, false],
];

test('csv output quotes fields containing separators/quotes/newlines', () => {
  const out = formatValuesOutput(rows, 'csv');
  assert.equal(out, 'name,qty,ok\nWidget,5,true\n"Do, ""Re"" Mi",2,false');
});

test('tsv output', () => {
  const out = formatValuesOutput([['a', 'b'], ['c\td', 'e']], 'tsv');
  assert.equal(out, 'a\tb\n"c\td"\te');
});

test('grid output is a JSON 2D array', () => {
  const out = formatValuesOutput(rows, 'grid');
  assert.deepEqual(JSON.parse(out), rows);
});

test('records joins the header row', () => {
  const out = JSON.parse(formatValuesOutput(rows, 'records'));
  assert.deepEqual(out, [{ name: 'Widget', qty: 5, ok: true }, { name: 'Do, "Re" Mi', qty: 2, ok: false }]);
});

test('cellCap truncates by whole rows and reports omissions', () => {
  const big: (string | number | boolean | null)[][] = Array.from({ length: 100 }, (_, i) => [i, 'x', 'y']);
  const capped = cellCap(big, 50);
  assert.equal(capped.truncated, true);
  assert.equal(capped.values.length, 16); // floor(50 / 3 cols) rows fit
  assert.equal(capped.omittedRows, 84);
  assert.equal(capped.totalCells, 300);
});

test('cellCap passes through when under cap', () => {
  const r = cellCap(rows, MAX_CELLS_DEFAULT);
  assert.equal(r.truncated, false);
  assert.equal(r.values, rows);
});

test('records header fallback for empty header cells', () => {
  const recs = recordsOf([['', 'b'], ['1', '2']]);
  assert.deepEqual(Object.keys(recs[0]!), ['col1', 'b']);
});