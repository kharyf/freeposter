import { ToolError } from "./errors.ts";

export type JsonSchema = Record<string, unknown>;

const props = (s: JsonSchema) => (s.properties ?? {}) as Record<string, JsonSchema>;
const at = (path: string, key: string) => (path ? `${path}.${key}` : key);

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** The args without optional properties that are null: ops read null as absent, and validate() skips them. */
export function dropNulls(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));
}

/** Checks args against the subset of JSON Schema the tools use; the ops' own readers still run after. */
export function validate(schema: JsonSchema, args: unknown, path = ""): void {
  const name = path || "arguments";
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues && !enumValues.includes(args)) throw new ToolError(`${name} must be one of ${enumValues.join(", ")}`);
  switch (schema.type) {
    case "integer":
      if (typeof args !== "number" || !Number.isInteger(args)) throw new ToolError(`${name} must be a whole number`);
      return;
    case "number":
      if (typeof args !== "number" || !Number.isFinite(args)) throw new ToolError(`${name} must be a number`);
      return;
    case "string": {
      if (typeof args !== "string") throw new ToolError(`${name} must be a string`);
      if (typeof schema.minLength === "number" && args.length < schema.minLength) throw new ToolError(`${name} needs at least ${schema.minLength} characters`);
      if (typeof schema.maxLength === "number" && args.length > schema.maxLength) throw new ToolError(`${name} allows at most ${schema.maxLength} characters`);
      return;
    }
    case "boolean":
      if (typeof args !== "boolean") throw new ToolError(`${name} must be true or false`);
      return;
    case "array": {
      if (!Array.isArray(args)) throw new ToolError(`${name} must be a list`);
      if (typeof schema.minItems === "number" && args.length < schema.minItems) throw new ToolError(`${name} needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
      if (typeof schema.maxItems === "number" && args.length > schema.maxItems) throw new ToolError(`${name} allows at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}`);
      const items = schema.items as JsonSchema | undefined;
      if (items) args.forEach((v, i) => validate(items, v, `${path}[${i}]`));
      return;
    }
    case "object": {
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ToolError(`${name} must be an object`);
      const given = args as Record<string, unknown>;
      const known = props(schema);
      for (const key of (schema.required ?? []) as string[]) if (given[key] === undefined || given[key] === null) throw new ToolError(`${at(path, key)} is required`);
      for (const [key, value] of Object.entries(given)) {
        if (Object.hasOwn(known, key)) {
          if (value !== undefined && value !== null) validate(known[key], value, at(path, key));
        } else if (schema.additionalProperties === false) {
          const near = Object.keys(known).map((k) => [k, levenshtein(key, k)] as const).filter(([, d]) => d <= 3).sort((a, b) => a[1] - b[1])[0];
          throw new ToolError(`unknown argument ${at(path, key)}${near ? `; did you mean ${at(path, near[0])}?` : ""}`);
        }
      }
    }
  }
}

/** Enums of up to 4 values are spelled out; with `short`, longer ones render as their base type (renderDoc lists them all). */
function typeToken(s: JsonSchema, short = false): string {
  if (Array.isArray(s.enum) && !(short && s.enum.length > 4)) return s.enum.join("|");
  switch (s.type) {
    case "integer": return "int";
    case "number": return "num";
    case "string": return "str";
    case "boolean": return "bool";
    case "array": return `[${s.items ? typeToken(s.items as JsonSchema, short) : "any"}]`;
    case "object": return "obj";
    default: return "any";
  }
}

/** Required properties first, then optional, each in schema order: `name a:int b?:str`. */
export function signature(name: string, schema: JsonSchema): string {
  const required = new Set((schema.required ?? []) as string[]);
  const entries = Object.entries(props(schema));
  const parts = [...entries.filter(([k]) => required.has(k)), ...entries.filter(([k]) => !required.has(k))]
    .map(([k, s]) => `${k}${required.has(k) ? "" : "?"}:${typeToken(s, true)}`);
  return [name, ...parts].join(" ");
}

/** The first sentence, cut to 70 characters (the index has one line per op, so this is what keeps it small). */
export function summary(description: string): string {
  const first = description.trim().split(/(?<=[.!?])\s/)[0].replace(/\s+/g, " ");
  return first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

function propLines(s: JsonSchema, indent: string): string[] {
  const required = new Set((s.required ?? []) as string[]);
  const lines: string[] = [];
  for (const [k, p] of Object.entries(props(s))) {
    const desc = typeof p.description === "string" ? ` — ${p.description.replace(/\s+/g, " ")}` : "";
    const def = p.default !== undefined ? ` (default ${JSON.stringify(p.default)})` : "";
    lines.push(`${indent}${k}${required.has(k) ? "" : "?"}: ${typeToken(p)}${desc}${def}`);
    if (p.type === "object") lines.push(...propLines(p, `${indent}  `));
    const items = p.items as JsonSchema | undefined;
    if (p.type === "array" && items?.type === "object") lines.push(...propLines(items, `${indent}  `));
  }
  return lines;
}

/** Plain-text documentation for one tool: signature, description, then each property. */
export function renderDoc(tool: { name: string; description: string; inputSchema: JsonSchema }): string {
  return [signature(tool.name, tool.inputSchema), tool.description, ...propLines(tool.inputSchema, "  ")].join("\n");
}
