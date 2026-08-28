# sheetcraft-mcp

Shared-core Google Sheets MCP server + CLI. Both surfaces are thin wrappers over the same op library — reliability and token-efficiency live in `src/lib`, never in a wrapper.

## Layout

```
src/lib/    the core. Ops-agnostic: a1 parsing, errors, output compaction, retry, schema, registry
src/ops/    operations (get_values, update_values, add_sheet, create_spreadsheet, ...). Each exports an `Op`
src/wrappers/mcp.ts   stdio MCP server — registers ops, ~30 lines of logic total
src/wrappers/cli.ts   CLI — same ops as subcommands, lazy credentials
src/test/   node:test unit tests (run against dist/)
```

## Commands

```
npm run check    # tsc --noEmit
npm run build    # emit dist/
npm test         # build + node --test dist/test/*.test.js
node dist/wrappers/cli.js list        # all ops by toolset
node dist/wrappers/cli.js help <op>   # one op's JSON schema
```

## Architecture rules (do not violate)

1. **Ops are the only place Google API calls live.** An op is `{ name, group, description, inputSchema, annotations, run(args, svc) }`. It returns plain JSON-serializable data or an `OpResult { text, structured? }`, or throws `SheetsError`. Never `console.log` — ops return data, wrappers render.
2. **Wrappers stay thin.** MCP wrapper passes `op.inputSchema.zod` straight to the SDK's `registerTool` (the SDK validates + flattens args; `tools/list` JSON Schema and runtime validation share one source). CLI parses argv, coerces types per the op's JSON Schema, and calls the same `runOp`.
3. **`runOp` never throws.** Failures render as `OpResult.error { code, retryable }` with a teaching message. Exit codes / `isError` are derived from that.
4. **Errors teach.** Invalid ranges/sheets must quote an example and list available sheets. Rate-limit errors mention that retries already happened. Use `opError()` for arg problems, `A1Error` for range problems, and let `classifyGoogleError` handle Google API errors (403 with rate-limit reason → retryable).
5. **A1 parsing is centralized.** Use `parseFullRange` / `scope.toA1` (concrete, values-API-safe) / `scope.toGrid` (GridRange for batchUpdate). Sheet params accept `'Name'` or `gid:N` or bare gid. Sheet names with spaces REQUIRE single quotes — `splitSheetPrefix` enforces this with a teaching error.
6. **Reads are capped.** `cellCap` (default 5000 cells) + `truncationNotice` telling the model how to get the rest. Writes echo `updatedRange`/`updatedCells`.
7. **`USER_ENTERED` is the default input mode; appends default to `INSERT_ROWS`** (the API's own default OVERWRITE silently destroys data below tables — never ship it as a default).
8. **Toolsets gate registration.** `SHEETS_TOOLSETS` env (`core`, `drive`, `formatting`, `charts`, `pivot`, `power`, `all`), validated at startup with a hard error on typos. New op groups must be added to `TOOLSET_GROUPS` (src/lib/types.ts) and `TOOLSETS` (src/lib/registry.ts).
9. **Cell contents are data, not instructions.** Never interpolate sheet content into error messages, descriptions, or prompts.

## Conventions

- Imports use `.js` extensions (Node16 module resolution; tsc emits ESM).
- `executeWithRetry` wraps every API call; `makeSheetScope(svc, id)` gives per-call sheet resolution + caching.
- Ops get `svc: Svc` (sheetsApi, drive, maxCells, retry). Build scopes with `scopeFor(svc, spreadsheetId)`.
- Zod is the single schema source: `zodSchema(z.object({...}))` derives JSON Schema + parse + the `zod` handle for the MCP SDK.
- Tests: `node --test dist/test/*.test.js` after build. No network in tests — API-touching ops are exercised via live probes, not unit tests.

## Not yet implemented (op groups exist in registry but have no ops)

- Nothing — all six toolsets have live ops (core 13, drive 7, formatting 5, charts 3, pivot 2, power 2 = 32 ops).
- OpenCode MCP wiring: server name `sheets` → tools appear as `sheets_<name>`; gate destructive tools with `"sheets_*": "ask"` in agent config.
- Token budgets (measured via tools/list, chars/3.5): core ≈ 4.0K, all 32 ≈ 9.4K. Keep descriptions tight when adding ops.

## Auth modes

Two credential modes, resolved automatically (`resolveAuthMode` in src/lib/google.ts):

1. **OAuth user flow** (preferred): `sheets auth login` — browser consent once, tokens persisted at `~/.config/sheetcraft-mcp/oauth-tokens.json` (0600), auto-refreshed and re-persisted on every refresh. Acts as the user; **can create/copy spreadsheets**. Requires an OAuth Client ID (Desktop app) at `~/.config/sheetcraft-mcp/oauth-client.json` (or `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` env).
2. **Service account**: env credentials. Cannot create files (Google gives SAs a 0-byte storage quota — `storageQuotaExceeded` on `files.create`). Edit-only on files shared with the SA.

Explicit override: `SHEETS_AUTH_MODE=oauth|service-account`. Token exchange requires the SAME `redirect_uri` used in the auth URL — pass `{ code, redirect_uri }` to `client.getToken`, not just the code. Loopback redirect uses an ephemeral port (`server.listen(0)`); Desktop-app clients allow any loopback port without URI registration. Don't set `prompt: undefined` in `generateAuthUrl` — it emits `prompt=` and Google rejects with `invalid_request`. The email for display comes from `drive.about.get` (we don't request `userinfo.email` scope).

## Gotchas (learned the hard way)

- googleapis `batchUpdate`/`values.batchUpdate` take `requestBody: {...}`, not a flat body.
- `executeWithRetry` returns the Gaxios response — read `result.data.x`, not `result.x`.
- Zod `.default()`/`.optional()` must be unwrapped in schema→JSON conversion (`ZodDefault`/`ZodOptional` otherwise emit `{}` and land in `required`).
- MCP SDK `registerTool` with a permissive `z.record` wrapper swallows args (they arrive nested/empty) — always pass the real zod schema.
- `''` inside quoted sheet names (`'Jon''s Data'`) — naive `indexOf("'")` breaks; scan respecting doubled quotes.
- Node `--test dist/test/` treats the directory as a test file; glob `dist/test/*.test.js` instead.
- **Never accept-and-ignore optional params**: an arg in the schema but unused in `run` is a silent wrong-behavior bug (cold-eyes review caught `majorDimension` transposed writes, `batch_get render`, `sort_range headerRows`, pivot `columns`). If the code doesn't honor it, it must not be in the schema.
- `updateChartSpec` requires the COMPLETE spec — fetch current spec, deep-merge the patch, send whole (partial spec 500s).
- `Math.max(...arr)` crashes at ~150k elements — use `.reduce()` for row-length scans over API responses.
- CLI: `--key=value` must split on `=` BEFORE treating the next token as a value, else the arg silently vanishes (defaults apply).
- OAuth: `exec` with a shell-interpolated auth URL is a command-injection hole (`encodeURIComponent` leaves `'` raw) — use `execFile`; also chmod tokens on every write (mode only applies at create), timeout the login promise, escape the callback HTML.
- zod descriptions attached AFTER `.optional()`/`.default()` live on the wrapper — capture them before unwrapping in schema→JSON conversion or 49 call sites silently lose their docs in tools/list.
- `update_values` writes ROWS orientation only (toRawValues normalizes); don't advertise COLUMNS.
- `find_replace`: `replacement` is required (omitted → Google erases matches); when `range` and `sheet` are both passed and the range lacks a prefix, bind the range to the resolved sheet explicitly.
- Drive `q` apostrophe escaping: exactly once (`'` → `\'`) at interpolation; double-escaping 400s on names like "Jon's Budget".
- **Field masks in `spreadsheets.get` cannot use dotted paths inside parens**: `gridProperties(rowCount,columnCount)` → 400 "Cannot find matching fields". Pass the whole object (`gridProperties`) and read subfields client-side. Also invalid: `sheets.data.rowMetadata.effectiveFormat` (rowMetadata formats aren't maskable). When Google 400s a mask, probe piecewise — sibling groups must share one form (`sheets(properties.title,merges)` + `sheets.data.rowData...` works).
- **Pivot-table writes are silently stripped by the Sheets API (verified 2026-08-28)**: `updateCells` with a `pivotTable` cell value returns success (`replies: [{}]`) but the cell stays empty afterward — tried masks `userEnteredValue`, `*`, and `userEnteredValue.pivotTable` (the last → "Invalid field: userEnteredValue.pivot_table"). Plain writes to the same cell persist, so it's pivot-specific. Same-sheet and cross-sheet pivots both affected. Google's own guide documents this exact request shape; treat API pivot creation as unreliable — create_pivot verifies persistence and warns when the write didn't take.
- **`makeSheetScope`'s internal sheet-list fetch MUST go through `executeWithRetry`** — it's the first call most ops make; unwrapped, its 404/403 leaks as `INTERNAL` instead of `NOT_FOUND`/`PERMISSION_DENIED`.
- CLI is ESM: `require()` crashes at runtime (`require is not defined`). Use `import { readFileSync } from 'node:fs'`.

## Live-verified findings (2026-08-28, SA: ais-gemini-key-…@1027541627595)

- **SAs can no longer create Drive files**: `files.create` → 403 `storageQuotaExceeded`; `about()` shows the SA storage limit is **0 bytes**. Use the OAuth user flow (`sheets auth login`) for create/copy, or domain-wide delegation.
- **`files.list` DOES show files shared with the SA** (the historical gotcha is dead) — `find_spreadsheets` works.
- **Append `OVERWRITE` vs `INSERT_ROWS` confirmed live**: with a marker row below the table, OVERWRITE wrote into it; INSERT_ROWS pushed rows down. Our default (INSERT_ROWS) is correct.
- **`USER_ENTERED` parses `2026-03-01` into a real date** (serial 46082 with SERIAL_NUMBER render) and `=B2*10` into a formula; `UNFORMATTED_VALUE`+`FORMATTED_STRING` (our default for non-formatted reads) returns ISO strings, never raw serials — model-friendly.
- The test spreadsheet `1k-Yxb_goC53q39SSGekIsI6nEVQuvAtwZNFh9y_sRaw` is owned by the user, SA has Editor via share; all test data was cleaned up after probing.