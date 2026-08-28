import type { sheets_v4, drive_v3 } from 'googleapis';
import type { RetryConfig } from './retry.js';
import { executeWithRetry } from './retry.js';

/** A sheet (tab) in a spreadsheet. */
export interface SheetInfo {
  title: string;
  sheetId: number;
  rows: number;
  cols: number;
}

export interface Dims {
  rows: number;
  cols: number;
}

/**
 * Authenticated services + limits, shared across ops. Stateless — spreadsheet
 * context lives in a per-call SheetScope built with makeSheetScope().
 */
export interface Svc {
  readonly sheetsApi: sheets_v4.Sheets;
  readonly drive: drive_v3.Drive;
  readonly maxCells: number;
  readonly retry: RetryConfig;
}

/** Sheet list + range resolution for ONE spreadsheet, cached for the call. */
export interface SheetScope {
  readonly spreadsheetId: string;
  sheets(): Promise<readonly SheetInfo[]>;
  /** Resolve "Sheet1" / "gid:123" / "123" → gid. */
  resolveSheet(ref: string): Promise<number>;
  dimsOf(gid: number): Promise<Dims | undefined>;
  /** Concrete sheet-qualified A1 (open ends clamped to sheet dims) for values.* endpoints. */
  toA1(range: string): Promise<string>;
  /** GridRange (for batchUpdate) with the sheet resolved from the prefix or default. */
  toGrid(range: string): Promise<sheets_v4.Schema$GridRange>;
}

export function makeSheetScope(svc: Svc, spreadsheetId: string): SheetScope {
  let cache: Promise<readonly SheetInfo[]> | null = null;

  const load = (): Promise<readonly SheetInfo[]> => {
    if (!cache) {
      cache = executeWithRetry(() =>
        svc.sheetsApi.spreadsheets.get({
          spreadsheetId,
          fields: 'sheets.properties(sheetId,title,gridProperties)',
        }),
      )
        .then(({ result: res }) =>
          (res.data.sheets ?? [])
            .map((s) => s.properties)
            .filter((p): p is NonNullable<typeof p> => p != null)
            .map((p) => ({
              title: p.title ?? '',
              sheetId: p.sheetId ?? 0,
              rows: p.gridProperties?.rowCount ?? 1000,
              cols: p.gridProperties?.columnCount ?? 26,
            })),
        )
        .catch((err: unknown) => {
          cache = null; // transient failures must not poison the cache
          throw err;
        });
    }
    return cache;
  };

  const dimsOf = async (gid: number): Promise<Dims | undefined> => {
    const s = (await load()).find((h) => h.sheetId === gid);
    return s ? { rows: s.rows, cols: s.cols } : undefined;
  };

  const scope: SheetScope = {
    spreadsheetId,
    sheets: load,
    resolveSheet: async (ref: string) => {
      const { resolveSheet } = await import('./a1.js');
      return resolveSheet(ref, await load());
    },
    dimsOf,
    toA1: async (range: string) => {
      const { toConcreteA1 } = await import('./a1.js');
      return toConcreteA1(range, await load(), (gid) => dimsOf(gid));
    },
    toGrid: async (range: string) => {
      const { toGridRange } = await import('./a1.js');
      return toGridRange(range, await load());
    },
  };
  return scope;
}