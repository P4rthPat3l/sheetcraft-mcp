import type { sheets_v4 } from 'googleapis';
import { SheetsError } from './errors.js';

/** Google's documented per-spreadsheet limits. */
export const A1_MAX_COL = 18278; // column ZZZ
export const A1_MAX_ROW = 10_000_000;

export class A1Error extends SheetsError {
  constructor(message: string) {
    super('INVALID_ARGUMENT', message);
    this.name = 'A1Error';
  }
}

/** 1 → A, 26 → Z, 27 → AA, 18278 → ZZZ. Throws on out-of-range input. */
export function colName(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > A1_MAX_COL) {
    throw new A1Error(`Column number ${n} outside 1..${A1_MAX_COL}.`);
  }
  let s = '';
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

/** A → 1, Z → 26, AA → 27. Throws A1Error on garbage. */
export function colToIndex(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) {
    throw new A1Error(`Invalid column "${letters}" in range. Columns are A..ZZZ.`);
  }
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  if (n > A1_MAX_COL) throw new A1Error(`Column "${letters}" exceeds the maximum (ZZZ).`);
  return n;
}

export function looksLikeCellRef(s: string): boolean {
  return /^[A-Za-z]{1,3}\d+$/.test(s);
}

function parseCellRef(s: string): { row: number; col: number } | null {
  const m = /^([A-Za-z]{1,3})(\d{1,8})$/.exec(s);
  if (!m) return null;
  const col = colToNumLoose(m[1]!);
  if (col === null) return null;
  const row = Number(m[2]!);
  if (row < 1) return null; // A0 is not a valid cell
  return { col, row };
}

function colToNumLoose(letters: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n > A1_MAX_COL ? null : n;
}

/** A range without a sheet prefix. Null bounds mean "open" (to the sheet edge). */
export interface ParsedRange {
  startRow: number | null; // 1-based
  startCol: number | null; // 1-based
  endRow: number | null; // inclusive, 1-based; null = open
  endCol: number | null;
}

const ALL_NULL: ParsedRange = { startRow: null, startCol: null, endRow: null, endCol: null };

/**
 * Parse A1 notation without a sheet prefix:
 *   "A1", "A1:B2", "A:A", "1:2", "A5:A", "A5:5"
 * Returns null when the string is not a range (caller decides whether that's an error).
 */
export function parseRange(input: string): ParsedRange | null {
  const s = input.trim();
  if (s === '') return null;

  // Row-only: "1:2" (rows are 1-based; "0:2" is not a valid range)
  const rowOnly = /^(\d+)\s*:\s*(\d+)$/.exec(s);
  if (rowOnly) {
    const r1 = Number(rowOnly[1]!);
    const r2 = Number(rowOnly[2]!);
    if (r1 < 1 || r2 < 1) return null;
    return normalize(mk(r1, null, r2, null));
  }

  // Column-only: "A:B"
  const colOnly = /^([A-Za-z]{1,3})\s*:\s*([A-Za-z]{1,3})$/.exec(s);
  if (colOnly) {
    const c1 = colToNumLoose(colOnly[1]!);
    const c2 = colToNumLoose(colOnly[2]!);
    if (c1 === null || c2 === null) return null;
    return normalize(mk(null, c1, null, c2));
  }

  const parts = s.split(':');
  if (parts.length > 2) return null;

  const a = parts[0]!.trim();
  const pa = parseCellRef(a);

  if (parts.length === 1) {
    if (!pa) return null;
    return mk(pa.row, pa.col, pa.row, pa.col);
  }

  const b = parts[1]!.trim();
  if (b === '') {
    // Open-ended start form: "A1:" or "B2:" — everything from this cell onward.
    if (!pa) return null;
    return mk(pa.row, pa.col, null, null);
  }
  const pb = parseCellRef(b);

  if (pa && pb) return normalize(mk(pa.row, pa.col, pb.row, pb.col));

  if (pa && !pb) {
    // Open-ended end: "A5:B" (rows open) or "A5:5" (cols open)
    const endColOnly = /^([A-Za-z]{1,3})$/.exec(b);
    if (endOnlyIsCol(b)) {
      const c2 = colToNumLoose(b);
      if (c2 === null) return null;
      return mk(pa.row, pa.col, null, c2);
    }
    if (/^\d+$/.test(b)) {
      const endRow = Number(b);
      if (endRow < 1) return null;
      return mk(pa.row, pa.col, endRow, null);
    }
    return null;
  }

  if (!pa && pb) return null; // start must be a cell when end is
  return null;
}

function endOnlyIsCol(b: string): boolean {
  return /^[A-Za-z]{1,3}$/.test(b);
}

function mk(startRow: number | null, startCol: number | null, endRow: number | null, endCol: number | null): ParsedRange {
  return { startRow, startCol, endRow, endCol };
}

/** Normalize swapped bounds so start ≤ end. */
function normalize(p: ParsedRange): ParsedRange {
  const out = { ...p };
  if (out.startRow !== null && out.endRow !== null && out.startRow > out.endRow) {
    [out.startRow, out.endRow] = [out.endRow, out.startRow];
  }
  if (out.startCol !== null && out.endCol !== null && out.startCol > out.endCol) {
    [out.startCol, out.endCol] = [out.endCol, out.startCol];
  }
  return out;
}

/**
 * Split "Sheet 1!A1:B2" or "'Jon''s Data'!A1" into sheet name + range part.
 * Single-quoted names required for spaces/special chars; '' escapes a quote.
 * No prefix → sheet: null (caller resolves the default/only sheet).
 * A bare quoted name ('My Sheet') or trailing '!' means the whole sheet.
 */
export function splitSheetPrefix(input: string): { sheet: string | null; range: string } {
  const s = input.trim();
  if (s.startsWith("'")) {
    // Scan for the closing quote, treating '' as an escaped quote.
    let end = -1;
    for (let i = 1; i < s.length; i++) {
      if (s[i] !== "'") continue;
      if (s[i + 1] === "'") {
        i++; // skip the escaped pair
        continue;
      }
      end = i;
      break;
    }
    if (end === -1) throw new A1Error(`Unterminated quote in sheet name: ${input}. Use 'Sheet Name'!A1:B2 (double any quote inside: '').`);
    const sheet = s.slice(1, end).replace(/''/g, "'");
    const rest = s.slice(end + 1);
    if (rest === '') return { sheet, range: '' };
    if (rest.startsWith('!')) return { sheet, range: rest.slice(1) };
    throw new A1Error(`Unexpected text after sheet name in "${input}". Expected 'Sheet'!A1:B2.`);
  }
  const bang = s.indexOf('!');
  if (bang === -1) return { sheet: null, range: s };
  const sheet = s.slice(0, bang);
  if (/\s/.test(sheet)) {
    // Auto-repair: agents forget the quoting convention constantly and a hard
    // error wastes a round trip. Observed failure shapes:
    //   Final Proposed structure!A1:Z3   (no quotes at all)
    //   Email Audit'!A38:M45             (stray trailing quote)
    //   Jon' Data!A1                     (quote inside the name → double it)
    const stripped = sheet.endsWith("'") ? sheet.slice(0, -1) : sheet;
    const quoted = `'${stripped.replace(/'/g, "''")}'!${s.slice(bang + 1)}`;
    return splitSheetPrefix(quoted);
  }
  return { sheet, range: s.slice(bang + 1) };
}

export interface FullRange {
  sheet: string | null;
  parsed: ParsedRange;
}

/** Parse a full range string (optional sheet prefix). Whole sheet = empty range part or '*'. */
export function parseFullRange(input: string): FullRange {
  const { sheet, range } = splitSheetPrefix(input);
  if (range === '' || range === '*') {
    return { sheet, parsed: { startRow: null, startCol: null, endRow: null, endCol: null } };
  }
  const parsed = parseRange(range);
  if (!parsed) {
    throw new A1Error(
      `Invalid range "${range}". Examples: A1, A1:D10, A:C, 1:5, 'My Sheet'!A1:B2. ` +
      `Rows start at 1; quote sheet names containing spaces.`
    );
  }
  return { sheet, parsed: normalize(parsed) };
}

export interface SheetRef {
  title: string;
  sheetId: number;
}

/**
 * Resolve a sheet reference to a gid.
 * Accepted: "Sheet1", "gid:123", "123". Name match is case-insensitive (trimmed).
 */
export function resolveSheet(ref: string, sheets: readonly SheetRef[]): number {
  const s = ref.trim();
  if (s === '') throw new A1Error('Sheet reference is empty.');
  const gidMatch = /^gid:(\d+)$/.exec(s);
  const bareGid = /^(\d+)$/.exec(s);
  if (gidMatch || bareGid) {
    const gid = Number((gidMatch ? gidMatch[1] : bareGid![1])!);
    const found = sheets.find((h) => h.sheetId === gid);
    if (!found) {
      throw new A1Error(`No sheet with gid ${gid} in this spreadsheet. Sheets: ${sheetList(sheets)}`);
    }
    return found.sheetId;
  }
  const lowered = s.toLowerCase();
  const matches = sheets.filter((h) => h.title.trim().toLowerCase() === lowered);
  if (matches.length === 1) return matches[0]!.sheetId;
  if (matches.length > 1) {
    throw new A1Error(`Multiple sheets named "${s}" (gids ${matches.map((h) => h.sheetId).join(', ')}). Use gid:N to pick one.`);
  }
  throw new A1Error(
    `Sheet "${s}" not found. Sheets: ${sheetList(sheets)}. Quote names with spaces: 'My Sheet'!A1:B2.`
  );
}

function sheetList(sheets: readonly SheetRef[]): string {
  return sheets.map((h) => `"${h.title}"(gid:${h.sheetId})`).join(', ') || '(none)';
}

/** Quote a sheet name for embedding in an A1 string when needed. */
export function quoteSheetName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !looksLikeCellRef(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/** Build a GridRange for batchUpdate from a full range string. Open ends stay open (undefined). */
export function toGridRange(range: string, sheets: readonly SheetRef[]): sheets_v4.Schema$GridRange {
  const { sheet, parsed } = parseFullRange(range);
  const gid = sheet ? resolveSheet(sheet, sheets) : defaultSheet(sheets);
  return gridFromParts(gid, parsed);
}

function defaultSheet(sheets: readonly SheetRef[]): number {
  if (sheets.length === 0) throw new A1Error('Spreadsheet has no sheets.');
  return sheets[0]!.sheetId;
}

export function gridFromParts(gid: number, p: ParsedRange): sheets_v4.Schema$GridRange {
  const g: sheets_v4.Schema$GridRange = { sheetId: gid };
  if (p.startRow !== null) g.startRowIndex = p.startRow - 1;
  if (p.endRow !== null) g.endRowIndex = p.endRow;
  if (p.startCol !== null) g.startColumnIndex = p.startCol - 1;
  if (p.endCol !== null) g.endColumnIndex = p.endCol;
  return g;
}

/** Inverse of toGridRange; used for echoes. Renders open ends as open A1. */
export function fromGridRange(g: sheets_v4.Schema$GridRange): string {
  const prefix = g.sheetId === undefined || g.sheetId === null ? '' : `gid:${g.sheetId}!`;
  const r1 = (g.startRowIndex ?? 0) + 1;
  const c1 = (g.startColumnIndex ?? 0) + 1;
  const openRow = g.endRowIndex === undefined || g.endRowIndex === null;
  const openCol = g.endColumnIndex === undefined || g.endColumnIndex === null;
  const start = `${colName(c1!)}${r1}`;
  if (openRow && openCol) return `${prefix}${start}:`; // degenerate, shouldn't happen
  const r2 = openRow ? null : g.endRowIndex!; // inclusive end row
  const c2 = openCol ? null : g.endColumnIndex!;
  const endCell = `${c2 === null ? '' : colName(c2)}${r2 === null ? '' : r2}`;
  if (r2 === r1 && c2 === c1) return `${prefix}${start}`;
  return `${prefix}${start}:${endCell}`;
}

/** Concrete row/col span of a parsed range given the sheet's dimensions. */
export function rangeBounds(
  p: ParsedRange,
  dims: { rows: number; cols: number },
  label?: string,
): { rows: number; cols: number; endRow: number; endCol: number; startRow: number; startCol: number } {
  const startRow = p.startRow ?? 1;
  const startCol = p.startCol ?? 1;
  const endRow = p.endRow ?? dims.rows;
  const endCol = p.endCol ?? dims.cols;
  const clampedEndRow = Math.min(endRow, dims.rows);
  const clampedEndCol = Math.min(endCol, dims.cols);
  const what = label ? ` in "${label}"` : '';
  if (startRow > dims.rows) {
    throw new A1Error(`Start row ${startRow} is past the end of the sheet (${dims.rows} rows)${what}.`);
  }
  if (startCol > dims.cols) {
    throw new A1Error(`Start column ${startCol} is past the end of the sheet (${dims.cols} columns)${what}.`);
  }
  if (startRow > clampedEndRow || startCol > clampedEndCol) {
    throw new A1Error(
      `Range start is beyond its clamped end${what} — the sheet has ${dims.rows} rows × ${dims.cols} columns. ` +
        `Use a range within A1:${colName(dims.cols)}${dims.rows}.`,
    );
  }
  return {
    startRow,
    startCol,
    endRow: clampedEndRow,
    endCol: clampedEndCol,
    rows: Math.max(0, clampedEndRow - startRow + 1),
    cols: Math.max(0, clampedEndCol - startCol + 1),
  };
}

/**
 * Build a concrete A1 string (for values.* endpoints, which need concrete ranges).
 * Open ends are clamped to the sheet's dimensions; whole-sheet becomes the bare
 * quoted sheet name. dimsOf may be async (it loads the sheet list on demand).
 */
export async function toConcreteA1(
  range: string,
  sheets: readonly SheetRef[],
  dimsOf: (gid: number) => { rows: number; cols: number } | undefined | Promise<{ rows: number; cols: number } | undefined>,
): Promise<string> {
  const { sheet, parsed } = parseFullRange(range);
  const gid = sheet ? resolveSheet(sheet, sheets) : defaultSheet(sheets);
  const ref = sheets.find((h) => h.sheetId === gid)!;
  const title = quoteSheetName(ref.title);
  if (parsed.startRow === null && parsed.startCol === null) return title;
  const dims = (await dimsOf(gid)) ?? { rows: A1_MAX_ROW, cols: A1_MAX_COL };
  const b = rangeBounds(parsed, dims, `${title}!${range.startsWith(title + "!") ? range.slice(title.length + 1) : range}`);
  const start = `${colName(b.startCol)}${b.startRow}`;
  if (b.startRow === b.endRow && b.startCol === b.endCol) return `${title}!${start}`;
  return `${title}!${start}:${colName(b.endCol)}${b.endRow}`;
}