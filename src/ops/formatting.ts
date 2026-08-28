import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import { opError } from '../lib/errors.js';
import { makeSheetScope } from '../lib/ctx.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';
import { spreadsheetIdParam } from './values.js';
import { hexToRgbColor } from './structure.js';
import type { sheets_v4 } from 'googleapis';
import { parseFullRange } from '../lib/a1.js';

/** #RRGGBB or #RGB hex → ColorStyle for the API. */
function colorStyle(hex: string): { rgbColor: { red: number; green: number; blue: number } } {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) opError(`Invalid color "${hex}". Use #RRGGBB (or #RGB).`);
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { rgbColor: { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 } };
}

const hexColor = z
  .string()
  .regex(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, 'Use #RRGGBB hex, e.g. #FFCC00 or #FC0.')
  .transform((v) => `#${v.replace('#', '').toUpperCase()}`);

async function batchUpdate(svc: Svc, spreadsheetId: string, requests: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const { result } = await executeWithRetry(() =>
    svc.sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requests as never } }),
  );
  return (result.data.replies ?? []) as Record<string, unknown>[];
}

/**
 * Build the repeatCell fields mask from the keys actually set. Only leaf keys
 * the caller provided are masked, so unmentioned formatting is untouched.
 */
function buildFieldMask(format: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(format)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      if (key === 'numberFormat') {
        parts.push('userEnteredFormat.numberFormat');
      } else {
        for (const sub of Object.keys(value as Record<string, unknown>)) {
          parts.push(`userEnteredFormat.${key}.${sub}`);
        }
      }
    } else {
      parts.push(`userEnteredFormat.${key}`);
    }
  }
  return parts.join(',');
}

const formatCellsSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  range: z.string().min(1).describe("Range to format, e.g. 'Sheet 1'!A1:D10."),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  fontSize: z.number().int().min(1).max(400).optional().describe('Font size in points.'),
  fontColor: hexColor.optional().describe('Text color, #RRGGBB.'),
  backgroundColor: hexColor.optional().describe('Cell background color, #RRGGBB.'),
  numberFormat: z.string().optional().describe('Number format pattern, e.g. "0.00", "#,##0", "0.0%", "$#,##0.00", "yyyy-mm-dd".'),
  horizontalAlignment: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
  verticalAlignment: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).optional(),
  wrap: z.enum(['WRAP', 'OVERFLOW_CELL', 'LEGACY_WRAP']).optional().describe('Text wrapping.'),
});

export const formatCellsOp: Op = {
  name: 'format_cells',
  group: 'formatting',
  description:
    'Format a range: bold/italic/strikethrough, font size, font/background color, number format, alignment, wrapping. Only provided properties change.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(formatCellsSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const gridRange = await scope.toGrid(String(args.range));

    const format: Record<string, unknown> = {};
    if (args.bold !== undefined || args.italic !== undefined || args.strikethrough !== undefined || args.fontSize !== undefined || args.fontColor !== undefined) {
      const tf: Record<string, unknown> = {};
      if (args.bold !== undefined) tf.bold = args.bold;
      if (args.italic !== undefined) tf.italic = args.italic;
      if (args.strikethrough !== undefined) tf.strikethrough = args.strikethrough;
      if (args.fontSize !== undefined) tf.fontSize = args.fontSize;
      if (args.fontColor !== undefined) tf.foregroundColorStyle = colorStyle(String(args.fontColor));
      format.textFormat = tf;
    }
    if (args.backgroundColor !== undefined) format.backgroundColorStyle = colorStyle(String(args.backgroundColor));
    if (args.numberFormat !== undefined) format.numberFormat = { type: 'NUMBER', pattern: String(args.numberFormat) };
    if (args.horizontalAlignment !== undefined) format.horizontalAlignment = args.horizontalAlignment;
    if (args.verticalAlignment !== undefined) format.verticalAlignment = args.verticalAlignment;
    if (args.wrap !== undefined) format.wrapStrategy = args.wrap;

    if (Object.keys(format).length === 0) {
      opError('No formatting properties provided. Pass at least one of: bold, italic, fontSize, fontColor, backgroundColor, numberFormat, horizontalAlignment, verticalAlignment, wrap.');
    }

    await batchUpdate(svc, spreadsheetId, [
      { repeatCell: { range: gridRange, cell: { userEnteredFormat: format }, fields: buildFieldMask(format) } },
    ]);
    return { text: `Formatted ${String(args.range)}.` } satisfies OpResult;
  },
};

const mergeSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  range: z.string().min(1).describe('Range to merge, e.g. A1:D1 (a title row).'),
  mode: z.enum(['ALL', 'COLUMNS', 'ROWS']).default('ALL').describe('ALL = one big cell; COLUMNS/ROWS merge each column/row separately.'),
});

export const mergeCellsOp: Op = {
  name: 'merge_cells',
  group: 'formatting',
  description: 'Merge cells in a range (mode: ALL = one cell, COLUMNS or ROWS). unmerge=true to undo.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      range: z.string().min(1).describe('Range to merge or unmerge.'),
      mode: z.enum(['ALL', 'COLUMNS', 'ROWS']).default('ALL'),
      unmerge: z.boolean().optional().describe('Unmerge the range instead of merging.'),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const gridRange = await scope.toGrid(String(args.range));
    if (args.unmerge === true) {
      await batchUpdate(svc, spreadsheetId, [{ unmergeCells: { range: gridRange } }]);
      return { text: `Unmerged ${String(args.range)}.` } satisfies OpResult;
    }
    await batchUpdate(svc, spreadsheetId, [
      { mergeCells: { range: gridRange, mergeType: args.mode === 'COLUMNS' ? 'MERGE_COLUMNS' : args.mode === 'ROWS' ? 'MERGE_ROWS' : 'MERGE_ALL' } },
    ]);
    return { text: `Merged ${String(args.range)} (mode: ${args.mode ?? 'ALL'}).` } satisfies OpResult;
  },
};

const freezeSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  sheet: z.string().min(1).describe('Sheet name or gid.'),
  rows: z.number().int().min(0).optional().describe('Number of rows to freeze from the top (0 = unfreeze).'),
  columns: z.number().int().min(0).optional().describe('Columns to freeze from the left (0 = unfreeze).'),
});

export const freezeRowsColumnsOp: Op = {
  name: 'freeze_rows_columns',
  group: 'formatting',
  description: 'Freeze rows and/or columns on a sheet (sticky headers). Pass 0 to unfreeze.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      sheet: z.string().min(1).describe('Sheet name or gid.'),
      rows: z.number().int().min(0).optional(),
      cols: z.number().int().min(0).optional(),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const sheetId = await scope.resolveSheet(String(args.sheet));
    const grid: Record<string, unknown> = {};
    const fields: string[] = [];
    if (args.rows !== undefined) {
      grid.frozenRowCount = args.rows;
      fields.push('gridProperties.frozenRowCount');
    }
    if (args.cols !== undefined) {
      grid.frozenColumnCount = args.cols;
      fields.push('gridProperties.frozenColumnCount');
    }
    if (fields.length === 0) opError('Nothing to change: pass rows and/or columns to freeze (0 to unfreeze).');
    await batchUpdate(svc, spreadsheetId, [
      { updateSheetProperties: { properties: { sheetId, gridProperties: grid }, fields: fields.join(',') } },
    ]);
    const bits: string[] = [];
    if (args.rows !== undefined) bits.push(`${args.rows} row(s)`);
    if (args.cols !== undefined) bits.push(`${args.cols} column(s)`);
    return { text: `Froze ${bits.join(' and ')} on ${String(args.sheet)}.` } satisfies OpResult;
  },
};

const conditionalFormatSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  range: z.string().min(1).describe('Range the rule applies to.'),
  action: z.enum(['add', 'delete']).describe('add = create a rule; delete = remove one by index (from get_formatting).'),
  when: z.string().optional().describe(
    "add only — condition. Examples: \"TEXT == 'DONE'\", \"NUMBER >= 100\", \"TEXT CONTAINS 'urgent'\", \"EMPTY\", \"NOT_EMPTY\".",
  ),
  backgroundColor: hexColor.optional().describe('add only — cell background when the condition matches.'),
  fontColor: hexColor.optional().describe('add only — text color when the condition matches.'),
  bold: z.boolean().optional().describe('add only — make text bold when the condition matches.'),
  index: z.number().int().min(0).optional().describe('delete only — rule index from get_formatting (0 = oldest rule).'),
});

export const conditionalFormatOp: Op = {
  name: 'conditional_format',
  group: 'formatting',
  description: 'Add or delete conditional formatting rules (highlight cells when a condition holds). Use get_formatting to list existing rules and their indices.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(conditionalFormatSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const sheetId = await sheetOfRange(String(args.range), scope);

    if (args.action === 'delete') {
      if (typeof args.index !== 'number') opError('delete requires the rule index (see get_formatting).');
      await batchUpdate(svc, spreadsheetId, [
        { deleteConditionalFormatRule: { sheetId, index: args.index } },
      ]);
      return { text: `Deleted conditional format rule #${args.index}.` } satisfies OpResult;
    }

    if (typeof args.when !== 'string') opError('add requires a "when" condition, e.g. "TEXT == \'DONE\'" or "NUMBER >= 100".');
    const condition = parseCondition(args.when);

    const cf: Record<string, unknown> = {};
    if (args.backgroundColor !== undefined) cf.backgroundColorStyle = colorStyle(String(args.backgroundColor));
    if (args.fontColor !== undefined || args.bold !== undefined) {
      const tf: Record<string, unknown> = {};
      if (args.fontColor !== undefined) tf.foregroundColorStyle = colorStyle(String(args.fontColor));
      if (args.bold !== undefined) tf.bold = args.bold;
      cf.textFormat = tf;
    }
    if (Object.keys(cf).length === 0) {
      opError('Provide backgroundColor and/or fontColor (and/or bold) for the rule format.');
    }

    await batchUpdate(svc, spreadsheetId, [
      { addConditionalFormatRule: { rule: { ranges: [await scope.toGrid(String(args.range))], booleanRule: { condition, format: cf } }, index: 0 } },
    ]);
    return { text: `Added conditional format rule to ${String(args.range)}.` } satisfies OpResult;
  },
};

/** Resolve the sheet name portion of a range (or the default sheet) to a gid. */
async function sheetOfRange(range: string, scope: ReturnType<typeof makeSheetScope>): Promise<number> {
  const { sheet } = parseFullRange(range);
  if (sheet) return scope.resolveSheet(sheet);
  const list = await scope.sheets();
  if (list.length === 0) opError('Spreadsheet has no sheets.');
  return list[0]!.sheetId;
}

/** Parse a friendly condition string into a BooleanCondition. */
function parseCondition(input: string): { type: string; values: Array<{ userEnteredValue: string }> } {
  const s = input.trim();
  const m = /^(TEXT|NUMBER)\s*(==|!=|>=|<=|>|<|CONTAINS|STARTS_WITH|ENDS_WITH)\s*(.+)$/.exec(s);
  if (!m) {
    const simple = s.trim().toUpperCase();
    if (simple === 'EMPTY' || simple === 'BLANK') return { type: 'BLANK', values: [] };
    if (simple === 'NOT_EMPTY' || simple === 'NOT_BLANK') return { type: 'NOT_BLANK', values: [] };
    opError(
      `Cannot parse condition "${s}". Examples: "TEXT == 'DONE'", "NUMBER >= 100", "TEXT CONTAINS 'urgent'", "EMPTY", "NOT_EMPTY".`,
    );
  }
  const kind = m[1] as 'TEXT' | 'NUMBER';
  const op = m[2]!;
  const value = m[3]!.trim().replace(/^['"]|['"]$/g, '');
  const type = kind === 'TEXT' ? textOp(op) : numberOp(op);
  return { type, values: [{ userEnteredValue: value }] };

  function textOp(o: string): string {
    switch (o) {
      case '==': return 'TEXT_EQ';
      case '!=': return 'TEXT_NOT_EQ';
      case 'CONTAINS': return 'TEXT_CONTAINS';
      case 'STARTS_WITH': return 'TEXT_STARTS_WITH';
      case 'ENDS_WITH': return 'TEXT_ENDS_WITH';
      default: opError(`Operator ${o} is not valid for TEXT conditions. Use ==, !=, CONTAINS, STARTS_WITH, ENDS_WITH, EMPTY, NOT_EMPTY.`);
    }
  }
  function numberOp(o: string): string {
    switch (o) {
      case '>': return 'NUMBER_GREATER';
      case '>=': return 'NUMBER_GREATER_THAN_OR_EQ';
      case '<': return 'NUMBER_LESS';
      case '<=': return 'NUMBER_LESS_THAN_OR_EQ';
      case '==': return 'NUMBER_EQ';
      case '!=': return 'NUMBER_NOT_EQ';
      default: opError(`Operator ${o} is not valid for NUMBER conditions.`);
    }
  }
}

/** Run-length-encoded formatting read — the token-efficient formatting snapshot. */
export const getFormattingOp: Op = {
  name: 'get_formatting',
  group: 'formatting',
  description:
    'Read applied formatting (background, text color/style, number format) as compact run-length-encoded ranges, plus merges and conditional rules. Much cheaper than reading the full grid.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      sheet: z.string().min(1).describe('Sheet name or gid to inspect.'),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const { result: res } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.get({
        spreadsheetId,
        ranges: [String(args.sheet)],
        includeGridData: true,
        fields:
          'sheets(properties.title,merges,conditionalFormats),' +
          'sheets.data.rowData.values.userEnteredFormat',
      }),
    );
    const sheet = res.data.sheets?.[0];
    const grid = sheet?.data?.[0];
    if (!grid) return { text: 'No grid data returned for this sheet.' } satisfies OpResult;

    // RLE: consecutive rows with identical per-column format signatures coalesce.
    const runs: string[] = [];
    const rowsOut: string[] = [];
    const cellSig = (f: Record<string, unknown> | null | undefined): string => {
      if (!f || Object.keys(f).length === 0) return '';
      const bg = hexOf(f.backgroundColorStyle as Never | undefined);
      const tf = f.textFormat as { bold?: boolean; italic?: boolean; foregroundColorStyle?: Never } | undefined;
      const nf = f.numberFormat as { pattern?: string } | undefined;
      const bits: string[] = [];
      if (bg) bits.push(`bg=${bg}`);
      if (tf?.bold) bits.push('bold');
      if (tf?.italic) bits.push('italic');
      if (tf?.foregroundColorStyle) bits.push(`fg=${hexOf(tf.foregroundColorStyle)}`);
      if (nf?.pattern) bits.push(`numfmt=${nf.pattern}`);
      return bits.join(',');
    };
    const colLetter = (n: number): string => {
      let s = '';
      let v = n + 1;
      while (v > 0) { const r = (v - 1) % 26; s = String.fromCharCode(65 + r) + s; v = Math.floor((v - 1) / 26); }
      return s;
    };

    // RLE per row: each row's signature is its list of per-column format strings;
    // consecutive rows with identical signatures coalesce into one range line.
    const rowSigs: string[] = (grid.rowData ?? []).map((row) =>
      JSON.stringify((row.values ?? []).map((cell) => cellSig(cell.userEnteredFormat as Record<string, unknown> | null | undefined))),
    );
    let start = 0;
    for (let r = 1; r <= rowSigs.length; r++) {
      if (r === rowSigs.length || rowSigs[r] !== rowSigs[start]) {
        const sigs: string[] = JSON.parse(rowSigs[start]!);
        const nonEmpty = sigs.filter((s) => s !== '');
        if (nonEmpty.length > 0) {
          const endRow = r - 1;
          const label = start === endRow ? `row ${start + 1}` : `rows ${start + 1}-${endRow + 1}`;
          const cells = sigs
            .map((s, c) => (s === '' ? null : `${colLetter(c)}: ${s}`))
            .filter((x): x is string => x !== null);
          rowsOut.push(`${label} → ${cells.join('; ')}`);
        }
        start = r;
      }
    }
    if (rowsOut.length > 0) runs.push(...rowsOut);

    const merges = (sheet.merges ?? [])
      .filter((m) => m.startRowIndex !== undefined)
      .map((m) => `${colLetter(m.startColumnIndex ?? 0)}${(m.startRowIndex ?? 0) + 1}:${colLetter((m.endColumnIndex ?? 1) - 1)}${m.endRowIndex ?? 0}`);
    const condRules = (sheet.conditionalFormats ?? []).map((cf, i) => {
      const rule = cf.booleanRule;
      return `${i}: ${rule?.condition?.type ?? '?'}${(rule?.condition?.values ?? []).map((v) => ` ${v.userEnteredValue}`).join('')} → ${hexOf(rule?.format?.backgroundColorStyle as Never | undefined) ?? 'no bg'}`;
    });

    const parts: string[] = [];
    if (runs.length > 0) parts.push(runs.join('\n'));
    else parts.push('(no non-default formatting)');
    if (merges.length > 0) parts.push(`merges: ${merges.join(', ')}`);
    if (condRules.length > 0) parts.push(`conditional rules (index: rule):\n  ${condRules.join('\n  ')}`);
    return { text: parts.join('\n') } satisfies OpResult;
  },
};

type Never = Record<string, unknown> | undefined;

function hexOf(style: { rgbColor?: { red?: number; green?: number; blue?: number } } | undefined | null): string | null {
  const c = style?.rgbColor;
  if (!c) return null;
  const to2 = (x: number | undefined): string =>
    Math.round((x ?? 0) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${to2(c.red ?? 0)}${to2(c.green ?? 0)}${to2(c.blue ?? 0)}`;
}
