import { SheetsError, SHEETS_ERROR_CODE } from './errors.js';

/** Accept a bare spreadsheet ID or a full Sheets/Drive URL and return the ID. */
export function parseSpreadsheetId(input: string): string {
  const s = (input ?? '').trim();
  if (s === '') {
    throw new SheetsError(SHEETS_ERROR_CODE.INVALID_ARGUMENT, 'spreadsheetId is required — paste the full sheet URL or the ID from it.');
  }
  const urlMatch = /\/d\/([a-zA-Z0-9-_]{20,})/.exec(s);
  if (urlMatch) return urlMatch[1]!;
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  throw new SheetsError(
    SHEETS_ERROR_CODE.INVALID_ARGUMENT,
    `"${input}" is not a spreadsheet ID or URL. Paste the full URL — the ID is the long token between /d/ and /edit.`,
  );
}