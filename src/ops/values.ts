import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import type { OutputFormat } from '../lib/output.js';
import { cellCap, formatValuesOutput, truncationNotice } from '../lib/output.js';
import { makeSheetScope } from '../lib/ctx.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';

export const renderParam = z
  .enum(['formatted', 'unformatted', 'formula'])
  .default('formatted')
  .describe(
    'Value rendering: formatted (strings, locale-formatted — default), unformatted (raw numbers/booleans; dates rendered as strings), formula (formulas, not calculated values).',
  );

export const formatParam = z
  .enum(['csv', 'tsv', 'grid', 'records'])
  .default('csv')
  .describe(
    'Output format: csv (default, most compact), tsv, grid (JSON 2D array), records (JSON objects keyed by the first header row).',
  );

/** Shared spreadsheet param used by every sheet-scoped op. */
export const spreadsheetIdParam = z
  .string({ required_error: 'spreadsheetId is required — paste the full sheet URL or the ID from it.' })
  .min(1, 'spreadsheetId is empty — paste the full sheet URL or the ID from it (the long token between /d/ and /edit).')
  .describe('Spreadsheet ID (from the URL /d/<id>/edit) or the full URL.');

/** Pad rows to equal length so CSV/TSV output is rectangular. */
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

export const getValuesOp: Op = {
  name: 'get_values',
  group: 'core',
  description:
    'Read cell values from an A1 range. Returns CSV by default (most token-efficient); format=grid gives a JSON 2D array, records gives header-joined objects.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      range: z.string().min(1).describe(
        "Range to read. Examples: 'My Sheet'!A1:D10, A:C, 1:5, or a bare sheet name ('My Sheet') for the whole sheet.",
      ),
      format: formatParam,
      render: renderParam,
      maxCells: z
        .number()
        .int()
        .min(1)
        .max(50_000)
        .optional()
        .describe('Override the per-read cell cap (default 5000). Large reads are truncated to fit.'),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const range = String(args.range);
    const format = (args.format ?? 'csv') as OutputFormat;
    const render = (args.render ?? 'formatted') as 'formatted' | 'unformatted' | 'formula';
    const maxCells = typeof args.maxCells === 'number' ? args.maxCells : svc.maxCells;

    const scope = makeSheetScope(svc, spreadsheetId);
    const concrete = await scope.toA1(range);

    const valueRenderOption =
      render === 'unformatted' ? 'UNFORMATTED_VALUE' : render === 'formula' ? 'FORMULA' : 'FORMATTED_VALUE';
    // FORMATTED_VALUE ignores dateTimeRenderOption; for the others, ask for strings
    // (serial-number dates are a model-hostile format).
    const dateTimeRenderOption = render === 'formatted' ? undefined : 'FORMATTED_STRING';

    const { result: res } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: concrete,
        valueRenderOption,
        dateTimeRenderOption,
        majorDimension: 'ROWS',
      }),
    );

    const raw = (res.data.values ?? []) as unknown[][];
    const normalized = rectangularize(raw);
    const cols = normalized.length > 0 ? normalized[0]!.length : 0;
    const capped = cellCap(normalized, maxCells);

    let text = formatValuesOutput(capped.values, format);
    if (capped.truncated) {
      const keptCells = capped.values.length * cols;
      text += '\n' + truncationNotice(capped.totalCells, keptCells, `omitted ${capped.omittedRows} rows — narrow the range or pass a higher maxCells`);
    }

    const structured: Record<string, unknown> = {
      range: concrete,
      rows: capped.values.length,
      cols,
      totalCells: capped.totalCells,
      truncated: capped.truncated,
    };
    if (capped.omittedRows > 0) structured.omittedRows = capped.omittedRows;

    return { text, structured } satisfies OpResult;
  },
};