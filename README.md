# sheetcraft-mcp

Google Sheets MCP server + CLI for AI agents — **one shared core, two surfaces**.

Built to be **reliable** and **token-efficient** where other Sheets MCPs aren't:

- **Teaching errors** — a bad range or sheet name returns `INVALID_ARGUMENT` with an example, the list of available sheets, and how to fix it. Models self-correct instead of thrashing.
- **Token-efficient reads** — `get_values` defaults to CSV (~3-5× denser than JSON grids), offers `records` (header-joined objects) and `grid`, hard-caps every read at 5,000 cells (configurable), and truncates with an explicit notice telling the model how to get the rest.
- **Write echoes** — every write returns `updatedRange` / `updatedCells` so the agent closes its own loop without a verification read.
- **Retry + backoff built in** — 429/5xx/network errors retry with truncated exponential backoff + jitter before surfacing; the message says so.
- **Safe defaults** — `append_rows` uses `INSERT_ROWS` (never overwrites), `USER_ENTERED` parsing by default, destructive tools annotated truthfully.
- **32 tools in 6 opt-in toolsets** — register only what you need (`SHEETS_TOOLSETS=core` ≈ 4K tokens, all 32 ≈ 9.4K).
- **Auth two ways** — OAuth as yourself (can create spreadsheets) or a service account (edit-only on shared files). One `sheets auth login`, tokens persist and auto-refresh.
- **MCP server AND CLI** — same core: MCP for chat agents (Claude Desktop, OpenCode, any MCP client), CLI for scripting, piping, and bulk work.

## Install

```bash
# Run directly with npx (no install)
npx sheetcraft-mcp@latest auth login
npx sheetcraft-mcp@latest auth status

# or install globally — then the commands are `sheets` and `sheets-mcp`
npm install -g sheetcraft-mcp
sheets auth login
```

Requires Node ≥ 20. The package installs two commands: **`sheets`** (CLI) and
**`sheets-mcp`** (MCP server). `npx sheetcraft-mcp <args>` also works and behaves like
`sheets`.

## Authentication

### Option A: OAuth — act as yourself (recommended; can create spreadsheets)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → enable **Google Sheets API** + **Google Drive API** → **Create Credentials → OAuth client ID → Desktop app** → download the JSON.
2. Save it as `~/.config/sheetcraft-mcp/oauth-client.json` (or set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`).
3. Log in once:

```bash
npx sheetcraft-mcp@latest auth login     # browser opens, consent, done
npx sheetcraft-mcp@latest auth status
```

Tokens persist at `~/.config/sheetcraft-mcp/oauth-tokens.json` (0600) and auto-refresh. Your spreadsheets, your ownership — `create_spreadsheet` works.

> Unverified-app warning screen during consent is expected for your own test app: **Advanced → Go to app → Allow**. Add your Google account as a **Test user** on the OAuth consent screen first.

### Option B: Service account — edit-only on shared files

1. Create a service account + JSON key in Cloud Console, enable Sheets API.
2. Point the server at the key:

```bash
export GOOGLE_SERVICE_ACCOUNT_CREDENTIALS="$(cat service-account.json)"
# or: export GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json
```

3. **Share spreadsheets with the SA's email** (like any collaborator) — it can read/edit but **cannot create** files (Google gives service accounts a 0-byte storage quota; use OAuth for that).

### Auth resolution

`SHEETS_AUTH_MODE=oauth|service-account` forces a mode; otherwise SA env credentials win, then stored OAuth tokens.

## Use with OpenCode

```jsonc
// opencode.json
{
  "mcp": {
    "sheets": {
      "type": "local",
      "command": ["npx", "-y", "sheetcraft-mcp@latest"],
      "environment": {
        "SHEETS_TOOLSETS": "core,drive"
      },
      "enabled": true
    }
  }
}
```

Tools appear as `sheets_get_values`, `sheets_update_values`, etc. OAuth login done via the CLI is picked up automatically (same token store).

Gate destructive tools in agent config:

```jsonc
{ "tools": { "sheets_delete_sheet": "ask", "sheets_batch_update": "ask", "sheets_trash_spreadsheet": "ask" } }
```

## Use with Claude Desktop / any MCP client

```json
{
  "mcpServers": {
    "sheets": {
      "command": "npx",
      "args": ["-y", "sheetcraft-mcp@latest"],
      "env": { "SHEETS_TOOLSETS": "core,drive,formatting,charts" }
    }
  }
}
```

## The CLI

```bash
npx sheetcraft-mcp@latest list                        # all 32 ops by toolset
npx sheetcraft-mcp@latest help get_values             # one op's parameters
npx sheetcraft-mcp@latest resolve_target url="https://docs.google.com/spreadsheets/d/…/edit"
npx sheetcraft-mcp@latest get_values spreadsheetId=<id> range="'My Sheet'!A1:D10"
npx sheetcraft-mcp@latest get_values spreadsheetId=<id> range="'My Sheet'!A1:D10" format=records
npx sheetcraft-mcp@latest append_rows spreadsheetId=<id> sheet=Data --stdin-json < rows.json
```

Same core, same auth, same errors — exit code 1 with a teaching message on failure.

### Agent skill for the CLI

If your agent supports skills (OpenCode, Claude Code), install the bundled one — it teaches
the CLI conventions (quoting, stdin JSON, exit codes, pitfalls) without trial and error:

```bash
# OpenCode / Claude Code: copy or symlink into your skills directory
ln -s "$(npm root -g)/sheetcraft-mcp/skills/managing-google-sheets" ~/.config/opencode/skills/managing-google-sheets
```

The skill ships inside the npm package (`skills/managing-google-sheets/SKILL.md`) — point
your skill loader at the installed package path.

## Tool catalog (32 tools, 6 toolsets)

| Toolset | Tools |
|---|---|
| **core** (13) | `get_values` · `batch_get_values` · `update_values` · `batch_update_values` · `append_rows` · `clear_values` · `get_spreadsheet_info` · `add_sheet` · `delete_sheet` · `duplicate_sheet` · `rename_sheet` · `insert_delete_dimensions` · `find_replace` |
| **drive** (7) | `create_spreadsheet` · `copy_spreadsheet` · `find_spreadsheets` · `share_spreadsheet` · `trash_spreadsheet` · `export_spreadsheet` · `resolve_target` |
| **formatting** (5) | `format_cells` · `merge_cells` · `freeze_rows_columns` · `conditional_format` · `get_formatting` (run-length-encoded, very compact) |
| **charts** (3) | `create_chart` · `update_chart` · `delete_chart` |
| **pivot** (2) | `create_pivot` · `delete_pivot` |
| **power** (2) | `batch_update` (raw escape hatch for all ~70 batchUpdate request types) · `sort_range` |

Select with `SHEETS_TOOLSETS=core` (default) / `all` / comma list. Unknown names hard-fail at startup.

## Design notes for agent reliability

- **ID-first**: every op takes `spreadsheetId` (accepts a full URL — parsed). Sheet params accept `'Name'` or `gid:N`.
- **A1 errors teach**: `Sheet "Data 2" not found. Sheets: "Sheet1"(gid:0), "Data"(gid:7). Quote names with spaces: 'My Sheet'!A1:B2.`
- **Reads capped**: `SHEETS_MAX_CELLS` (default 5000) + truncation notice with next steps.
- **Batching encouraged**: `batch_update_values` / `batch_update` = one API call per Google's quota.
- **Cell contents are data, not instructions**: content is never echoed into error messages or prompts.

## Environment reference

| Var | Purpose |
|---|---|
| `SHEETS_TOOLSETS` | `core` (default), `drive`, `formatting`, `charts`, `pivot`, `power`, `all`, or comma list |
| `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` / `_FILE` | SA key JSON (raw) / path |
| `SHEETS_AUTH_MODE` | Force `oauth` or `service-account` |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Alternative to oauth-client.json |
| `GOOGLE_OAUTH_TOKEN_FILE` / `SHEETS_OAUTH_CLIENT_FILE` | Custom token/client paths |
| `SHEETS_MAX_CELLS` | Read cap per call (default 5000, hard max 50000) |
| `SHEETS_RETRY_ATTEMPTS` / `_BASE_MS` / `_MAX_MS` | Retry tuning (default 3, 300ms, 8s) |

## Known limitations

- **Pivot tables via the API are unreliable** — Google's API accepts the write but silently drops the definition (verified 2026-08-28 against Google's own documented request shape). `create_pivot` verifies persistence and warns honestly; for summaries, prefer `get_values` + `update_values`.
- **Service accounts cannot create files** (Google policy, 0-byte quota) — use OAuth mode for `create_spreadsheet`/`copy_spreadsheet`.
- **Drive CSV export is first-sheet-only** — use `get_values` for per-sheet CSV.

## License

MIT — see [LICENSE](LICENSE).