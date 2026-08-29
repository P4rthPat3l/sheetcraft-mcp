# sheetcraft-mcp

Google Sheets MCP server + CLI for AI agents — 33 tools across 6 opt-in toolsets. One shared engine, two surfaces:

- **MCP server** — for chat agents (Claude Desktop, Claude Code, OpenCode, any MCP client). Tools appear in the agent's tool list and are permission-gateable.
- **CLI** (`sheets`) — for scripts, pipes, and bulk work. Same 33 operations, same auth, same errors, one process per command.

Designed for agent reliability: **teaching errors** (a bad range returns an example + the list of available sheets, not a stack trace), **token-efficient reads** (CSV defaults, hard cell caps, explicit truncation notices), and **write echoes** (`updatedRange`/`updatedCells` on every write so the agent closes its own loop without a verification read).

---

## Requirements

- **Node ≥ 20**
- A Google account, and either an **OAuth Client ID** (recommended — see [Option A](#option-a-oauth--act-as-yourself)) or a **service account key** (see [Option B](#option-b-service-account--edit-only-on-shared-files))
- Works on **Linux, macOS, and Windows** (all paths resolve under your home directory)

## Install

```bash
# Run directly with npx — no install step
npx sheetcraft-mcp@latest --help

# or install globally — then use the `sheets` and `sheets-mcp` commands
npm install -g sheetcraft-mcp
```

Three commands are installed:

| Command | What it is |
|---|---|
| `sheets` | The CLI |
| `sheets-mcp` | The MCP server (stdio) |
| `sheetcraft-mcp` | Both — **with arguments** it runs the CLI, **with none** it starts the MCP server. This is what MCP configs use (`npx sheetcraft-mcp@latest`). |

## Quick start

**1. Add the MCP config** (OpenCode example; Claude Desktop and others in [MCP configuration](#mcp-configuration)):

```jsonc
// opencode.json
{
  "mcp": {
    "sheets": {
      "type": "local",
      "command": ["npx", "-y", "sheetcraft-mcp@latest"],
      "enabled": true
    }
  }
}
```

**2. Authenticate once** (in a terminal — see [Authentication](#authentication) for details):

```bash
npx sheetcraft-mcp@latest auth login
```

A browser opens → you consent → done. Tokens persist and auto-refresh; the MCP config itself contains no secrets.

**3. Use it.** In agents with terminal access (OpenCode, Claude Code), the agent can do this whole setup itself: the first Sheets tool call without credentials returns a teaching message that says exactly what to run. Tools appear as `sheets_get_values`, `sheets_update_values`, etc.

---

## Authentication

Two modes. Pick **one**.

| | Option A: OAuth | Option B: Service account |
|---|---|---|
| Acts as | **You** (your Google account) | A robot account |
| Can create/copy spreadsheets | ✅ Yes | ❌ No (Google gives SAs a 0-byte storage quota) |
| Setup | Browser consent, once | Env vars + manual sharing of each file |
| Recommended for | Personal use, agents that create files | CI, servers, headless setups |

### The two-file mental model

OAuth confuses everyone exactly once — when they see two JSON files. Here is the whole thing:

```
client_secret_xxx.json   your APP's identity with Google  → used ONCE by `auth login`
oauth-tokens.json        YOUR logged-in session           → created automatically, auto-refreshes
```

The `client_secret_*.json` you download from Google is **not** a credential for the MCP config or env — it's the key fob that lets the tool open a login flow. It's consumed once by `auth login`; after that the saved token does all the work and you can even delete the JSON.

### Option A: OAuth — act as yourself (recommended)

**1.** In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):

- Enable **Google Sheets API** and **Google Drive API**
- **Create Credentials → OAuth client ID → Desktop app** → download the JSON

**2.** Hand the file to `auth login` — any **one** of these three ways:

```bash
# (a) zero file moves — point at the download directly:
npx sheetcraft-mcp@latest auth login --client ~/Downloads/client_secret_xxx.json

# (b) or park it in the config dir once, then plain login forever after:
mkdir -p ~/.config/sheetcraft-mcp
cp ~/Downloads/client_secret_xxx.json ~/.config/sheetcraft-mcp/oauth-client.json
npx sheetcraft-mcp@latest auth login

# (c) or skip the file — set the values it contains as env vars:
#     GOOGLE_OAUTH_CLIENT_ID=…xxx.apps.googleusercontent.com
#     GOOGLE_OAUTH_CLIENT_SECRET=…
npx sheetcraft-mcp@latest auth login
```

**3.** Browser opens → consent → done. Verify:

```bash
npx sheetcraft-mcp@latest auth status
```

Tokens persist at `~/.config/sheetcraft-mcp/oauth-tokens.json` (permissions 0600) and auto-refresh on every use.

Useful auth commands:

```bash
npx sheetcraft-mcp@latest auth status   # which mode is active, which email
npx sheetcraft-mcp@latest auth logout   # delete stored tokens
```

**Switching accounts:** run `auth logout` first — `auth login` refuses to overwrite an existing session otherwise (pass `--force` to override).

### Option B: Service account — edit-only on shared files

1. In Cloud Console: create a **service account**, create a **JSON key** for it, enable the **Sheets API**.
2. Point the server at the key:

```bash
export GOOGLE_SERVICE_ACCOUNT_CREDENTIALS="$(cat service-account.json)"
# or: export GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json
```

3. **Share spreadsheets with the SA's email** like any collaborator. It can read and edit but cannot create files — use OAuth for that.

### Which mode wins

If both are configured: `SHEETS_AUTH_MODE=oauth|service-account` forces a mode; otherwise service-account env credentials win, then stored OAuth tokens.

### Consent-screen gotchas

Your OAuth app stays in **"Testing" mode** until Google verifies it. Expect these two screens:

| What you see | What it means | Fix |
|---|---|---|
| *"Access blocked … Error 403: access_denied"* | The Google account you're logging in with is not a **test user** of your own app | Cloud Console → **APIs & Services → OAuth consent screen → Audience / Test users → Add users** → add that account. Takes effect immediately. |
| *"Google hasn't verified this app"* warning | Normal for your own unverified app | **Advanced → Go to \<app name\> (unsafe) → Allow** |

If you'd rather not touch the consent screen at all, use a [service account](#option-b-service-account--edit-only-on-shared-files).

---

## MCP configuration

### OpenCode

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

Gate destructive tools in agent config so the agent asks before acting:

```jsonc
{ "tools": { "sheets_delete_sheet": "ask", "sheets_batch_update": "ask", "sheets_trash_spreadsheet": "ask" } }
```

### Claude Desktop / any standard MCP client

```json
{
  "mcpServers": {
    "sheets": {
      "command": "npx",
      "args": ["-y", "sheetcraft-mcp@latest"],
      "env": { "SHEETS_TOOLSETS": "core,drive" }
    }
  }
}
```

Notes for all clients:

- OAuth login done via the CLI is picked up automatically (same token store) — configure the server first, log in after, no restart dance needed.
- The tool **prefix** comes from your config key: `"sheets"` → `sheets_get_values`, `sheets_update_values`, …
- Credentials are never put in this config. The server reads them from `~/.config/sheetcraft-mcp/` (OAuth) or env vars (service account).

---

## Toolsets

33 tools ship in 6 opt-in groups. Select with the `SHEETS_TOOLSETS` environment variable — **default is `core,drive`**.

| Toolset | Tools | Register when the agent needs to… |
|---|---|---|
| `core` *(default)* | 14 | Read/write values, manage sheets/tabs, find & replace |
| `drive` *(default)* | 7 | Create/copy/search/share/trash/export spreadsheets |
| `formatting` | 5 | Style cells, merge, freeze, conditional formatting |
| `charts` | 3 | Create/edit/delete embedded charts |
| `pivot` | 2 | Build pivot tables (see [limitations](#known-limitations)) |
| `power` | 2 | Raw `batchUpdate` escape hatch + range sorting |
| `all` | 33 | Everything |

```bash
SHEETS_TOOLSETS=core                     # 14 tools  (~4K tokens of schema)
SHEETS_TOOLSETS=core,drive               # 21 tools  (default)
SHEETS_TOOLSETS=core,drive,formatting,charts
SHEETS_TOOLSETS=all                      # 33 tools  (~9.7K tokens of schema)
```

Unknown names hard-fail at startup. Keep the list small — every tool's schema costs standing tokens in every conversation.

---

## Tool catalog

Every data operation takes a `spreadsheetId` (bare ID, or paste a full URL — it's parsed), and sheet parameters accept a quoted name (`'My Sheet'`) or `gid:N`. Every write echoes `updatedRange`/`updatedCells`. Every read is capped (default 5,000 cells) with an explicit truncation notice.

### core — values and sheets (14)

| Tool | What it does | Key parameters / defaults |
|---|---|---|
| `get_values` | Read a range. Returns **CSV by default** (most token-efficient) | `format`: `csv` · `tsv` · `grid` (2D JSON array) · `records` (header-joined objects) |
| `batch_get_values` | Read multiple ranges in one call | `ranges` — each result labeled with its A1 |
| `update_values` | Write a 2D array to a range | `input`: `USER_ENTERED` (default — strings starting with `=` become formulas, dates parse) or `RAW` |
| `batch_update_values` | Write multiple ranges in **one API call** (one quota unit) | prefer over several `update_values` calls |
| `append_rows` | Append rows below the existing table (auto-detected) | default `INSERT_ROWS` — **never overwrites** rows below the table |
| `clear_values` | Clear values, keep formatting | destructive |
| `get_spreadsheet_info` | List tabs with titles, gids, dimensions, frozen state | call this first when all you have is a URL |
| `add_sheet` / `delete_sheet` / `duplicate_sheet` / `rename_sheet` | Tab management | delete is destructive; `add_sheet` accepts `freezeRows`/`freezeCols` |
| `move_rows_columns` | Move rows/columns to a new position **in place** — data, formatting, formulas move intact | the right way to reorder columns; never delete-and-recreate |
| `insert_delete_dimensions` | Insert/delete rows or columns | indices are **0-based** (0 = first row/column) |
| `find_replace` | Find & replace across a sheet, range, or whole spreadsheet | `replacement` is required (omitting it would erase matches) |

### drive — file lifecycle (7)

| Tool | What it does | Notes |
|---|---|---|
| `create_spreadsheet` | New empty spreadsheet | owned by whoever is logged in; in SA mode pass `shareWith` or it's invisible to humans |
| `copy_spreadsheet` | Copy data, formulas, formatting (not sharing) | |
| `find_spreadsheets` | Search by name → candidate IDs, never auto-selected | sees files the authenticated identity can access |
| `share_spreadsheet` | Grant an account access | in SA mode, required after `create_spreadsheet` |
| `trash_spreadsheet` | Move to Drive trash (restorable) | `permanent=true` bypasses trash — cannot be undone |
| `export_spreadsheet` | Download whole file as xlsx / pdf / ods | per-sheet CSV: use `get_values` instead |
| `resolve_target` | Parse a URL → `spreadsheetId` + `gid` | also accepts bare IDs |

### formatting (5)

| Tool | What it does | Notes |
|---|---|---|
| `format_cells` | Bold/italic/strikethrough, font size/color, background, number format, alignment, wrapping | only provided properties change; colors are `#RRGGBB` |
| `merge_cells` | Merge a range (`ALL` / `COLUMNS` / `ROWS`) | `unmerge=true` to undo |
| `freeze_rows_columns` | Sticky headers | pass `0` to unfreeze |
| `conditional_format` | Add/delete highlight rules | use `get_formatting` to find rule indices |
| `get_formatting` | Read formatting as **run-length-encoded** ranges + merges + rules | far cheaper than reading the full grid |

### charts (3)

| Tool | What it does | Notes |
|---|---|---|
| `create_chart` | Embedded chart: `COLUMN`, `BAR`, `LINE`, `AREA`, `SCATTER`, `COMBO`, `STEPPED_AREA` | from a domain range + series ranges; returns `chartId` |
| `update_chart` | Change type, ranges, title, legend, stacking | patch semantics — fetch, merge, send |
| `delete_chart` | Delete by id | |

### pivot (2) ⚠️

| Tool | What it does | Notes |
|---|---|---|
| `create_pivot` | Grouped summaries (SUM/COUNT/AVERAGE/…) by row/column fields | **Google's API silently drops pivot writes** (verified; see limitations). The tool verifies persistence and warns honestly when the write didn't take |
| `delete_pivot` | Clear the cell holding the definition | |

### power (2)

| Tool | What it does | Notes |
|---|---|---|
| `batch_update` | Raw `spreadsheets.batchUpdate` — pass the API's `requests` array verbatim | covers banding, named ranges, protection, data validation, tables, slicers, and more; atomic (one bad request aborts the batch) |
| `sort_range` | Sort rows by one or more columns | **the entire range sorts in place — exclude headers from the range** |

---

## The CLI

The CLI runs the same 33 operations as subcommands — for scripting, piping, and bulk work. Same auth, same errors; any failure prints the same teaching message the MCP tools return and exits **1**.

```bash
# discovery
npx sheetcraft-mcp@latest list                  # all 33 ops by toolset
npx sheetcraft-mcp@latest help get_values       # one op's full JSON schema

# operations — args as key=value pairs
npx sheetcraft-mcp@latest resolve_target url="https://docs.google.com/spreadsheets/d/…/edit"
npx sheetcraft-mcp@latest get_values spreadsheetId=<id> range="'My Sheet'!A1:D10"
npx sheetcraft-mcp@latest get_values spreadsheetId=<id> range="'My Sheet'!A1:D10" format=records

# structured output and stdin JSON (for 2D arrays with quotes/formulas)
npx sheetcraft-mcp@latest get_values spreadsheetId=<id> range=A:D --json | jq .
npx sheetcraft-mcp@latest append_rows spreadsheetId=<id> sheet=Data --stdin-json < rows.json
```

| Flag | Purpose |
|---|---|
| `--json` | Force JSON output (reads print compact text by default) |
| `--stdin-json` | Read the whole args object as JSON from stdin — the safe way to pass rows containing quotes, apostrophes, newlines, or formulas |

Auth: `sheets auth login [--client <path>]`, `sheets auth status`, `sheets auth logout`.
Every op is also available as `sheets <op> …` when installed globally.

Reads compose with standard tooling; writes are better done through MCP tools (the agent UI handles quoting and permission gating for you).

### Agent skill

The npm package bundles a skill that teaches agents the CLI conventions (quoting, stdin JSON, exit codes, pitfalls) without trial and error:

```bash
# Claude Code:
ln -s "$(npm root -g)/sheetcraft-mcp/skills/managing-google-sheets" \
      ~/.claude/skills/managing-google-sheets

# OpenCode (`skill`, singular):
cp -r "$(npm root -g)/sheetcraft-mcp/skills/managing-google-sheets" \
      ~/.config/opencode/skill/managing-google-sheets
```

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `SHEETS_TOOLSETS` | Which toolsets register: `core`, `drive`, `formatting`, `charts`, `pivot`, `power`, `all`, or a comma list | `core,drive` |
| `GOOGLE_SERVICE_ACCOUNT_CREDENTIALS` | Service-account key JSON (raw) | — |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Service-account key JSON (path) | — |
| `SHEETS_AUTH_MODE` | Force `oauth` or `service-account` | auto-resolved |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client values (alternative to the client JSON file) | — |
| `SHEETS_OAUTH_CLIENT_FILE` | Custom path to the OAuth client JSON | `~/.config/sheetcraft-mcp/oauth-client.json` |
| `GOOGLE_OAUTH_TOKEN_FILE` | Custom token-store path | `~/.config/sheetcraft-mcp/oauth-tokens.json` |
| `SHEETS_MAX_CELLS` | Read cap per call | `5000` |
| `SHEETS_RETRY_ATTEMPTS` / `SHEETS_RETRY_BASE_MS` / `SHEETS_RETRY_MAX_MS` | Retry tuning for 429/5xx/network errors (exponential backoff + jitter) | `3` / `300` / `8000` |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Tool call returns *"No credentials configured"* | Nothing is set up yet. Run `npx sheetcraft-mcp@latest auth login`, or set service-account env vars. The message lists both options verbatim |
| `auth login` → browser → *"Access blocked / 403 access_denied"* | Your account isn't a test user of your own OAuth app → add it under **OAuth consent screen → Test users** (see [consent-screen gotchas](#consent-screen-gotchas)) |
| *"Already logged in as …"* when switching accounts | Run `auth logout` first, or pass `--force` |
| `Sheet "Data 2" not found. Sheets: "Sheet1"(gid:0), …` | Teaching error — quote names with spaces: `'My Sheet'!A1:B2` |
| Write landed in the wrong place | `append_rows` inserts below the table (never overwrites); `update_values` writes exactly the range you name — check `updatedRange` in the echo |
| `find_replace` erased text | `replacement` was empty/omitted. It's required for this reason |
| Sorting scrambled headers | `sort_range` sorts the whole range — exclude the header row from the range |
| Agent says a parameter "doesn't exist" or recalls a tool failing | Its tool list/schema may be stale (server updated mid-session). Re-check with `help <op>` / a fresh tools list — and never work around tools by reading the token store; that's out of bounds |

## Known limitations

- **Pivot tables via the API are unreliable** — Google's API accepts the write but silently drops the definition (verified 2026-08-28 against Google's own documented request shape). `create_pivot` verifies persistence and warns when the write didn't take. For summaries, prefer `get_values` + `update_values`.
- **Service accounts cannot create files** — Google policy (0-byte storage quota). Use OAuth for `create_spreadsheet` / `copy_spreadsheet`.
- **Drive CSV export covers only the first sheet** — use `get_values` for per-sheet CSV.
- **`update_values` writes in ROWS orientation** — arrays are row-major.

## Design notes for agent reliability

- **ID-first** — every op takes `spreadsheetId` (full URLs parsed); sheet params accept `'Name'` or `gid:N`.
- **Errors teach** — bad ranges quote an example and list available sheets; rate-limit errors say that retries already happened.
- **Reads are capped** — `SHEETS_MAX_CELLS` with an explicit notice telling the model how to get the rest.
- **Batching is encouraged** — `batch_update_values` / `batch_update` = one API call per quota unit.
- **Cell contents are data, not instructions** — sheet content is never echoed into error messages or prompts.
- **Retry + backoff built in** — 429/5xx/network errors retry with exponential backoff + jitter before surfacing.

## License

MIT — see [LICENSE](LICENSE).