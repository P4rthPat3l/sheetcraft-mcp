import { google } from 'googleapis';
import type { sheets_v4, drive_v3 } from 'googleapis';
import { GoogleAuth, type OAuth2Client } from 'google-auth-library';
import type { Svc } from './ctx.js';
import { DEFAULT_RETRY } from './retry.js';
import { SheetsError, SHEETS_ERROR_CODE } from './errors.js';
import { loadStoredTokens, makeOAuthClientFromStore } from './oauth.js';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

export type AuthMode = 'oauth' | 'service-account';

let cached: { svc: Svc; key: string } | null = null;

function hasSaCredentials(): boolean {
  return !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS ??
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

/**
 * Resolve which auth mode to use, WITHOUT building the client:
 *   1. explicit SHEETS_AUTH_MODE=service-account|oauth override
 *   2. SA credentials in env → service-account
 *   3. stored OAuth tokens (with refresh_token) → oauth
 *   4. none → null (caller reports the teaching error)
 */
export function resolveAuthMode(): AuthMode | null {
  const explicit = process.env.SHEETS_AUTH_MODE?.trim().toLowerCase();
  if (explicit === 'service-account' || explicit === 'oauth') return explicit;
  if (hasSaCredentials()) return 'service-account';
  const stored = loadStoredTokens();
  if (stored?.refresh_token) return 'oauth';
  return null;
}

function noAuthError(): SheetsError {
  return new SheetsError(
    SHEETS_ERROR_CODE.CONFIG,
    'No credentials configured. Two options:\n' +
      '  1. Act as yourself (can create spreadsheets): run `sheets auth login`\n' +
      '  2. Service account: set GOOGLE_SERVICE_ACCOUNT_CREDENTIALS (raw JSON key) or GOOGLE_SERVICE_ACCOUNT_FILE (path)',
  );
}

function credentialsKey(): string {
  return [
    process.env.SHEETS_AUTH_MODE ?? '',
    process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS ?? '',
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE ?? '',
    process.env.GOOGLE_OAUTH_TOKEN_FILE ?? '',
  ].join('|');
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function limits(): Pick<Svc, 'maxCells' | 'retry'> {
  return {
    maxCells: num(process.env.SHEETS_MAX_CELLS) ?? 5_000,
    retry: {
      attempts: num(process.env.SHEETS_RETRY_ATTEMPTS) ?? DEFAULT_RETRY.attempts,
      baseMs: num(process.env.SHEETS_RETRY_BASE_MS) ?? DEFAULT_RETRY.baseMs,
      maxMs: num(process.env.SHEETS_RETRY_MAX_MS) ?? DEFAULT_RETRY.maxMs,
    },
  };
}

function oauthSvc(): Svc {
  const client = makeOAuthClientFromStore();
  if (!client) throw noAuthError();
  return {
    sheetsApi: google.sheets({ version: 'v4', auth: client }),
    drive: google.drive({ version: 'v3', auth: client }),
    ...limits(),
  };
}

function saSvc(): Svc {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS;
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!raw && !file) throw noAuthError();
  const auth =
    'GOOGLE_SERVICE_ACCOUNT_CREDENTIALS' in process.env && raw
      ? new GoogleAuth({ credentials: JSON.parse(raw), scopes: SCOPES })
      : new GoogleAuth({ keyFile: file!, scopes: SCOPES });
  return {
    sheetsApi: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
    ...limits(),
  };
}

/** Authenticated services, built once per process and cached by credential source. */
export function getGoogleServices(): Svc {
  const key = credentialsKey();
  if (cached && cached.key === key) return cached.svc;
  const mode = resolveAuthMode();
  if (mode === null) throw noAuthError();
  const svc = mode === 'oauth' ? oauthSvc() : saSvc();
  cached = { svc, key };
  return svc;
}

/** Human-readable auth status for `sheets auth status`. */
export function authStatus(): { mode: AuthMode; detail: string } {
  const mode = resolveAuthMode();
  if (mode === 'oauth') {
    const stored = loadStoredTokens();
    return {
      mode,
      detail: `logged in as ${stored?.email ?? '(unknown email)'} — tokens at ${process.env.GOOGLE_OAUTH_TOKEN_FILE ?? '~/.config/gsheets-mcp/oauth-tokens.json'}`,
    };
  }
  if (mode === 'service-account') {
    return {
      mode,
      detail:
        'service account (from env). Note: Google no longer lets service accounts create files — use `sheets auth login` to create spreadsheets as yourself.',
    };
  }
  return { mode: 'service-account', detail: noAuthError().message };
}