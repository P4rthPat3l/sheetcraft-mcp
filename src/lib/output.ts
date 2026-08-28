export type OutputFormat = 'csv' | 'tsv' | 'grid' | 'records';

/** Hard cap on cells returned per read. Keeps any single tool result bounded. */
export const MAX_CELLS_DEFAULT = 5_000;
export const MAX_CELLS_HARD = 50_000;

/** Escape a value for RFC-4180-ish CSV/TSV with quoted-field support. */
function csvEscape(v: string, sep: string): string {
  if (v.includes('"') || v.includes(sep) || v.includes('\n') || v.includes('\r')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** Render a 2D array of values in the requested text format. Values are stringified. */
export function formatValuesOutput(
  values: readonly (readonly (string | number | boolean | null)[])[],
  format: OutputFormat,
): string {
  if (format === 'grid') {
    return JSON.stringify(values);
  }
  if (format === 'records') {
    return JSON.stringify(recordsOf(values));
  }
  const sep = format === 'tsv' ? '\t' : ',';
  return values.map((row) => row.map((v) => csvEscape(stringify(v), sep)).join(sep)).join('\n');
}

/** First row = headers; subsequent rows become objects keyed by header. Duplicate headers get _2, _3 suffixes. */
export function recordsOf(
  values: readonly (readonly (string | number | boolean | null)[])[],
): Record<string, string | number | boolean | null>[] {
  if (values.length === 0) return [];
  const seen = new Map<string, number>();
  const headers = values[0]!.map((h, i) => {
    const base = h === null || h === '' ? `col${i + 1}` : String(h);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
  return values.slice(1).map((row) => {
    const rec: Record<string, string | number | boolean | null> = {};
    headers.forEach((h, i) => {
      rec[h] = row[i] ?? null;
    });
    return rec;
  });
}

function stringify(v: string | number | boolean | null): string {
  if (v === null) return '';
  return String(v);
}

/** Cell cap with an actionable truncation message. */
export function cellCap(
  values: (string | number | boolean | null)[][],
  maxCells: number,
): { values: (string | number | boolean | null)[][]; totalCells: number; truncated: boolean; omittedRows: number } {
  const totalRows = values.length;
  const cols = values.reduce((m, r) => Math.max(m, r.length), 0);
  const totalCells = totalRows * cols;
  if (totalCells <= maxCells) {
    return { values, totalCells, truncated: false, omittedRows: 0 };
  }
  const rowsFit = Math.max(0, Math.floor(maxCells / Math.max(cols, 1)));
  const kept = values.slice(0, rowsFit);
  return {
    values: kept,
    totalCells,
    truncated: true,
    omittedRows: totalRows - rowsFit,
  };
}

/**
 * Truncation notice that tells the model how to get the rest.
 */
export function truncationNotice(
  totalCells: number,
  keptCells: number,
  how: string,
): string {
  return `[truncated: showing ${keptCells} of ${totalCells} cells — ${how}]`;
}