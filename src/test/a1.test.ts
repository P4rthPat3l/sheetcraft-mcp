import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRange,
  parseFullRange,
  splitSheetPrefix,
  resolveSheet,
  colName,
  colToIndex,
  toConcreteA1,
  quoteSheetName,
  rangeBounds,
  toGridRange,
  A1Error,
  type SheetRef,
} from '../lib/a1.js';

const sheets: SheetRef[] = [
  { title: 'Sheet1', sheetId: 0 },
  { title: 'My Data', sheetId: 42 },
  { title: "Jon's Data", sheetId: 7 },
];

test('colName round-trips', () => {
  assert.equal(colName(1), 'A');
  assert.equal(colName(26), 'Z');
  assert.equal(colName(27), 'AA');
  assert.equal(colName(52), 'AZ');
  assert.equal(colName(703), 'AAA');
  assert.equal(colName(18278), 'ZZZ');
  assert.throws(() => colName(0), A1Error);
  assert.throws(() => colName(18279), A1Error);
});

test('colToIndex parses A..ZZZ', () => {
  assert.equal(colToIndex('A'), 1);
  assert.equal(colToIndex('Z'), 26);
  assert.equal(colToIndex('AA'), 27);
  assert.equal(colToIndex('ZZZ'), 18278);
  assert.throws(() => colToIndex('ZZZZ'), A1Error);
  assert.throws(() => colToIndex('1A'), A1Error);
});

test('parseRange: single cell, two cells, open ends, row/col-only', () => {
  assert.deepEqual(parseRange('A1'), { startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
  assert.deepEqual(parseRange('A1:D10'), { startRow: 1, startCol: 1, endRow: 10, endCol: 4 });
  assert.deepEqual(parseRange('A5:B'), { startRow: 5, startCol: 1, endRow: null, endCol: 2 });
  assert.deepEqual(parseRange('A5:5'), { startRow: 5, startCol: 1, endRow: 5, endCol: null });
  assert.deepEqual(parseRange('A:C'), { startRow: null, startCol: 1, endRow: null, endCol: 3 });
  assert.deepEqual(parseRange('2:4'), { startRow: 2, startCol: null, endRow: 4, endCol: null });
  assert.equal(parseRange('not a range'), null);
  assert.equal(parseRange(''), null);
});

test('parseRange normalizes swapped bounds', () => {
  assert.deepEqual(parseRange('B2:A1'), { startRow: 1, startCol: 1, endRow: 2, endCol: 2 });
  const r = parseRange('D1:A2');
  assert.ok(r);
  assert.equal(r.startCol, 1);
  assert.equal(r.endCol, 4);
  assert.equal(r.startRow, 1);
  assert.equal(r.endRow, 2);
});

test('splitSheetPrefix: unquoted, quoted, escaped quote, whole-sheet', () => {
  assert.deepEqual(splitSheetPrefix('Sheet1!A1:B2'), { sheet: 'Sheet1', range: 'A1:B2' });
  assert.deepEqual(splitSheetPrefix("'My Data'!A1"), { sheet: 'My Data', range: 'A1' });
  assert.deepEqual(splitSheetPrefix("'Jon''s Data'!A1"), { sheet: "Jon's Data", range: 'A1' });
  assert.deepEqual(splitSheetPrefix('A1:B2'), { sheet: null, range: 'A1:B2' });
  assert.deepEqual(splitSheetPrefix("'My Data'"), { sheet: 'My Data', range: '' });
  assert.throws(() => splitSheetPrefix("'Unterminated!A1"), A1Error);
});

test('splitSheetPrefix auto-repairs unquoted names with spaces (AC: agent quote slips never hard-fail)', () => {
  // no quotes at all
  assert.deepEqual(splitSheetPrefix('Final Proposed structure!A1:Z3'), {
    sheet: 'Final Proposed structure',
    range: 'A1:Z3',
  });
  // one stray trailing quote (observed in the wild)
  assert.deepEqual(splitSheetPrefix("Email Audit'!A38:M45"), { sheet: 'Email Audit', range: 'A38:M45' });
  // auto-repair composes with whole-sheet and escaped quotes
  assert.deepEqual(splitSheetPrefix('My Sheet'), { sheet: null, range: 'My Sheet' });
  assert.deepEqual(splitSheetPrefix("Jon' Data!A1"), { sheet: "Jon' Data", range: 'A1' });
  // correct input untouched
  assert.deepEqual(splitSheetPrefix("'My Sheet'!A1"), { sheet: 'My Sheet', range: 'A1' });
  // a bad RANGE after a repairable name is the range parser's job, not ours
  assert.deepEqual(splitSheetPrefix('Bad Name!A]1'), { sheet: 'Bad Name', range: 'A]1' });
});

test('parseFullRange: whole sheet via bare name or *', () => {
  assert.deepEqual(parseFullRange("'My Sheet'"), { sheet: 'My Sheet', parsed: { startRow: null, startCol: null, endRow: null, endCol: null } });
  assert.deepEqual(parseFullRange('Sheet1!*').sheet, 'Sheet1');
});

test('parseFullRange rejects garbage with teaching message', () => {
  try {
    parseFullRange('Sheet1!A0');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof A1Error, `expected A1Error, got ${(e as Error).constructor.name}`);
    assert.match(e.message, /Invalid range/);
  }
  try {
    parseFullRange('Sheet1!not-a-range');
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof A1Error);
  }
});

const SHEETS: SheetRef[] = [
  { title: 'Sheet1', sheetId: 0 },
  { title: 'Data 2024', sheetId: 42 },
];

test('resolveSheet: name, gid, bare gid, case-insensitive', () => {
  assert.equal(resolveSheet('Sheet1', SHEETS), 0);
  assert.equal(resolveSheet('data 2024', SHEETS), 42);
  assert.equal(resolveSheet('gid:42', SHEETS), 42);
  assert.equal(resolveSheet('42', SHEETS), 42);
});

test('resolveSheet: ambiguity and not-found produce teaching errors', () => {
  const dup: SheetRef[] = [
    { title: 'X', sheetId: 1 },
    { title: 'x', sheetId: 2 },
  ];
  assert.throws(() => resolveSheet('X', dup), /gid:N to disambiguate|Use gid:N/);
  try {
    resolveSheet('Nope', SHEETS);
    assert.fail('should throw');
  } catch (e) {
    assert.match((e as Error).message, /Sheets: /);
  }
  assert.throws(() => resolveSheet('999', SHEETS), /No sheet with gid 999/);
});

test('toConcreteA1: clamps open ends to sheet dims', async () => {
  const sheets2: SheetRef[] = [{ title: 'S', sheetId: 5 }];
  const dims = new Map([[5, { rows: 100, cols: 3 }]]);
  const a1 = await toConcreteA1('S!A:C', sheets2, (gid) => dims.get(gid));
  assert.equal(a1, 'S!A1:C100'); // S needs no quoting
  const a1b = await toConcreteA1("'S'!B2:", sheets2, (gid) => dims.get(gid));
  assert.equal(a1b, 'S!B2:C100');
});

test('toConcreteA1: whole sheet → bare quoted name', async () => {
  const a1 = await toConcreteA1("'Data 2024'", SHEETS, () => undefined);
  assert.equal(a1, "'Data 2024'");
});

test('toGridRange: open ends stay undefined', () => {
  const g = toGridRange("'Data 2024'!A5:C", SHEETS);
  assert.equal(g.sheetId, 42);
  assert.equal(g.startRowIndex, 4);
  assert.equal(g.endRowIndex, undefined);
  assert.equal(g.startColumnIndex, 0);
  assert.equal(g.endColumnIndex, 3);
});

test('rangeBounds clamps to dims', () => {
  const { parsed } = parseFullRange('A1:Z100');
  const b = rangeBounds(parsed, { rows: 10, cols: 3 });
  // Z100 requests 26 cols but the sheet has 3; rows are within bounds
  assert.deepEqual({ rows: b.rows, cols: b.cols }, { rows: 10, cols: 3 });
  const b2 = rangeBounds(parseFullRange('A1:C50').parsed, { rows: 10, cols: 3 });
  assert.deepEqual({ rows: b.rows, cols: b.cols }, { rows: 10, cols: 3 });
});

test('quoteSheetName quotes when needed', () => {
  assert.equal(quoteSheetName('Sheet1'), 'Sheet1');
  assert.equal(quoteSheetName('My Sheet'), "'My Sheet'");
  assert.equal(quoteSheetName("Jon's"), "'Jon''s'");
  assert.equal(quoteSheetName('A1'), "'A1'"); // looks like a cell ref
});