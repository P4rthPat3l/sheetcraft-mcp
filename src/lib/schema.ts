import { z } from 'zod';
import { SheetsError } from './errors.js';
import type { OpArgs, Schema } from './types.js';

type ZodShape = Record<string, z.ZodTypeAny>;

/**
 * Build a Schema from a Zod object. JSON Schema is derived from the Zod shape
 * so MCP inputSchema and validation can never drift apart.
 */
export function zodSchema<T extends z.ZodTypeAny>(schema: T): Schema {
  return {
    jsonSchema: zodToJsonSchema(schema),
    zod: schema,
    parse: (raw: unknown) => {
      const r = schema.safeParse(raw ?? {});
      if (!r.success) {
        const first = r.error.issues[0];
        const path = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
        throw new SheetsError(
          'INVALID_ARGUMENT',
          `Invalid arguments — ${path}${first ? first.message : 'validation failed'}`,
        );
      }
      return r.data as OpArgs;
    },
  };
}

interface PropSchema {
  jsonSchema: Record<string, unknown>;
  optional: boolean;
}

/** Minimal Zod → JSON Schema conversion covering the subset this project uses. */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const p = propSchema(value);
    properties[key] = p.jsonSchema;
    if (!p.optional) required.push(key);
  }
  const json: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) json.required = required;
  json.additionalProperties = false;
  return json;
}

function propSchema(schema: z.ZodTypeAny): PropSchema {
  let optional = false;
  let s: z.ZodTypeAny = schema;
  // Descriptions can live on the wrapper (optional().describe()) or the inner
  // type (describe().optional()) — capture the outer one before unwrapping.
  const outerDesc = typeof schema.description === 'string' ? schema.description : '';
  if (s instanceof z.ZodOptional) {
    optional = true;
    s = s.unwrap();
  } else if (s instanceof z.ZodDefault) {
    optional = true;
    const def = s._def.defaultValue();
    const inner = propSchema(s._def.innerType);
    const js = { ...inner.jsonSchema, default: typeof def === 'function' ? (def as () => unknown)() : def };
    if (outerDesc && !inner.jsonSchema.description) (js as Record<string, unknown>).description = outerDesc;
    return { jsonSchema: js, optional };
  }
  let js: Record<string, unknown>;
  if (s instanceof z.ZodString) {
    js = { type: 'string' };
    for (const chk of (s._def.checks ?? []) as Array<{ kind: string; value?: number }>) {
      if (chk.kind === 'min' && chk.value !== undefined) js.minLength = chk.value;
      if (chk.kind === 'max' && chk.value !== undefined) js.maxLength = chk.value;
    }
  } else if (s instanceof z.ZodNumber) {
    js = { type: 'number' };
    for (const chk of (s._def.checks ?? []) as Array<{ kind: string; value?: number }>) {
      if (chk.kind === 'min' && chk.value !== undefined) js.minimum = chk.value;
      if (chk.kind === 'max' && chk.value !== undefined) js.maximum = chk.value;
    }
  } else if (s instanceof z.ZodBoolean) {
    js = { type: 'boolean' };
  } else if (s instanceof z.ZodEnum) {
    js = { type: 'string', enum: s.options };
  } else if (s instanceof z.ZodArray) {
    js = { type: 'array', items: propSchema(s.element).jsonSchema };
  } else if (s instanceof z.ZodObject) {
    js = zodToJsonSchema(s);
  } else if (s instanceof z.ZodRecord) {
    js = { type: 'object', additionalProperties: propSchema(s.valueSchema).jsonSchema };
  } else if (s instanceof z.ZodAny || s instanceof z.ZodUnknown) {
    js = {};
  } else if (s instanceof z.ZodUnion) {
    js = { anyOf: (s.options as z.ZodTypeAny[]).map((o) => propSchema(o).jsonSchema) };
  } else {
    js = {};
  }
  const desc = s.description || outerDesc;
  if (desc) js.description = desc;
  return { jsonSchema: js, optional };
}