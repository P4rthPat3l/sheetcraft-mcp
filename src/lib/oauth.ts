import { OAuth2Client } from 'google-auth-library';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { SheetsError, SHEETS_ERROR_CODE } from './errors.js';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

/** Where the OAuth client config lives. Override with SHEETS_OAUTH_CLIENT_FILE. */
export function oauthClientFile(): string {
  return (
    process.env.SHEETS_OAUTH_CLIENT_FILE ??
    join(homedir(), '.config', 'sheetcraft-mcp', 'oauth-client.json')
  );
}

/** Where tokens are persisted (0600). Override with GOOGLE_OAUTH_TOKEN_FILE. */
export function tokenStorePath(): string {
  return process.env.GOOGLE_OAUTH_TOKEN_FILE ?? join(homedir(), '.config', 'sheetcraft-mcp', 'oauth-tokens.json');
}

export interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  /** The authenticated user's email, cached at login for display. */
  email?: string;
}

export function loadStoredTokens(): StoredTokens | null {
  const path = tokenStorePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredTokens;
  } catch {
    return null;
  }
}

export function saveStoredTokens(tokens: StoredTokens): void {
  const path = tokenStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // mode only applies on create — re-tighten existing files
}

export function clearStoredTokens(): boolean {
  const path = tokenStorePath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/**
 * Read OAuth client credentials (client_id + client_secret). Sources, in order:
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars,
 *   then the well-known file (supports flat format and gcloud-style installed/web blocks).
 */
export function loadClientConfig(): { clientId: string; clientSecret: string } {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (id && secret) return { clientId: id, clientSecret: secret };

  const path = oauthClientFile();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const block =
        (raw as { installed?: Record<string, unknown> }).installed ??
        (raw as { web?: Record<string, unknown> }).web ??
        raw;
      const clientId = (block as { client_id?: unknown }).client_id;
      const clientSecret = (block as { client_secret?: unknown }).client_secret;
      if (typeof clientId === 'string' && typeof clientSecret === 'string') {
        return { clientId, clientSecret };
      }
    } catch {
      // corrupt file → fall through to teaching error
    }
  }
  throw new SheetsError(
    SHEETS_ERROR_CODE.CONFIG,
    'OAuth client credentials not found. Create an OAuth Client ID (type "Desktop app") in Google Cloud Console, then either:\n' +
      `  1. Save the downloaded JSON to ${oauthClientFile()}, or\n` +
      '  2. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars.',
  );
}

/**
 * Build an OAuth2Client from stored tokens (persisting refreshes), or null when
 * no login has happened / no refresh token exists.
 */
export function makeOAuthClientFromStore(): OAuth2Client | null {
  const stored = loadStoredTokens();
  if (!stored?.refresh_token) return null;
  const { clientId, clientSecret } = loadClientConfig();
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry_date,
  });
  // Persist refreshed access tokens so restarts don't rely on the in-memory copy.
  client.on('tokens', (t) => {
    saveStoredTokens({
      ...stored,
      access_token: t.access_token ?? stored.access_token,
      refresh_token: t.refresh_token ?? stored.refresh_token,
      expiry_date: t.expiry_date ?? stored.expiry_date,
    });
  });
  return client;
}

export interface LoginResult {
  email: string;
  tokenFile: string;
}

/**
 * Interactive login: loopback server on an ephemeral port → browser consent →
 * code exchange → tokens persisted (0600). Returns the authenticated email.
 */
export async function loginFlow(opts: { forceConsent?: boolean } = {}): Promise<LoginResult> {
  const { clientId, clientSecret } = loadClientConfig();
  const client = new OAuth2Client({ clientId, clientSecret });
  let redirectUriValue = '';

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new SheetsError(SHEETS_ERROR_CODE.CONFIG, 'Login timed out after 2 minutes — no consent callback arrived. Run `sheets auth login` and complete the browser step.'));
    }, 120_000);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const safeError = error ? error.replace(/[<>&"]/g, '') : error;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding-top:4rem">` +
          `<h2>${safeError ? 'Authorization failed' : 'Authorized — you can close this tab.'}</h2>` +
          `<p>${safeError ?? 'Token stored. Return to your terminal.'}</p></body></html>`,
      );
      setTimeout(() => {
        server.close();
        clearTimeout(timeout);
        if (error || !code) reject(new Error(error ?? 'No authorization code in the OAuth callback.'));
        else resolve(code);
      }, 300);
    });
    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(
        new SheetsError(
          SHEETS_ERROR_CODE.CONFIG,
          `Could not start the local OAuth callback server on 127.0.0.1: ${err.message}`,
        ),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      redirectUriValue = redirectUri;
      const authUrl = client.generateAuthUrl({
        redirect_uri: redirectUri,
        access_type: 'offline',
        ...(opts.forceConsent ? { prompt: 'consent' } : {}),
        scope: OAUTH_SCOPES,
      });
      console.log('\nOpening your browser for Google consent...');
      console.log('If it does not open automatically, paste this URL into a browser:\n');
      console.log(authUrl + '\n');
      // execFile (array argv) — never interpolate the URL into a shell string.
      execFile('xdg-open', [authUrl], () => {
        if (process.platform === 'darwin') execFile('open', [authUrl], () => {});
      });
    });
  });

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUriValue });
  if (!tokens.refresh_token) {
    throw new SheetsError(
      SHEETS_ERROR_CODE.CONFIG,
      'Google did not return a refresh token. Re-run the login and make sure to grant access (or revoke this app at https://myaccount.google.com/permissions and log in again).',
    );
  }
  client.setCredentials(tokens);

  // Cache the account email for display. We don't request userinfo.email scope,
  // so derive it from a Drive about call instead (non-fatal if it fails).
  let email = '';
  try {
    const { google } = await import('googleapis');
    const drive = google.drive({ version: 'v3', auth: client });
    const about = await drive.about.get({ fields: 'user(emailAddress)' });
    email = about.data.user?.emailAddress ?? '';
  } catch {
    email = '';
  }

  saveStoredTokens({
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token ?? '',
    expiry_date: tokens.expiry_date ?? undefined,
    email,
  });
  return { email, tokenFile: tokenStorePath() };
}
