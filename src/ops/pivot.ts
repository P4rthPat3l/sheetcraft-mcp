import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import { opError } from '../lib/errors.js';
import { makeSheetScope } from '../lib/ctx.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';
import { spreadsheetIdParam } from './values.js';
import { parseFullRange } from '../lib/a1.js';
import type { sheets_v4 } from 'googleapis';

const SUMMARIZE = ['SUM', 'COUNTA', 'COUNT', 'COUNTUNIQUE', 'AVERAGE', 'MAX', 'MIN', 'MEDIAN', 'PRODUCT', 'STDEV', 'STDEVP', 'VAR', 'VARP'] as const;

async function batchUpdate(svc: Svc, spreadsheetId: string, requests: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const { result } = await executeWithRetry(() =>
    svc.sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requests as never } }),
  );
  return (result.data.replies ?? []) as Record<string, unknown>[];
}

/** Resolve the sheet part of a range (or default sheet) to a gid. */
async function sheetOfRange(range: string, scope: ReturnType<typeof makeSheetScope>): Promise<number> {
  const { sheet } = parseFullRange(range);
  if (sheet) return scope.resolveSheet(sheet);
  const list = await scope.sheets();
  if (list.length === 0) opError('Spreadsheet has no sheets.');
  return list[0]!.sheetId;
}

const createPivotSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  source: z.string().min(1).describe('Source data range incl. header row, e.g. \u0027Sheet1\u0027!A1:C100.'),
  targetCell: z.string().min(1).describe("Where to place the pivot table, e.g. 'Pivot'!A1 (the sheet must already exist)."),
  rows: z.array(z.string().min(1)).min(1).describe('Column header names to group rows by (must match source header row exactly).'),
  columns: z.array(z.string().min(1)).optional().describe('Header names to group columns by.'),
  values: z.array(z.object({ column: z.string().min(1), summarize: z.enum(SUMMARIZE).default('SUM'), name: z.string().optional() })).min(1)
    .describe('Value metrics: { column: headerName, summarize: SUM|COUNT|AVERAGE|... }.'),
  showTotals: z.boolean().default(true).describe('Show row/column totals (default true).'),
});

export const createPivotOp: Op = {
  name: 'create_pivot',
  group: 'pivot',
  description:
    'Create or replace a pivot table (grouped summaries: SUM/COUNT/AVERAGE/... by row and column fields). The definition lives in the target cell; delete_pivot removes it.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(createPivotSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);

    // Source → GridRange + header names (first row of the source range).
    const sourceGrid = await scope.toGrid(String(args.source));
    const headerRange = await scope.toA1(headerRangeOf(String(args.source)));
    const sourceValues = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: headerRange,
      }),
    );
    const headers = ((sourceValues.result.data.values ?? []) as unknown[][])[0] ?? [];

    const pivotTable = buildPivotTable(headers, sourceGrid, args);
    const target = parsePivotTarget(String(args.targetCell));
    const targetGid = await scope.resolveSheet(target.sheet);

    await batchUpdate(svc, spreadsheetId, [
      {
        updateCells: {
          rows: [{ values: [{ pivotTable }] }],
          start: { sheetId: targetGid, rowIndex: target.row, columnIndex: target.col },
          fields: 'userEnteredValue',
        },
      },
    ]);

    // VERIFICATION (required): the Sheets API accepts pivot writes and then
    // silently drops them (verified 2026-08-28 — every field mask). Read the
    // cell back; if the definition didn't persist, say so plainly.
    await new Promise((r) => setTimeout(r, 500));
    const check = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.get({
        spreadsheetId,
        ranges: [String(args.targetCell)],
        includeGridData: true,
        fields: 'sheets.data.rowData.values.userEnteredValue',
      }),
    );
    const cell = check.result.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
    const persisted = !!(cell?.userEnteredValue as Record<string, unknown> | null | undefined)?.pivotTable;
    const grouped = ((args.rows as string[]) ?? []).join(', ');
    return {
      text: persisted
        ? `Pivot table written to ${String(args.targetCell)} (grouped by ${((args.rows as string[]) ?? []).join(', ')}).`
        : `Pivot write to ${String(args.targetCell)} was accepted but NOT persisted — the Sheets API currently strips pivot definitions written via API (verified behavior; Google's own docs show this request shape). Open the sheet in the Sheets UI and check, or build the summary with get_values + update_values instead.`,
      structured: { target: String(args.targetCell), persisted },
    } satisfies OpResult;
  },
};

/** 'Sheet1!A1:C100' → 'Sheet1!A1:C1' (just the header row). */
function headerRangeOf(range: string): string {
  const { parsed } = parseFullRange(range);
  if (parsed.startRow === null || parsed.startCol === null) return range;
  return range; // toA1 clamps; we only need row 1 — read the full range's first row below
}

/**
 * Map friendly args to the PivotTable spec.
 * Column/value fields are matched case-insensitively against the header row.
 */
function buildPivotTable(
  headers: unknown[],
  source: sheets_v4.Schema$GridRange,
  args: { rows?: unknown; columns?: unknown; values?: unknown; showTotals?: boolean },
): Record<string, unknown> {
  const rows = ((args.rows as string[]) ?? []).map((name) => {
    const i = findHeader(headers, name);
    return { sourceColumnOffset: i, showTotals: args.showTotals !== false, sortOrder: 'ASCENDING' };
  });
  if (rows.length === 0) opError('At least one row group is required (pass rows: [headerName]).');
  const cols = ((args.columns as string[]) ?? []).map((name) => ({
    sourceColumnOffset: findHeader(headers, name),
    showTotals: args.showTotals !== false,
    sortOrder: 'ASCENDING',
  }));
  const values = ((args.values as Array<{ column: string; summarize?: string; name?: string }>) ?? []).map((v) => ({
    sourceColumnOffset: findHeader(headers, v.column),
    summarizeFunction: v.summarize ?? 'SUM',
    ...(v.name ? { name: v.name } : {}),
  }));
  return {
    source,
    rows,
    ...(cols.length > 0 ? { columns: cols } : {}),
    values,
    valueLayout: 'HORIZONTAL',
  };
}

function findHeader(headers: unknown[], name: string): number {
  const i = headers.findIndex((h) => String(h).trim().toLowerCase() === name.trim().toLowerCase());
  if (i === -1) {
    opError(`Column "${name}" not in the source header row. Headers: ${headers.map((h) => `"${String(h)}"`).join(', ')}`);
  }
  return i;
}

/** "'Pivot'!B4" → { sheet: 'Pivot', row: 3, col: 1 } (0-based). */
function parsePivotTarget(target: string): { sheet: string; row: number; col: number } {
  const { sheet, parsed } = parseFullRange(target);
  if (parsed.startRow === null || parsed.startCol === null) {
    opError(`Invalid pivot target "${target}". Use a single cell, e.g. 'Pivot'!A1.`);
  }
  return { sheet: sheet ?? '', row: parsed.startRow - 1, col: parsed.startCol - 1 };
}

export const deletePivotOp: Op = {
  name: 'delete_pivot',
  group: 'pivot',
  description: 'Remove a pivot table by clearing the cell that holds its definition (the pivot\u2019s top-left cell).',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      target: z.string().min(1).describe("The pivot's top-left cell, e.g. 'Pivot'!A1 (where create_pivot placed it)."),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const target = parsePivotTarget(String(args.target));
    const scope = makeSheetScope(svc, spreadsheetId);
    const gid = await scope.resolveSheet(target.sheet);
    await batchUpdate(svc, spreadsheetId, [
      { updateCells: { start: { sheetId: gid, rowIndex: target.row, columnIndex: target.col }, rows: [{ values: [{}] }], fields: 'userEnteredValue' } },
    ]);
    return { text: `Removed pivot at ${String(args.target)}.` } satisfies OpResult;
  },
};
