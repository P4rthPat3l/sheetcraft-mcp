#!/usr/bin/env node
/**
 * sheets — CLI wrapper over the shared core. Same ops as the MCP server,
 * one process per command. Reads print compact text; failures exit non-zero
 * with the same teaching errors the MCP surface returns.
 *
 * Usage:
 *   sheets <op-name> --key value --json            (args as flags)
 *   sheets <op-name> '{"spreadsheetId": "..."}'    (args as JSON)
 *   sheets list                                    (all ops + toolsets)
 */
import { readFileSync } from 'node:fs';
import { getGoogleServices } from '../lib/google.js';
import { ALL_OPS } from '../ops/index.js';
import { runOp } from '../lib/run.js';
import { getOp, TOOLSETS } from '../lib/registry.js';
import type { Svc } from '../lib/ctx.js';
import type { Op } from '../lib/types.js';

function usage(): string {
  const lines = [
    'sheets — Google Sheets CLI (shared core with sheets-mcp)',
    '',
    'Usage:',
    '  sheets <op> [key=value ...] [--json] [--stdin-json]',
    '  sheets list                      — list all ops by toolset',
    '  sheets help <op>                 — show one op’s parameters',
    '',
    'Toolsets: ' + Object.keys(TOOLSETS).join(', ') + ', all',
    'Examples:',
    "  sheets get_values spreadsheetId=<id> range=\"'Sheet 1'!A1:D10\"",
    '  sheets append_rows spreadsheetId=<id> sheet=Data --stdin-json < rows.json',
    '  sheets resolve_target url="https://docs.google.com/spreadsheets/d/..."',
  ];
  return lines.join('\n');
}

/** Parse argv into { op, args, flags }: key=value pairs; --key value also accepted. */
function parseArgv(argv: string[]): { opName: string | null; args: Record<string, unknown>; flags: { json: boolean } } {
  const args: Record<string, unknown> = {};
  const flags = { json: false };
  let opName: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      flags.json = true;
      continue;
    }
    if (a === '--stdin-json') {
      const input = readFileSync(0, 'utf8');
      Object.assign(args, JSON.parse(input));
      continue;
    }
    if (a.startsWith('--')) {
      const raw = a.slice(2);
      const eq = raw.indexOf('=');
      if (eq > 0) {
        args[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[raw] = next;
        i++;
      } else {
        args[raw] = true;
      }
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0 && opName !== null) {
      args[a.slice(0, eq)] = a.slice(eq + 1);
      continue;
    }
    if (opName === null) opName = a;
  }
  return { opName, args, flags };
}

function coerceArgs(op: Op, args: Record<string, unknown>): Record<string, unknown> {
  // CLI values are strings; the op's schema parse handles real validation, but
  // numeric/boolean JSON Schema types arrive as strings. Coerce obvious cases
  // per the op's JSON Schema property types before parse.
  const props = (op.inputSchema.jsonSchema as { properties?: Record<string, { type?: string; anyOf?: { type?: string }[] }> }).properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === '') continue; // --key '' means "not provided", not zero
    const p = props[k];
    const t = p?.type ?? p?.anyOf?.map((x) => x.type).find(Boolean);
    if (typeof v === 'string' && (t === 'number' || t === 'integer')) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : v;
    } else if (typeof v === 'string' && t === 'boolean') {
      out[k] = v === 'true' ? true : v === 'false' ? false : v;
    } else if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || (argv[0] === 'help' && !argv[1])) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (argv[0] === 'auth') {
    return authCommand(argv.slice(1));
  }
  if (argv[0] === 'list') {
    const lines: string[] = [];
    for (const [g, meta] of Object.entries(TOOLSETS)) {
      lines.push(`${g}: ${meta.description}`);
      for (const op of ALL_OPS.filter((o) => o.group === g)) lines.push(`  ${op.name} — ${op.description}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  const { opName, args, flags } = parseArgv(argv);
  if (!opName) {
    process.stderr.write(usage() + '\n');
    return 1;
  }
  if (opName === 'help') {
    const op = getOp(String(argv[1] ?? ''));
    if (!op) {
      process.stderr.write(`Unknown op "${argv[1]}". Run \`sheets list\` for all ops.\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify(op.inputSchema.jsonSchema, null, 2) + '\n');
    return 0;
  }
  const op = getOp(opName);
  if (!op) {
    process.stderr.write(`Unknown op "${opName}". Run \`sheets list\` for all ops.\n`);
    return 1;
  }

  const svc = lazySvc();
  const coerced = coerceArgs(op, args);
  const result = await runOp(op, coerced, svc);
  process.stdout.write(result.text + '\n');
  if (flags.json && result.structured) {
    process.stdout.write(JSON.stringify(result.structured, null, 2) + '\n');
  }
  return result.error ? 1 : 0;
}

/**
 * `sheets auth login|status|logout` — interactive browser consent, once.
 * Tokens persist at ~/.config/sheetcraft-mcp/oauth-tokens.json (0600) and
 * auto-refresh afterwards; both CLI and MCP use them automatically.
 */
async function authCommand(argv: string[]): Promise<number> {
  const sub = argv[0] ?? 'status';
  if (sub === 'login') {
    const { loginFlow, loadStoredTokens } = await import('../lib/oauth.js');
    const stored = loadStoredTokens();
    if (stored?.refresh_token && !argv.includes('--force')) {
      process.stdout.write(`Already logged in as ${stored.email ?? '(unknown email)'}. Run \`sheets auth logout\` first to switch accounts.\n`);
      return 0;
    }
    // --client <path>: point directly at the downloaded OAuth client JSON —
    // no need to know the config directory.
    const clientFlagIdx = argv.findIndex((a) => a === '--client');
    const clientFile = clientFlagIdx !== -1 ? argv[clientFlagIdx + 1] : undefined;
    const result = await loginFlow({
      forceConsent: argv.includes('--force-consent') || argv.includes('--force'),
      clientFile,
    });
    process.stdout.write(`Logged in as ${result.email || '(email unavailable)'}.\nTokens stored at ${result.tokenFile}\nYou can now create spreadsheets as yourself: sheets create_spreadsheet name="My sheet"\n`);
    return 0;
  }
  if (sub === 'status') {
    const { authStatus } = await import('../lib/google.js');
    const s = authStatus();
    process.stdout.write(`auth mode: ${s.mode}\n${s.detail}\n`);
    return 0;
  }
  if (sub === 'logout') {
    const { clearStoredTokens } = await import('../lib/oauth.js');
    if (clearStoredTokens()) {
      process.stdout.write('Logged out — stored OAuth tokens deleted.\n');
    } else {
      process.stdout.write('No stored OAuth tokens found (service-account env credentials, if any, are unaffected).\n');
    }
    return 0;
  }
  process.stderr.write('Usage: sheets auth login | sheets auth status | sheets auth logout\n');
  return 1;
}

/**
 * Lazy Svc: credential errors should surface only for ops that actually touch
 * Google APIs, not for offline ops like resolve_target or list.
 */
function lazySvc(): Svc {
  let real: Svc | null = null;
  return new Proxy({} as Svc, {
    get(_t, prop: string) {
      if (!real) real = getGoogleServices();
      return Reflect.get(real as object, prop);
    },
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`sheets: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });