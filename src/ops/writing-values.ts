import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import { opError } from '../lib/errors.js';
import { makeSheetScope } from '../lib/ctx.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';
import { spreadsheetIdParam, renderParam, formatParam } from './values.js';
import { cellCap, formatValuesOutput } from '../lib/output.js';
import type { OutputFormat } from '../lib/output.js';
import { quoteSheetName } from '../lib/a1.js';
import type { sheets_v4 } from 'googleapis';

function rectangularize(rows: unknown[][]): (string | number | boolean | null)[][] {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((row) => {
    const out: (string | number | boolean | null)[] = [];
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      out.push(v === undefined || v === null ? '' : (v as string | number | boolean));
    }
    return out;
  });
}

/** Coerce JSON cell values to the API's ValueRange (numbers/bools stay typed; null/undefined → ""). */
function toRawValues(input: unknown): { values: unknown[][]; majorDimension: 'ROWS' | 'COLUMNS' } {
  if (!Array.isArray(input) || input.length === 0) {
    opError('values must be a non-empty 2D array, e.g. [["a","b"],[1,true]].');
  }
  const rows = input as unknown[];
  const first = rows[0];
  const isColVec = rows.every((r) => !Array.isArray(r));
  if (isColVec) {
    // ["a","b"] → one column
    return { values: rows.map((v) => [v === undefined ? '' : v]), majorDimension: 'ROWS' };
  }
  const rowsArr = rows as unknown[][];
  const cols = rowsArr.reduce((m, r) => Math.max(m, (Array.isArray(r) ? r.length : 1)), 1);
  const norm = rowsArr.map((row) => {
    const arr = Array.isArray(row) ? row : [row];
    const out: unknown[] = [];
    for (let c = 0; c < cols; c++) {
      const v = arr[c];
      out.push(v === undefined || v === null ? '' : v);
    }
    return out;
  });
  return { values: norm, majorDimension: 'ROWS' as const };
}

function echo(update: { updatedRange?: string; updatedRows?: number; updatedColumns?: number; updatedCells?: number }): string {
  const bits = [
    update.updatedRange,
    `${update.updatedRows ?? 0} row(s)`,
    `${update.updatedCells ?? 0} cell(s)`,
  ].filter(Boolean);
  return bits.join(' · ');
}

const updateSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  range: z
    .string()
    .min(1)
    .describe("Target range. Single cell (e.g. 'Sheet 1'!B2) expands to fit the data."),
  values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1)
    .describe('2D array of rows. Strings starting with "=" become formulas by default (input=USER_ENTERED). Empty string clears a cell.'),
  input: z.enum(['USER_ENTERED', 'RAW']).describe('USER_ENTERED (default) parses values like the Sheets UI (formulas, dates, numbers). RAW stores strings literally.')
    .default('USER_ENTERED'),
});

export const updateValuesOp: Op = {
  name: 'update_values',
  group: 'core',
  description:
    'Write a 2D array of values to a range. Strings starting with "=" are interpreted as formulas by default (USER_ENTERED); pass input=RAW to store them literally.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(updateSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const range = String(args.range);
    const scope = makeSheetScope(svc, spreadsheetId);
    const concrete = await scope.toA1(range);
    const { values } = toRawValues(args.values);
    const { result } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: concrete,
        valueInputOption: args.input === 'RAW' ? 'RAW' : 'USER_ENTERED',
        requestBody: { values, majorDimension: 'ROWS' },
      }),
    );
    const d = result.data;
    return {
      text: `Wrote ${d.updatedCells ?? 0} cell(s) to ${d.updatedRange ?? range}.`,
      structured: {
        updatedRange: d.updatedRange,
        updatedRows: d.updatedRows,
        updatedColumns: d.updatedColumns,
        updatedCells: d.updatedCells,
      },
    } satisfies OpResult;
  },
};

const appendSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  sheet: z.string().min(1).describe("Sheet to append to (name or gid). The table is found automatically within the sheet, starting at its first column."),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1)
    .describe('Rows to append, as a 2D array. Column order must match the existing table.'),
  input: z.enum(['USER_ENTERED', 'RAW']).default('USER_ENTERED').describe('How to parse the values (default USER_ENTERED).'),
  insertDataOption: z.enum(['INSERT_ROWS', 'OVERWRITE']).default('INSERT_ROWS')
    .describe('INSERT_ROWS (default) adds new rows below the table. OVERWRITE would overwrite cells below it — only use deliberately.'),
});

export const appendRowsOp: Op = {
  name: 'append_rows',
  group: 'core',
  description:
    'Append rows to the table on a sheet. Finds the existing table automatically and adds rows below it. Default INSERT_ROWS (never overwrites).',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: zodSchema(appendSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const sheet = String(args.sheet);
    const gid = await scope.resolveSheet(sheet);
    const info = (await scope.sheets()).find((s) => s.sheetId === gid);
    const rows = (args.rows as unknown[][]) ?? [];
    const { values } = toRawValues(rows);
    const { result } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.values.append({
        spreadsheetId,
        range: quoteSheetName(info?.title ?? sheet),
        valueInputOption: (args.input as 'USER_ENTERED' | 'RAW') ?? 'USER_ENTERED',
        insertDataOption: (args.insertDataOption as 'INSERT_ROWS' | 'OVERWRITE') ?? 'INSERT_ROWS',
        includeValuesInResponse: false,
      }),
    );
    const u = result.data.updates ?? {};
    return {
      text: `Appended ${rows.length} row(s) → ${u.updatedRange ?? '(range unknown)'} · table was: ${result.data.tableRange ?? '(new table)'}`,
      structured: {
        updatedRange: u.updatedRange,
        tableRange: result.data.tableRange,
        updatedRows: u.updatedRows,
        updatedCells: u.updatedCells,
      },
    } satisfies OpResult;
  },
};

const batchUpdateValuesSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  writes: z
    .array(z.object({ range: z.string().min(1), values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1) }))
    .min(1)
    .describe('Array of { range, values } pairs written in one API call.'),
  input: z.enum(['USER_ENTERED', 'RAW']).default('USER_ENTERED'),
});

export const batchUpdateValuesOp: Op = {
  name: 'batch_update_values',
  group: 'core',
  description: 'Write multiple ranges in ONE API call (one quota unit). Prefer this over several update_values calls.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(batchUpdateValuesSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const writes = (args.writes as Array<{ range: string; values: unknown[][] }>) ?? [];
    const data: sheets_v4.Schema$ValueRange[] = [];
    for (const w of writes) {
      data.push({ range: await scope.toA1(String(w.range)), values: toRawValues(w.values).values, majorDimension: 'ROWS' });
    }
    const { result } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: (args.input as 'USER_ENTERED' | 'RAW') ?? 'USER_ENTERED',
          data,
        },
      }),
    );
    const parts = (result.data.responses ?? []).map((r) => `${r.updatedRange}: ${r.updatedCells ?? 0} cell(s)`);
    return {
      text: `Wrote ${result.data.totalUpdatedCells ?? 0} cell(s) across ${writes.length} range(s).`,
      structured: { totalUpdatedCells: result.data.totalUpdatedCells, responses: result.data.responses },
    } satisfies OpResult;
  },
};

const batchGetValuesSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  ranges: z.array(z.string().min(1)).min(1).describe('Ranges to read, e.g. ["Sheet1!A1:B10", "Summary!A:C"].'),
  format: formatParam,
  render: renderParam,
});

export const batchGetValuesOp: Op = {
  name: 'batch_get_values',
  group: 'core',
  description: 'Read multiple ranges in one call. Each range is returned labeled with its A1.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(batchGetValuesSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const ranges = (args.ranges as string[]) ?? [];
    const concrete: string[] = [];
    for (const r of ranges) concrete.push(await scope.toA1(String(r)));
    const render = (args.render ?? 'formatted') as 'formatted' | 'unformatted' | 'formula';
    const valueRenderOption =
      render === 'unformatted' ? 'UNFORMATTED_VALUE' : render === 'formula' ? 'FORMULA' : 'FORMATTED_VALUE';
    const dateTimeRenderOption = render === 'formatted' ? undefined : 'FORMATTED_STRING';
    const { result } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: concrete,
        majorDimension: 'ROWS',
        valueRenderOption,
        dateTimeRenderOption,
      }),
    );
    const blocks: string[] = [];
    const structured: Record<string, unknown> = { ranges: [] };
    for (const vr of result.data.valueRanges ?? []) {
      const label = vr.range ?? '(unknown range)';
      const vals = (vr.values ?? []) as unknown[][];
      const norm = rectangularize(vals);
      const capped = cellCap(norm, svc.maxCells);
      const body = formatValuesOutput(capped.values, (args.format as OutputFormat) ?? 'csv');
      blocks.push(`=== ${label} ===\n${body}`);
      (structured.ranges as unknown[]).push({ range: label, rows: vals.length, truncated: capped.truncated });
    }
    return { text: blocks.join('\n\n'), structured } satisfies OpResult;
  },
};

const clearValuesSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  range: z.string().min(1).describe("Range to clear, e.g. 'Sheet 1'!A2:Z. Cell formatting is preserved."),
});

export const clearValuesOp: Op = {
  name: 'clear_values',
  group: 'core',
  description: 'Clear cell values (formatting is preserved). Destructive.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(clearValuesSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const concrete = await scope.toA1(String(args.range));
    const { result } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.values.clear({ spreadsheetId, range: concrete }),
    );
    return {
      text: `Cleared ${result.data.clearedRange ?? concrete}.`,
      structured: { clearedRange: result.data.clearedRange },
    } satisfies OpResult;
  },
};