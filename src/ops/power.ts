import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import { opError } from '../lib/errors.js';
import { makeSheetScope } from '../lib/ctx.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';
import { spreadsheetIdParam } from './values.js';

/**
 * Escape hatch: raw spreadsheets.batchUpdate. Covers every request type the
 * dedicated tools don't (banding, filter views, named ranges, protection,
 * slicers, tables, dimension groups, findReplace, pasteData, textToColumns...).
 */
export const batchUpdateOp: Op = {
  name: 'batch_update',
  group: 'power',
  description:
    'Raw spreadsheets.batchUpdate escape hatch for operations without a dedicated tool. Pass the API\u2019s requests array verbatim. Covers: banding, filter views, named ranges, protection, data validation, borders, autoFill, pasteData, textToColumns, trimWhitespace, deleteDuplicates, slicers, tables, dimension groups. Atomic: any invalid request aborts the batch.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      requests: z.array(z.record(z.string(), z.unknown())).min(1).describe(
        'Array of batchUpdate Request objects in the exact Google Sheets API format, e.g. [{"addNamedRange":{"namedRange":{"name":"MyRange","range":{"sheetId":0,"startRowIndex":0,"endRowIndex":5,"startColumnIndex":0,"endColumnIndex":3}}}}].',
      ),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const requests = args.requests as Record<string, unknown>[];
    const { result } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requests as never } }),
    );
    const kinds = (args.requests as Record<string, unknown>[]).map((r) => Object.keys(r)[0] ?? '?');
    const replies = (result.data.replies ?? []).map((r, i) => (Object.keys(r as object).length > 0 ? r : { [kinds[i] ?? i]: {} }));
    return {
      text: `Applied ${requests.length} request(s): ${kinds.join(', ')}.`,
      structured: { replies },
    } satisfies OpResult;
  },
};

const sortRangeSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  range: z.string().min(1).describe("Range to sort — data rows ONLY, exclude the header (e.g. 'Sheet1'!A2:C10). The whole range is sorted in place."),
  order: z
    .array(z.object({ column: z.string().min(1).describe('Column letter, e.g. B'), ascending: z.boolean().default(true) }))
    .min(1)
    .describe('Sort keys in priority order. Example: [{ "column": "B", "ascending": true }].'),
});

export const sortRangeOp: Op = {
  name: 'sort_range',
  group: 'power',
  description:
    'Sort rows of a range by one or more columns. The ENTIRE range is sorted in place — exclude header rows from the range or they get sorted too.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(sortRangeSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const gridRange = await scope.toGrid(String(args.range));
    const sortSpecs = ((args.order as Array<{ column: string; ascending?: boolean }>) ?? []).map((k) => ({
      dimensionIndex: colIndexOf(String(k.column)),
      sortOrder: k.ascending === false ? 'DESCENDING' : 'ASCENDING',
    }));
    await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ sortRange: { range: gridRange, sortSpecs } }] },
      }),
    );
    const keys = ((args.order as Array<{ column: string; ascending?: boolean }>) ?? [])
      .map((k) => `${k.column} ${k.ascending === false ? 'desc' : 'asc'}`)
      .join(', then ');
    return { text: `Sorted ${String(args.range)} by ${keys}.` } satisfies OpResult;
  },
};

/** "B" → 1 (0-based dimension index for the API). */
function colIndexOf(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) opError(`Invalid column "${letters}". Use letters like B.`);
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
