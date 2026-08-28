#!/usr/bin/env node
/**
 * sheets-mcp — stdio MCP server. A thin wrapper over the shared core:
 * registers the selected toolsets' ops as MCP tools and renders OpResults.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { getGoogleServices } from '../lib/google.js';
import { assertValidToolsets, selectToolsets } from '../lib/registry.js';
import { runOp } from '../lib/run.js';
import type { Op } from '../lib/types.js';

const toolsetsSpec = process.env.SHEETS_TOOLSETS ?? 'core,drive';
assertValidToolsets(toolsetsSpec);
const ops = selectToolsets(toolsetsSpec);

if (ops.length === 0) {
  process.stderr.write(`sheets-mcp: no tools for toolsets "${toolsetsSpec}"\n`);
  process.exit(1);
}

const server = new McpServer({ name: 'sheets', version: '0.1.0' });

// The SDK's registerTool generics are driven by the exact schema type. Ops carry
// heterogeneous zod schemas, so register through a typed indirection: the schema
// is a real zod object (validated + flattened by the SDK), the handler takes the
// parsed output as Record<string, unknown>.
function registerOp(op: Op): void {
  const schema = op.inputSchema.zod as z.ZodTypeAny;
  server.registerTool(
    op.name,
    {
      title: op.name,
      description: op.description,
      inputSchema: schema,
      annotations: {
        readOnlyHint: op.annotations.readOnlyHint,
        destructiveHint: op.annotations.destructiveHint,
        idempotentHint: op.annotations.idempotentHint,
        openWorldHint: true,
      },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      // Built inside the handler so credential CONFIG errors render as
      // isError results (teaching), not raw throws.
      const svc = getGoogleServices();
      const result = await runOp(op, args, svc);
      const content = [{ type: 'text' as const, text: result.text }];
      if (result.error) {
        return {
          isError: true,
          content,
          structuredContent: { error: result.error },
        };
      }
      return {
        content,
        ...(result.structured ? { structuredContent: result.structured } : {}),
      };
    },
  );
}

for (const op of ops) registerOp(op);

await server.connect(new StdioServerTransport());
process.stderr.write(`sheets-mcp: ${ops.length} tools registered (toolsets: ${toolsetsSpec})\n`);