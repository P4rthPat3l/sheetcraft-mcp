import type { Op, OpResult, ToolsetGroup, OpAnnotations } from './types.js';
import { TOOLSET_GROUPS } from './types.js';
import { ALL_OPS } from '../ops/index.js';

/** Toolsets: named subsets registered with the MCP server / exposed by the CLI. */
export const TOOLSETS: Record<ToolsetGroup, { label: string; description: string }> = {
  core: { label: 'core', description: 'Values read/write, sheet tabs, dimensions, find/replace (13 tools)' },
  drive: { label: 'drive', description: 'Spreadsheet file lifecycle: create/copy/find/share/trash/export/resolve (7 tools)' },
  formatting: { label: 'formatting', description: 'Cell formatting, merge, freeze, conditional formatting (5 tools)' },
  charts: { label: 'charts', description: 'Create/update/delete embedded charts (3 tools)' },
  pivot: { label: 'pivot', description: 'Pivot tables via the pivotTable cell spec (2 tools)' },
  power: { label: 'power', description: 'Raw batchUpdate escape hatch + sort_range (2 tools)' },
};

export interface ToolMeta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: OpAnnotations;
  group: ToolsetGroup;
}

/** All ops of a given toolset, preserving registration order. */
export function listOps(group?: ToolsetGroup): readonly Op[] {
  return group ? ALL_OPS.filter((op) => op.group === group) : ALL_OPS;
}

export function listToolsets(): readonly ToolsetGroup[] {
  return TOOLSET_GROUPS;
}

export function getOp(name: string): Op | undefined {
  return ALL_OPS.find((op) => op.name === name);
}

/**
 * Resolve a toolset spec (from SHEETS_TOOLSETS / CLI flag) to the ordered op list.
 * 'all' → every op. Deduplicates; unknown names must be rejected beforehand via
 * assertValidToolsets (startup hard-error on typos).
 */
export function selectToolsets(spec: string | readonly string[]): Op[] {
  const parts: string[] =
    typeof spec === 'string'
      ? spec
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0)
      : spec.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  if (parts.length === 0 || parts.includes('all')) return [...ALL_OPS];
  const seen = new Set<string>();
  const out: Op[] = [];
  for (const p of parts) {
    const group = p as ToolsetGroup;
    for (const op of ALL_OPS) {
      if (op.group === group && !seen.has(op.name)) {
        seen.add(op.name);
        out.push(op);
      }
    }
  }
  return out;
}

/** Hard error on unknown toolset names — fail fast at startup, not mid-session. */
export function assertValidToolsets(spec: string): void {
  const parts = spec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const valid = new Set<string>([...TOOLSET_GROUPS, 'all']);
  const bad = parts.filter((p) => !valid.has(p));
  if (bad.length > 0) {
    throw new Error(
      `Unknown toolset(s): ${bad.join(', ')}. Valid: ${[...TOOLSET_GROUPS].join(', ')}, all.`,
    );
  }
}

/** Flatten an Op to the metadata a MCP tools/list entry needs. */
export function toolToMeta(op: Op): ToolMeta {
  return {
    name: op.name,
    description: op.description,
    inputSchema: op.inputSchema.jsonSchema,
    annotations: op.annotations,
    group: op.group,
  };
}