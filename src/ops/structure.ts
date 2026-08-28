import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import { makeSheetScope } from '../lib/ctx.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';
import { spreadsheetIdParam } from './values.js';
import { opError } from '../lib/errors.js';
import { quoteSheetName, parseFullRange } from '../lib/a1.js';

/** Fields-masked spreadsheet info: the "orient yourself" response. */
interface SheetSummary {
  title: string;
  gid: number;
  rows: number;
  cols: number;
  frozenRows?: number;
  frozenCols?: number;
  hidden?: boolean;
  tabColor?: string;
}

export const getSpreadsheetInfoOp: Op = {
  name: 'get_spreadsheet_info',
  group: 'core',
  description:
    'List the sheets (tabs) in a spreadsheet with titles, gids, dimensions and frozen state. Call this first when you only have a spreadsheet URL/ID.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(z.object({ spreadsheetId: spreadsheetIdParam })),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const { result: res } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields:
          'properties(title,locale,timeZone),sheets.properties(sheetId,title,hidden,gridProperties)',
      }),
    );
    const sheets: SheetSummary[] = (res.data.sheets ?? []).map((s) => {
      const p = s.properties ?? {};
      const grid = p.gridProperties ?? {};
      const summary: SheetSummary = {
        title: p.title ?? '',
        gid: p.sheetId ?? 0,
        rows: grid.rowCount ?? 1000,
        cols: grid.columnCount ?? 26,
      };
      if (grid.frozenRowCount) summary.frozenRows = grid.frozenRowCount;
      if (grid.frozenColumnCount) summary.frozenCols = grid.frozenColumnCount;
      if (p.hidden) summary.hidden = true;
      return summary;
    });
    const lines = sheets.map(
      (s) => `${s.title} (gid:${s.gid}) ${s.rows}x${s.cols}${s.frozenRows ? ` frozen:${s.frozenRows}` : ''}${s.hidden ? ' [hidden]' : ''}`,
    );
    return {
      text: [`"${res.data.properties?.title ?? ''}" — ${sheets.length} sheet(s):`, ...lines].join('\n'),
      structured: {
        spreadsheetTitle: res.data.properties?.title ?? '',
        locale: res.data.properties?.locale,
        sheets,
      } satisfies Record<string, unknown>,
    } satisfies OpResult;
  },
};

function batchUpdate(
  svc: Svc,
  spreadsheetId: string,
  requests: Record<string, unknown>[],
): Promise<{ replies: Record<string, unknown>[] }> {
  return executeWithRetry(() =>
    svc.sheetsApi.spreadsheets.batchUpdate({ requestBody: { requests: requests as never }, spreadsheetId }),
  ).then(({ result }) => ({ replies: (result.data.replies ?? []) as Record<string, unknown>[] }));
}

const addSheetSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  title: z.string().min(1).describe('New sheet (tab) name.'),
  index: z.number().int().min(0).optional().describe('Position (0-based). Omit to append at the end.'),
  rows: z.number().int().min(1).max(10_000_000).optional().describe('Row count (default 1000).'),
  cols: z.number().int().min(1).max(18_278).optional().describe('Column count (default 26).'),
  freezeRows: z.number().int().min(0).optional().describe('Rows to freeze (e.g. 1 for a header).'),
  tabColor: z.string().optional().describe('Tab color as #RRGGBB hex.'),
});

export const addSheetOp: Op = {
  name: 'add_sheet',
  group: 'core',
  description: 'Add a new sheet (tab) to a spreadsheet.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: zodSchema(addSheetSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const title = String(args.title);
    const gridProperties: Record<string, unknown> = {};
    if (args.rows !== undefined) gridProperties.rowCount = args.rows;
    if (args.cols !== undefined) gridProperties.columnCount = args.cols;
    if (args.freezeRows !== undefined) gridProperties.frozenRowCount = args.freezeRows;
    const properties: Record<string, unknown> = { title };
    if (args.index !== undefined) properties.index = args.index;
    if (Object.keys(gridProperties).length > 0) properties.gridProperties = gridProperties;
    if (typeof args.tabColor === 'string') {
      properties.tabColorStyle = { rgbColor: hexToRgbColor(args.tabColor) };
    }
    const { replies } = await batchUpdate(svc, spreadsheetId, [{ addSheet: { properties } }]);
    const props = (replies[0]?.addSheet as { properties?: { sheetId?: number; title?: string } } | undefined)?.properties;
    return {
      text: `Created sheet "${title}" (gid:${props?.sheetId}).`,
      structured: { sheetId: props?.sheetId, title },
    } satisfies OpResult;
  },
};

const deleteSheetSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  sheet: z.string().min(1).describe('Sheet to delete: name ("Data") or gid ("gid:123" / "123").'),
});

export const deleteSheetOp: Op = {
  name: 'delete_sheet',
  group: 'core',
  description: 'Delete a sheet (tab) by name or gid. Destructive — the sheet and its data are removed.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(deleteSheetSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const gid = await scope.resolveSheet(String(args.sheet));
    const sheets = await scope.sheets();
    if (sheets.length <= 1) {
      opError('Cannot delete the only sheet in a spreadsheet. Delete the spreadsheet itself instead (trash_spreadsheet).');
    }
    const target = sheets.find((s) => s.sheetId === gid);
    await batchUpdate(svc, spreadsheetId, [{ deleteSheet: { sheetId: gid } }]);
    return {
      text: `Deleted sheet "${target?.title ?? gid}" (gid:${gid}).`,
      structured: { deletedSheetId: gid, title: target?.title },
    } satisfies OpResult;
  },
};

const duplicateSheetSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  sheet: z.string().min(1).describe('Sheet to duplicate: name or gid.'),
  newTitle: z.string().optional().describe('Name for the copy (default: "<name> Copy").'),
});

export const duplicateSheetOp: Op = {
  name: 'duplicate_sheet',
  group: 'core',
  description: 'Duplicate a sheet (tab), including its data and formatting.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: zodSchema(duplicateSheetSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const sourceSheetId = await scope.resolveSheet(String(args.sheet));
    const { replies } = await batchUpdate(svc, spreadsheetId, [
      { duplicateSheet: { sourceSheetId, ...(args.newTitle ? { newSheetName: String(args.newTitle) } : {}) } },
    ]);
    const props = (replies[0]?.duplicateSheet as { properties?: { sheetId?: number; title?: string } } | undefined)?.properties;
    return {
      text: `Duplicated to new sheet "${props?.title}" (gid:${props?.sheetId}).`,
      structured: { newSheetId: props?.sheetId, newTitle: props?.title },
    } satisfies OpResult;
  },
};

const renameSheetSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  sheet: z.string().min(1).describe('Sheet to rename: name or gid (prefer gid if renaming).'),
  newTitle: z.string().min(1).describe('New sheet name.'),
});

export const renameSheetOp: Op = {
  name: 'rename_sheet',
  group: 'core',
  description: 'Rename a sheet (tab).',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(renameSheetSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const sheetId = await scope.resolveSheet(String(args.sheet));
    const newTitle = String(args.newTitle);
    await batchUpdate(svc, spreadsheetId, [
      { updateSheetProperties: { properties: { sheetId, title: newTitle }, fields: 'title' } },
    ]);
    return {
      text: `Renamed sheet gid:${sheetId} to "${newTitle}".`,
      structured: { sheetId, newTitle },
    } satisfies OpResult;
  },
};

const dimensionsSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  sheet: z.string().min(1).describe('Sheet name or gid.'),
  dimension: z.enum(['ROWS', 'COLUMNS']).describe('Which dimension to modify.'),
  startIndex: z.number().int().min(0).describe('0-based start index (row/column position).'),
  endIndex: z.number().int().min(1).describe('Exclusive end index (startIndex + count).'),
  action: z.enum(['insert', 'delete']).describe('insert = add empty rows/cols; delete = remove them.'),
  inheritFromBefore: z.boolean().optional().describe('insert only: new rows/cols inherit formatting from the previous one.'),
});

export const insertDeleteDimensionsOp: Op = {
  name: 'insert_delete_dimensions',
  group: 'core',
  description: 'Insert or delete rows/columns. Indices are 0-based positions in the sheet (0 = first row/column). Deleting removes the rows/columns and their data.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  inputSchema: zodSchema(dimensionsSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const sheetId = await scope.resolveSheet(String(args.sheet));
    const dimension = args.dimension as 'ROWS' | 'COLUMNS';
    const range = { sheetId, dimension, startIndex: args.startIndex, endIndex: args.endIndex };
    const request =
      args.action === 'insert'
        ? { insertDimension: { range, inheritFromBefore: args.inheritFromBefore ?? false } }
        : { deleteDimension: { range } };
    const count = Number(args.endIndex) - Number(args.startIndex);
    await batchUpdate(svc, spreadsheetId, [request]);
    return {
      text: `${args.action === 'insert' ? 'Inserted' : 'Deleted'} ${count} ${dimension === 'ROWS' ? 'row(s)' : 'column(s)'} at index ${args.startIndex}.`,
      structured: { action: args.action, dimension, count, startIndex: args.startIndex },
    } satisfies OpResult;
  },
};

const findReplaceSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  find: z.string().min(1).describe('Text to find.'),
  replacement: z.string().min(1).describe('Replacement text. Every match is overwritten — pass the same text to count matches without changing anything.'),
  sheet: z.string().optional().describe('Limit to one sheet (name or gid). Omit to search all sheets.'),
  range: z.string().optional().describe("Limit to an A1 range, e.g. 'Sheet 1'!A2:C10 (include the sheet prefix; without one the first sheet is used)."),
  matchCase: z.boolean().optional().describe('Case-sensitive match (default false).'),
  matchEntireCell: z.boolean().optional().describe('Only match cells whose entire value equals find.'),
  searchByRegex: z.boolean().optional().describe('Treat find as a regular expression.'),
  includeFormulas: z.boolean().optional().describe('Also search inside formulas.'),
});

export const findReplaceOp: Op = {
  name: 'find_replace',
  group: 'core',
  description: 'Find and replace text across a sheet, a range, or the whole spreadsheet. Replaces every match; returns the number of replacements.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(findReplaceSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const req: Record<string, unknown> = {
      find: String(args.find),
      replacement: String(args.replacement),
      matchCase: args.matchCase ?? false,
      matchEntireCell: args.matchEntireCell ?? false,
      searchByRegex: args.searchByRegex ?? false,
      includeFormulas: args.includeFormulas ?? false,
    };
    if (args.range) {
      const grid = await scope.toGrid(String(args.range));
      // If the range had no sheet prefix, bind it to the sheet arg (or first sheet).
      if (grid.sheetId === undefined) {
        const { sheet } = parseFullRange(String(args.range));
        const targetSheet = sheet ?? args.sheet;
        if (targetSheet) grid.sheetId = await scope.resolveSheet(String(targetSheet));
      }
      req.range = grid;
    } else if (args.sheet) {
      req.sheetId = await scope.resolveSheet(String(args.sheet));
    } else {
      req.allSheets = true;
    }
    const { replies } = await batchUpdate(svc, spreadsheetId, [{ findReplace: req }]);
    const fr = (replies[0]?.findReplace ?? {}) as { occurrencesChanged?: number; valuesChanged?: unknown };
    const n = fr.occurrencesChanged ?? 0;
    return {
      text: n === 0 ? 'No occurrences found.' : `Replaced ${n} occurrence(s).`,
      structured: { occurrencesChanged: n },
    } satisfies OpResult;
  },
};

/** #RRGGBB → { red, green, blue } floats for the API. */
export function hexToRgbColor(hex: string): { red: number; green: number; blue: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) opError(`Invalid color "${hex}". Use #RRGGBB.`);
  const n = parseInt(m[1]!, 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

export { quoteSheetName };