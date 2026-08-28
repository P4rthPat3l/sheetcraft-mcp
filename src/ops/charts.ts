import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import { opError } from '../lib/errors.js';
import { makeSheetScope } from '../lib/ctx.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';
import { spreadsheetIdParam } from './values.js';

const BASIC_CHART_TYPES = ['COLUMN', 'BAR', 'LINE', 'AREA', 'SCATTER', 'COMBO', 'STEPPED_AREA'] as const;

async function batchUpdate(
  svc: Svc,
  spreadsheetId: string,
  requests: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const { result } = await executeWithRetry(() =>
    svc.sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requests as never } }),
  );
  return (result.data.replies ?? []) as Record<string, unknown>[];
}

const createChartSchema = z.object({
  spreadsheetId: spreadsheetIdParam,
  type: z.enum(BASIC_CHART_TYPES).describe('Chart type (pie charts: use the data via a PIE spec — this tool covers the basic chart family).'),
  domain: z.string().min(1).describe("Category axis range, e.g. 'Sheet1'!A2:A10 (labels/dates)."),
  series: z.array(z.string().min(1)).min(1).describe("Value ranges, one per series, e.g. ['Sheet1'!B2:B10, 'Sheet1'!C2:C10]."),
  title: z.string().optional().describe('Chart title.'),
  sheet: z.string().optional().describe('Sheet (name or gid) to place the chart on. Default: the domain range\u2019s sheet.'),
  anchorCell: z.string().optional().describe('Cell to anchor the chart at (e.g. E2). Default: below the data.'),
  width: z.number().int().min(100).max(2000).optional().describe('Chart width in px (default 600).'),
  height: z.number().int().min(100).max(2000).optional().describe('Chart height in px (default 400).'),
  stacked: z.enum(['NONE', 'STACKED', 'PERCENT_STACKED']).optional(),
  legend: z.enum(['BOTTOM', 'LEFT', 'RIGHT', 'TOP', 'NO_LEGEND']).default('BOTTOM').describe('Legend position (default BOTTOM).'),
});

export const createChartOp: Op = {
  name: 'create_chart',
  group: 'charts',
  description:
    'Insert an embedded chart (COLUMN, BAR, LINE, AREA, SCATTER, COMBO, STEPPED_AREA) from a domain range + series ranges. Returns the chartId for update_chart/delete_chart.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: zodSchema(createChartSchema),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const domainGrid = await scope.toGrid(String(args.domain));
    const seriesGrids = [];
    for (const s of (args.series as string[]) ?? []) seriesGrids.push(await scope.toGrid(String(s)));

    // Anchor: on the domain's sheet unless overridden.
    const sheets = await scope.sheets();
    const targetGid = args.sheet ? await scope.resolveSheet(String(args.sheet)) : (domainGrid.sheetId ?? 0);
    const anchor = args.anchorCell
      ? anchorToCell(String(args.anchorCell), targetGid)
      : { sheetId: targetGid, rowIndex: 0, columnIndex: Math.max(0, (domainGrid.endColumnIndex ?? 1) + 1) };

    const spec: Record<string, unknown> = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      basicChart: {
        chartType: args.type,
        legendPosition: legendPosition(String(args.legend ?? 'BOTTOM')),
        ...(args.stacked && args.stacked !== 'NONE' ? { stackedType: args.stacked } : {}),
        domains: [{ domain: { sourceRange: { sources: [domainGrid] } } }],
        series: seriesGrids.map((r) => ({ series: { sourceRange: { sources: [r] } } })),
      } as Record<string, unknown> };

    const replies = await batchUpdate(svc, spreadsheetId, [
      { addChart: { chart: { spec, position: { overlayPosition: { anchorCell: anchor, offsetXPixels: 0, offsetYPixels: 0, widthPixels: args.width ?? 600, heightPixels: args.height ?? 400 } } } } },
    ]);
    const chartId = (replies[0]?.addChart as { chart?: { chartId?: number } } | undefined)?.chart?.chartId;
    return {
      text: `Chart created (id: ${chartId}) on gid:${targetGid}.`,
      structured: { chartId },
    } satisfies OpResult;
  },
};

export const updateChartOp: Op = {
  name: 'update_chart',
  group: 'charts',
  description: 'Replace a chart\u2019s spec (type, ranges, title, legend, stacking). Get chartId from create_chart.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      chartId: z.number().int().describe('Chart id from create_chart.'),
      type: z.enum(BASIC_CHART_TYPES).optional(),
      domain: z.string().optional().describe('Replacement category-axis range.'),
      series: z.array(z.string().min(1)).optional().describe('Replacement series ranges.'),
      title: z.string().optional(),
      legend: z.enum(['BOTTOM', 'LEFT', 'RIGHT', 'TOP', 'NO_LEGEND']).optional(),
      stacked: z.enum(['NONE', 'STACKED', 'PERCENT_STACKED']).optional(),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    const scope = makeSheetScope(svc, spreadsheetId);
    const basicChart: Record<string, unknown> = {};
    if (args.type !== undefined) basicChart.chartType = args.type;
    if (args.legend !== undefined) basicChart.legendPosition = legendPosition(String(args.legend));
    if (args.stacked !== undefined && args.stacked !== 'NONE') basicChart.stackedType = args.stacked;
    if (args.domain) basicChart.domains = [{ domain: { sourceRange: { sources: [await scope.toGrid(String(args.domain))] } } }];
    if (args.series) {
      const series: unknown[] = [];
      for (const s of args.series as string[]) series.push({ series: { sourceRange: { sources: [await scope.toGrid(s)] } } });
      basicChart.series = series;
    }
    const spec: Record<string, unknown> = { basicChart };
    if (args.title !== undefined) spec.title = args.title;
    // updateChartSpec requires the COMPLETE spec — fetch the current one and
    // overlay the caller's changes on it (a partial spec 500s server-side).
    const { result: cur } = await executeWithRetry(() =>
      svc.sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.charts(chartId,spec)' }),
    );
    const existing = curSpec(cur, Number(args.chartId));
    if (!existing) {
      opError(`No chart with id ${args.chartId} on this spreadsheet. Use get_chart_ids or check create_chart output.`);
    }
    const merged = deepMerge(existing.spec ?? {}, spec);
    await batchUpdate(svc, spreadsheetId, [{ updateChartSpec: { chartId: args.chartId, spec: merged } }]);
    return { text: `Chart ${String(args.chartId)} updated.` } satisfies OpResult;
  },
};

export const deleteChartOp: Op = {
  name: 'delete_chart',
  group: 'charts',
  description: 'Delete an embedded chart (or any embedded object) by id.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      chartId: z.number().int().describe('Chart id from create_chart (delete_chart only deletes charts).'),
    }),
  ),
  run: async (args, svc) => {
    const spreadsheetId = parseSpreadsheetId(String(args.spreadsheetId));
    await batchUpdate(svc, spreadsheetId, [{ deleteEmbeddedObject: { objectId: args.chartId } }]);
    return { text: `Deleted chart ${args.chartId}.` } satisfies OpResult;
  },
};

/** Parse an A1 cell reference like "E2" into a GridCoordinate on the given sheet. */
function anchorToCell(a1: string, sheetId: number): { sheetId: number; rowIndex: number; columnIndex: number } {
  const m = /^([A-Za-z]{1,3})(\d+)$/.exec(a1.trim());
  if (!m) opError(`Invalid anchor cell "${a1}". Use a cell like E2.`);
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { sheetId, rowIndex: Number(m[2]!) - 1, columnIndex: col - 1 };
}

/** Map our enum (BOTTOM/TOP/...) to the API's BOTTOM_LEGEND/... values. */
function legendPosition(legend: string): string {
  return legend === 'NO_LEGEND' ? 'NO_LEGEND' : `${legend}_LEGEND`;
}

/** Find a chart's full spec from a spreadsheets.get response. */
function curSpec(res: unknown, chartId: number): { spec: Record<string, unknown> } | null {
  const sheets = (res as { data?: { sheets?: Array<{ charts?: Array<{ chartId?: number | null; spec?: Record<string, unknown> | null }> | null } | null> } }).data?.sheets ?? [];
  for (const sheet of sheets) {
    for (const c of sheet?.charts ?? []) {
      if (c.chartId === chartId) return { spec: (c.spec ?? {}) as Record<string, unknown> };
    }
  }
  return null;
}

/** Recursive overlay: values in `patch` replace those in `base` (objects merge, others replace). */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    out[k] =
      v !== null && typeof v === 'object' && !Array.isArray(v) && b !== null && typeof b === 'object' && !Array.isArray(b)
        ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}
