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
  freezeCols: z.number().int().min(0).optional().describe('Columns to freeze (e.g. 1 to pin the first column).'),
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
    if (args.freezeCols !== undefined) gridProperties.frozenColumnCount = args.freezeCols;
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

const moveDimensionSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  sheet: z.string().min(1).describe('Sheet containing the rows/columns to move (name or gid).'),
  dimension: z.enum(['ROWS', 'COLUMNS']),
  startIndex: z.number().int().min(0).describe('Start index of the block to move (0-based, inclusive).'),
  endIndex: z.number().int().min(1).describe('End index (0-based, exclusive — move 1 column at index 2 → endIndex 3).'),
  destinationIndex: z.number().int().min(0).describe('Index to move the block to (in the array BEFORE the move, 0-based).'),
});

export const moveDimensionOp: Op = {
  name: 'move_rows_columns',
  group: 'core',
  description:
    "Move rows or columns to a different position IN PLACE — data, formatting and formulas move with them; nothing is re-typed. Use this to reorder columns (e.g. 'move>Status to the front'), never delete-and-recreate.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(moveDimensionSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const sheetId = await scope.resolveSheet(String(args.sheet));
    const dimension = args.dimension as 'ROWS' | 'COLUMNS';
    await batchUpdate(svc, spreadsheetId, [
      {
        moveDimension: {
          source: { sheetId, dimension, startIndex: args.startIndex, endIndex: args.endIndex },
          destinationIndex: args.destinationIndex,
        },
      },
    ]);
    const noun = dimension === 'ROWS' ? 'row(s)' : 'column(s)';
    return {
      text: `Moved ${Number(args.endIndex) - Number(args.startIndex)} ${noun} (index ${args.startIndex}–${Number(args.endIndex) - 1}) to index ${args.destinationIndex}. Data, formatting and formulas moved intact.`,
      structured: { dimension, startIndex: args.startIndex, endIndex: args.endIndex, destinationIndex: args.destinationIndex },
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

// ---------------------------------------------------------------------------
// set_data_validation — dropdowns and cell constraints (core toolset)
// Live-probed 2026-08-29: ONE_OF_RANGE requires a "=Range" formula pointing at
// an EXISTING sheet; ONE_OF_LIST takes literals; deleting = omit the rule.

const DATA_VALIDATION_TYPES = [
  'ONE_OF_LIST', 'ONE_OF_RANGE', 'NUMBER_BETWEEN', 'NUMBER_NOT_BETWEEN',
  'NUMBER_EQUAL', 'NUMBER_GREATER', 'NUMBER_GREATER_THAN_OR_EQ', 'NUMBER_LESS',
  'NUMBER_LESS_THAN_OR_EQ', 'TEXT_EQUAL_TO', 'TEXT_NOT_EQUAL_TO', 'TEXT_CONTAINS',
  'TEXT_NOT_CONTAINS', 'TEXT_STARTS_WITH', 'TEXT_ENDS_WITH', 'TEXT_IS_EMAIL',
  'TEXT_IS_URL', 'DATE_IS_VALID', 'BOOLEAN',
] as const;

type DataValidationType = (typeof DATA_VALIDATION_TYPES)[number];

const TYPES_NEEDING_VALUES: ReadonlySet<DataValidationType> = new Set([
  'ONE_OF_LIST', 'ONE_OF_RANGE', 'NUMBER_BETWEEN', 'NUMBER_NOT_BETWEEN',
  'NUMBER_EQUAL', 'NUMBER_GREATER', 'NUMBER_GREATER_THAN_OR_EQ', 'NUMBER_LESS',
  'NUMBER_LESS_THAN_OR_EQ', 'TEXT_EQUAL_TO', 'TEXT_NOT_EQUAL_TO', 'TEXT_CONTAINS',
  'TEXT_NOT_CONTAINS', 'TEXT_STARTS_WITH', 'TEXT_ENDS_WITH',
]);

const NUMBER_TYPES = new Set<DataValidationType>([
  'NUMBER_BETWEEN', 'NUMBER_NOT_BETWEEN', 'NUMBER_EQUAL', 'NUMBER_GREATER',
  'NUMBER_GREATER_THAN_OR_EQ', 'NUMBER_LESS', 'NUMBER_LESS_THAN_OR_EQ',
]);

const setDataValidationSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  range: z.string().min(1).describe("Target range, e.g. 'Sheet 1'!E2:E100 (include the sheet prefix; without one the first sheet is used)."),
  type: z.enum(DATA_VALIDATION_TYPES).optional().describe(
    "Validation rule: dropdowns use ONE_OF_LIST (values = literal options) or ONE_OF_RANGE (values = ['=Sheet!A1:A10'] pointing at an option list). BOOLEAN (a checkbox) needs no values.",
  ),
  values: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe(
      "Rule values. ONE_OF_LIST: the option literals, e.g. [\"Active\",\"Disabled\"]. ONE_OF_RANGE: exactly one '=Sheet!A1:A10' ref. Comparison types (NUMBER_BETWEEN, TEXT_CONTAINS, …): one value (two for *_BETWEEN).",
    ),
  strict: z.boolean().default(true).describe('true (default) = reject invalid input with a warning; false = accept with a warning marker.'),
  showDropdown: z.boolean().default(true).describe('Show the dropdown UI for ONE_OF_* rules (default true).'),
  clearValidation: z.boolean().default(false).describe('Remove validation from the range instead of setting a rule.'),
});

export { quoteSheetName };
export const setDataValidationOp: Op = {
  name: 'set_data_validation',
  group: 'core',
  description:
    'Apply data validation (dropdowns, checkboxes, value constraints) to a range — ONE_OF_LIST/ONE_OF_RANGE dropdowns, BOOLEAN checkboxes, number/text comparisons. clearValidation=true removes rules.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(setDataValidationSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);

    // Arg-shape checks before any API call so they fire even when offline.
    if (args.clearValidation) {
      if (args.type || args.values) {
        opError('Pass EITHER clearValidation=true OR type/values — not both. clearValidation removes the rule.');
      }
      const clearGrid = await scope.toGrid(String(args.range));
      await executeWithRetry(() =>
        svc.sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ setDataValidation: { range: clearGrid } }] },
        }),
      );
      return { text: `Cleared data validation from ${String(args.range)}.`, structured: { cleared: true } } satisfies OpResult;
    }

    const type = args.type as DataValidationType | undefined;
    if (!type) {
      opError(
        `Missing "type" — what rule should ${String(args.range)} enforce? Dropdowns: ONE_OF_LIST with values=["Active","Disabled"], or ONE_OF_RANGE with values=["='Options'!A1:A10"]. Simple flag: BOOLEAN (checkbox). Or clearValidation=true to remove rules. Valid types: ${DATA_VALIDATION_TYPES.join(', ')}.`,
      );
    }
    const rawValues = (args.values ?? []) as Array<string | number>;
    if (TYPES_NEEDING_VALUES.has(type!) && rawValues.length === 0) {
      opError(
        `Type ${type} requires "values". ${type === 'ONE_OF_LIST' ? 'e.g. values=["Active","Disabled","Pending"]' : type === 'ONE_OF_RANGE' ? 'e.g. values=["=Options!A1:A10"] — the ref must point at an existing sheet holding the options' : 'e.g. the value(s) to compare against'}.`,
      );
    }
    if (!TYPES_NEEDING_VALUES.has(type!) && rawValues.length > 0) {
      opError(`Type ${type} takes no "values" — remove the parameter (it would be silently ignored by the API).`);
    }
    if (NUMBER_TYPES.has(type!) && rawValues.some((v) => typeof v !== 'number')) {
      opError(`Type ${type} needs numeric values (got a string). Pass numbers without quotes, e.g. values=[1, 100].`);
    }
    if (type === 'ONE_OF_LIST' && rawValues.length > 100) {
      opError('ONE_OF_LIST accepts at most 100 literal options. Put longer lists in cells and use ONE_OF_RANGE instead, e.g. values=["=\'Option Lists\'!A1:A120"].');
    }
    if (type === 'ONE_OF_RANGE' && rawValues.length !== 1) {
      opError('ONE_OF_RANGE takes exactly one value: the "=Sheet!A1:A10" reference to the option list.');
    }

    let conditionValues: Array<{ userEnteredValue: string }> = [];
    if (type === 'ONE_OF_LIST') {
      conditionValues = rawValues.map((v) => ({ userEnteredValue: String(v) }));
    } else if (type === 'ONE_OF_RANGE') {
      const ref = String(rawValues[0]).trim();
      if (!ref.startsWith('=')) {
        opError(
          `ONE_OF_RANGE values must be a formula ref starting with "=", e.g. values=["='${ref}'"]. (Live-probed: a bare range is rejected by Google.)`,
        );
      }
      // The referenced sheet must exist — Google's raw 400 for a bad ref teaches nothing.
      const refBody = ref.slice(1);
      const { sheet: refSheet } = parseFullRange(refBody);
      if (refSheet) {
        const existing = (await scope.sheets()).map((s) => s.title);
        if (!existing.includes(refSheet)) {
          opError(
            `ONE_OF_RANGE references sheet "${refSheet}" which does not exist. Sheets: ${existing.map((t) => `"${t}"`).join(', ')}. Create it first (add_sheet), then reference its option cells.`,
          );
        }
      } else {
        opError(
          `ONE_OF_RANGE ref "${ref}" must name its sheet, e.g. "='Options'!A1:A10". A range without a sheet prefix would silently point at the wrong tab.`,
        );
      }
      conditionValues = [{ userEnteredValue: ref }];
    } else {
      conditionValues = rawValues.map((v) => ({ userEnteredValue: String(v) }));
    }

    const grid = await scope.toGrid(String(args.range));
    const showCustomUi = type === 'ONE_OF_LIST' || type === 'ONE_OF_RANGE' ? args.showDropdown !== false : undefined;
    await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              setDataValidation: {
                range: grid,
                rule: {
                  condition: { type, values: conditionValues },
                  showCustomUi,
                  strict: args.strict !== false,
                },
              },
            },
          ],
        },
      }),
    );
    const detail =
      type === 'ONE_OF_LIST'
        ? `options: ${rawValues.slice(0, 8).map(String).join(' | ')}${rawValues.length > 8 ? ` (+${rawValues.length - 8} more)` : ''}`
        : type === 'ONE_OF_RANGE'
          ? `options from ${String(rawValues[0])}`
          : type === 'BOOLEAN'
            ? 'checkbox'
            : `rule on ${conditionValues.map((v) => v.userEnteredValue).join(', ')}`;
    return {
      text: `Applied ${type} validation to ${String(args.range)} (${detail}). Invalid input is ${args.strict !== false ? 'rejected' : 'warned but accepted'}.`,
      structured: { type, range: String(args.range), applied: true },
    } satisfies OpResult;
  },
};
