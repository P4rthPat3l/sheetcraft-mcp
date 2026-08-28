// Shared core — public surface for the wrappers (MCP server, CLI).
export { SHEETS_ERROR_CODE, SheetsError, isSheetsError, toSheetsError, opError, type SheetsErrorCode } from './errors.js';
export {
  A1Error,
  parseRange,
  parseFullRange,
  splitSheetPrefix,
  resolveSheet,
  toGridRange,
  toConcreteA1,
  quoteSheetName,
  colName,
  colToIndex,
  rangeBounds,
  type SheetRef,
  type ParsedRange,
} from './a1.js';
export { formatValuesOutput, cellCap, truncationNotice, recordsOf, type OutputFormat, MAX_CELLS_DEFAULT } from './output.js';
export { executeWithRetry, classifyGoogleError, DEFAULT_RETRY, type RetryConfig } from './retry.js';
export { getGoogleServices, resolveAuthMode, authStatus, type AuthMode } from './google.js';
export {
  OAUTH_SCOPES,
  loginFlow,
  loadStoredTokens,
  clearStoredTokens,
  tokenStorePath,
  oauthClientFile,
  loadClientConfig,
} from './oauth.js';
export { makeSheetScope, type Svc, type SheetScope, type SheetInfo, type Dims } from './ctx.js';
export { runOp, renderError, type RunOptions } from './run.js';
export { parseSpreadsheetId } from './spreadsheet-id.js';
export { zodSchema, zodToJsonSchema } from './schema.js';
export type { Op, OpResult, OpArgs, OpAnnotations, ToolsetGroup, Schema } from './types.js';
export { TOOLSET_GROUPS, scopeFor } from './types.js';
export {
  TOOLSETS,
  listOps,
  listToolsets,
  getOp,
  selectToolsets,
  assertValidToolsets,
  toolToMeta,
} from './registry.js';
export { ALL_OPS } from '../ops/index.js';