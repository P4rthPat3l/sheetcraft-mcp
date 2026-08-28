import { z } from 'zod';
import { zodSchema } from '../lib/schema.js';
import type { Op, OpResult } from '../lib/types.js';
import type { Svc } from '../lib/ctx.js';
import { executeWithRetry } from '../lib/retry.js';
import { SheetsError, SHEETS_ERROR_CODE } from '../lib/errors.js';
import { spreadsheetIdParam } from './values.js';
import { parseSpreadsheetId } from '../lib/spreadsheet-id.js';

/** Share a spreadsheet with a user — also fixes the SA-ownership visibility trap. */
export const shareSpreadsheetOp: Op = {
  name: 'share_spreadsheet',
  group: 'drive',
  description:
    'Grant a Google account access to a spreadsheet. In service-account mode use this after create_spreadsheet, or the sheet stays invisible to humans (SAs own what they create).',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      email: z.string().min(3).describe('Google account email to share with.'),
      role: z.enum(['reader', 'commenter', 'writer']).default('reader').describe('Access level (default reader).'),
      notify: z.boolean().default(true).describe('Send a notification email (default true).'),
    }),
  ),
  run: async (args, svc) => {
    const fileId = String(args.spreadsheetId).trim();
    const email = String(args.email).trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new SheetsError('INVALID_ARGUMENT', `"${email}" is not an email address.`);
    }
    const { result } = await executeWithRetry(() =>
      svc.drive.permissions.create({
        fileId,
        sendNotificationEmail: args.notify !== false,
        supportsAllDrives: true,
        requestBody: { type: 'user', role: args.role as string, emailAddress: email },
      }),
    );
    return {
      text: `Shared with ${email} as ${args.role}${args.notify === false ? ' (no email sent)' : ''}.`,
      structured: { permissionId: result.data.id, email, role: args.role },
    } satisfies OpResult;
  },
};

/** Find spreadsheets visible to the service account. Candidates only — never auto-select. */
export const findSpreadsheetsOp: Op = {
  name: 'find_spreadsheets',
  group: 'drive',
  description:
    'Search spreadsheets by name. Returns candidate IDs + names + modified times; IDs are not auto-selected. Note: only sees spreadsheets the authenticated identity can access (OAuth: your Drive; SA: files shared with it).',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      query: z.string().optional().describe('Name substring to match. Omit to list all visible spreadsheets.'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max results (default 20).'),
    }),
  ),
  run: async (args, svc) => {
    const namePart = typeof args.query === 'string' && args.query.trim() !== '' ? String(args.query) : '';
    const q = [
      "mimeType='application/vnd.google-apps.spreadsheet'",
      'trashed=false',
      ...(namePart ? [`name contains '${namePart.replace(/'/g, "\\'")}'`] : []),
    ].join(' and ');
    const { result } = await executeWithRetry(() =>
      svc.drive.files.list({
        q,
        pageSize: typeof args.limit === 'number' ? args.limit : 25,
        orderBy: 'modifiedTime desc',
        fields: 'nextPageToken, files(id, name, modifiedTime, owners(displayName))',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    const files = (result.data.files ?? []).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
    if (files.length === 0) {
      return {
        text:
          'No spreadsheets found. In service-account mode, files must be shared with the SA email (or created by it) to be visible here.',
        structured: { files: [] },
      } satisfies OpResult;
    }
    const lines = files.map((f) => `${f.name} — ${f.id}`);
    return {
      text: ['Candidates (pass the ID to other tools):', ...lines].join('\n'),
      structured: { files },
    } satisfies OpResult;
  },
};

/** Create an empty spreadsheet. Content is written afterwards with update_values/append_rows. */
export const createSpreadsheetOp: Op = {
  name: 'create_spreadsheet',
  group: 'drive',
  description:
    'Create a new empty spreadsheet. Owned by whoever is logged in (OAuth: you; service account: the SA). In SA mode pass shareWith emails or it stays invisible to humans. Add headers with append_rows afterwards.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: zodSchema(
    z.object({
      name: z.string().min(1).describe('Spreadsheet title.'),
      shareWith: z.array(z.string()).optional().describe('Email addresses to grant write access immediately.'),
    }),
  ),
  run: async (args, svc) => {
    const name = String(args.name);
    const { result: file } = await executeWithRetry(() =>
      svc.drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.spreadsheet' },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
      }),
    );
    const id = file.data.id ?? '';
    let shared = 0;
    const emails = Array.isArray(args.shareWith) ? (args.shareWith as string[]) : [];
    for (const email of emails) {
      await executeWithRetry(() =>
        svc.drive.permissions.create({
          fileId: id,
          sendNotificationEmail: true,
          requestBody: { type: 'user', role: 'writer', emailAddress: email },
          supportsAllDrives: true,
        }),
      );
      shared++;
    }
    return {
      text:
        `Created spreadsheet "${name}" — id: ${id}\n` +
        `URL: https://docs.google.com/spreadsheets/d/${id}/edit` +
        (shared > 0
          ? `\nShared with ${shared} email(s).`
          : '\nCreated empty — add headers with append_rows next. (In service-account mode, also share it: SAs own what they create.)'),
      structured: { spreadsheetId: id, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, sharedWith: shared },
    } satisfies OpResult;
  },
};

/** Copy an existing spreadsheet. */
export const copySpreadsheetOp: Op = {
  name: 'copy_spreadsheet',
  group: 'drive',
  description: 'Copy a spreadsheet (data, formulas and formatting; sharing is not copied).',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      name: z.string().optional().describe('Title for the copy (default: "Copy of <original>").'),
    }),
  ),
  run: async (args, svc) => {
    const fileId = String(args.spreadsheetId).trim();
    const { result } = await executeWithRetry(() =>
      svc.drive.files.copy({
        fileId,
        requestBody: args.name ? { name: String(args.name) } : undefined,
        fields: 'id, name',
        supportsAllDrives: true,
      }),
    );
    const id = result.data.id ?? '';
    return {
      text: `Copied to "${result.data.name}" — id: ${id}\nURL: https://docs.google.com/spreadsheets/d/${id}/edit`,
      structured: { spreadsheetId: id, name: result.data.name ?? '' },
    } satisfies OpResult;
  },
};

/** Trash (default) or permanently delete a spreadsheet. */
export const trashSpreadsheetOp: Op = {
  name: 'trash_spreadsheet',
  group: 'drive',
  description:
    'Move a spreadsheet to Drive trash (restorable). permanent=true bypasses trash and cannot be undone.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      permanent: z.boolean().optional().describe('Permanently delete instead of trashing. Cannot be undone.'),
    }),
  ),
  run: async (args, svc) => {
    const fileId = String(args.spreadsheetId).trim();
    if (args.permanent === true) {
      await executeWithRetry(() => svc.drive.files.delete({ fileId, supportsAllDrives: true }));
      return { text: `Permanently deleted spreadsheet ${fileId}. This cannot be undone.` } satisfies OpResult;
    }
    await executeWithRetry(() =>
      svc.drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true }),
    );
    return {
      text: `Moved spreadsheet ${fileId} to trash (restorable for 30 days).`,
      structured: { trashed: true },
    } satisfies OpResult;
  },
};

/** Export the whole spreadsheet to xlsx/pdf/ods. (Drive CSV export is first-sheet-only — use get_values for per-sheet CSV.) */
export const exportSpreadsheetOp: Op = {
  name: 'export_spreadsheet',
  group: 'drive',
  description:
    'Download the spreadsheet as xlsx, pdf or ods (whole document). For per-sheet CSV use get_values instead — Drive CSV export covers only the first sheet.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      spreadsheetId: spreadsheetIdParam,
      mimeType: z.enum(['xlsx', 'pdf', 'ods']).describe('Export format.'),
    }),
  ),
  run: async (args, svc) => {
    const fileId = parseSpreadsheetId(String(args.spreadsheetId));
    const mime =
      args.mimeType === 'pdf'
        ? 'application/pdf'
        : args.mimeType === 'ods'
          ? 'application/vnd.oasis.opendocument.spreadsheet'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const { result } = await executeWithRetry(() =>
      svc.drive.files.export({ fileId, mimeType: mime }, { responseType: 'arraybuffer' }),
    );
    const data = result.data;
    const bytes = data instanceof ArrayBuffer ? data.byteLength : Buffer.byteLength(data as never);
    if (bytes === 0) {
      return { text: `Export failed: received 0 bytes for ${args.mimeType}.` } satisfies OpResult;
    }
    return {
      text:
        `Export generated: ${args.mimeType}, ${bytes} bytes. ` +
        `Binary content is discarded on the MCP surface; use the sheets CLI with --out <file> to save it to disk.`,
      structured: { bytes, mimeType: mime, fileId },
    } satisfies OpResult;
  },
};

/** Parse a Sheets URL into spreadsheetId + gid. Solves the URL→ID fumble. */
export const resolveTargetOp: Op = {
  name: 'resolve_target',
  group: 'drive',
  description: 'Parse a Google Sheets URL into spreadsheetId and gid (tab). Accepts bare IDs too.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  inputSchema: zodSchema(
    z.object({
      url: z.string().min(1).describe('A Google Sheets URL or spreadsheet ID.'),
    }),
  ),
  run: async (args) => {
    const s = String(args.url);
    const idMatch = /\/d\/([a-zA-Z0-9-_]{20,})/.exec(s);
    const gidMatch = /[#&?]gid=(\d+)/.exec(s);
    const id = idMatch ? idMatch[1]! : /^[a-zA-Z0-9-_]{20,}$/.test(s.trim()) ? s.trim() : null;
    if (!id) {
      throw new SheetsError(
        'INVALID_ARGUMENT',
        `"${s}" does not contain a spreadsheet ID. Expected .../d/<ID>/edit... or a bare ID.`,
      );
    }
    const lines = [`spreadsheetId: ${id}`];
    if (gidMatch) lines.push(`gid: ${gidMatch[1]}`);
    return { text: lines.join('\n'), structured: { spreadsheetId: id, gid: gidMatch ? Number(gidMatch[1]) : undefined } } satisfies OpResult;
  },
};