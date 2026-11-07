// Getting a JSON answer out of whatever an AI program printed, and checking it against the question's schema.
// Some providers enforce the schema themselves and some only hand back text, so every answer is checked here.

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; additionalProperties?: boolean };

/** What's wrong with `value` against the (small JSON Schema subset FreePoster uses), or null when it fits. */
export function schemaProblem(schema: Schema, value: unknown, at = "answer"): string | null {
  const type = schema.type;
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} isn't an object`;
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) return `${at} has no ${key}`;
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        const p = schemaProblem(sub, obj[key], `${at}.${key}`);
        if (p) return p;
      }
    }
    return null;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return `${at} isn't a list`;
    for (let i = 0; i < value.length; i++) {
      const p = schema.items ? schemaProblem(schema.items, value[i], `${at}[${i}]`) : null;
      if (p) return p;
    }
    return null;
  }
  if (type === "string") return typeof value === "string" ? null : `${at} isn't text`;
  if (type === "boolean") return typeof value === "boolean" ? null : `${at} isn't true or false`;
  if (type === "integer") return Number.isInteger(value) ? null : `${at} isn't a whole number`;
  if (type === "number") return typeof value === "number" ? null : `${at} isn't a number`;
  return null;
}

/** Every top-level JSON object written somewhere in `text`: a fenced block, or {...} with text around it. */
function objectsIn(text: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (s: string) => { try { out.push(JSON.parse(s)); } catch {} };
  tryParse(text.trim());
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) tryParse(m[1].trim());
  // Balanced braces, skipping over strings.
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        tryParse(text.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

/** Strings and objects inside a parsed value, deepest last, so an answer wrapped in an event or envelope is found. */
function walk(value: unknown, into: unknown[]) {
  into.push(value);
  if (typeof value === "string") {
    for (const o of objectsIn(value)) if (o !== value) walk(o, into);
  } else if (Array.isArray(value)) {
    for (const v of value) walk(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) walk(v, into);
  }
}

/**
 * The answer in a program's output: the last JSON value anywhere in it (in JSON lines, an envelope's field or
 * plain text) that fits the schema. Throws, saying what came back, when nothing fits.
 */
export function findAnswer<T>(output: string, schema: object): T {
  const candidates: unknown[] = [];
  const lines = output.split(/\r?\n/).filter((l) => l.trim());
  // Whole output first (a single JSON document), then each line (JSON lines), then text anywhere.
  for (const chunk of [output, ...lines]) for (const o of objectsIn(chunk)) walk(o, candidates);
  let problem: string | null = "nothing that looks like JSON";
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (typeof c !== "object" || c === null) continue;
    const p = schemaProblem(schema as Schema, c);
    if (!p) return c as T;
    problem = p;
  }
  const said = output.trim().replace(/\s+/g, " ").slice(-200);
  throw new Error(`its reply wasn't the expected JSON (${problem})${said ? `: ${said}` : ""}`);
}

/** The question as one block of text, for programs with no separate system prompt or schema option. */
export function promptText(q: { system: string; prompt: string; schema: object }): string {
  return `${q.system}\n\n${q.prompt}\n\nAnswer with only a JSON object that matches this JSON Schema, and nothing else (no explanation, no code fence). Don't use any tools.\n${JSON.stringify(q.schema)}`;
}
