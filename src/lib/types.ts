import type { Svc, SheetScope } from './ctx.js';
import { makeSheetScope } from './ctx.js';

/**
 * An operation in the shared core. Wrappers (MCP server, CLI) render these;
 * ops themselves return plain JSON-serializable data or OpResult.
 */
export interface Op {
  /** Tool name as registered with MCP (also the CLI subcommand). */
  name: string;
  /** Toolset group — controls which toolsets include this op. */
  group: ToolsetGroup;
  /** One-line description shown to the model in tools/list (keep it tight). */
  description: string;
  /** Input validation + JSON Schema derivation. */
  inputSchema: Schema;
  /** Truthful behavioral hints for clients and models. */
  annotations: OpAnnotations;
  run: (args: OpArgs, svc: Svc) => Promise<unknown>;
}

/** Convenience: build a spreadsheet-scoped context inside an op. */
export function scopeFor(svc: Svc, spreadsheetId: string): SheetScope {
  return makeSheetScope(svc, spreadsheetId);
}

export interface OpResult {
  /** Human/model-readable text block (CSV output, echoes, notices). */
  text: string;
  /** Machine-readable payload for MCP structuredContent (optional). */
  structured?: Record<string, unknown>;
  /** Set by runOp when the op failed; wrappers map it to isError / exit codes. */
  error?: {
    code: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

/** Which toolset group an op belongs to. */
export type ToolsetGroup = 'core' | 'drive' | 'formatting' | 'charts' | 'pivot' | 'power';

export const TOOLSET_GROUPS: readonly ToolsetGroup[] = ['core', 'drive', 'formatting', 'charts', 'pivot', 'power'];

export interface OpAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/** Minimal structural schema type so ops never import zod in their signatures. */
export interface Schema {
  /** JSON Schema for MCP tools/list inputSchema. */
  jsonSchema: Record<string, unknown>;
  /** The underlying zod object schema — the MCP wrapper passes this to the SDK so args validate + arrive flat. */
  zod: unknown;
  /** Validate + normalize raw args; throws SheetsError(INVALID_ARGUMENT) on failure. */
  parse: (raw: unknown) => OpArgs;
}

export type OpArgs = Record<string, unknown>;