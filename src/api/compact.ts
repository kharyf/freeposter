type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Drops null, undefined and "" from objects, recursively; keeps false, 0, [] and {}. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)) as T;
  if (!isObject(value)) return value;
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = compact(v);
  }
  return out as T;
}

/** Projects an object onto dotted paths. Paths that match nothing are skipped. */
function projectObject(obj: Obj, paths: string[]): Obj {
  const heads = new Map<string, { whole: boolean; rest: string[] }>();
  for (const path of paths) {
    const dot = path.indexOf(".");
    const head = dot < 0 ? path : path.slice(0, dot);
    if (!Object.hasOwn(obj, head)) continue;
    const entry = heads.get(head) ?? { whole: false, rest: [] };
    if (dot < 0) entry.whole = true;
    else entry.rest.push(path.slice(dot + 1));
    heads.set(head, entry);
  }
  const out: Obj = {};
  for (const [head, { whole, rest }] of heads) {
    if (whole) {
      out[head] = obj[head];
      continue;
    }
    const child = projectValue(obj[head], rest);
    if (child !== undefined) out[head] = child;
  }
  return out;
}

/** Arrays map over their elements; objects project; anything else has no fields to keep. */
function projectValue(value: unknown, paths: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => projectValue(v, paths)).filter((v) => v !== undefined);
  if (isObject(value)) return projectObject(value, paths);
  return undefined;
}

/** Keeps only the dotted `fields`. Applied to an array, each element is projected. No fields returns the value as-is. */
export function pick(value: unknown, fields: string[]): unknown {
  if (fields.length === 0) return value;
  if (Array.isArray(value)) return value.map((v) => (isObject(v) ? projectObject(v, fields) : v));
  if (isObject(value)) return projectObject(value, fields);
  return value;
}

/** Reads a `fields` argument given as "a,b.c" or ["a", "b.c"]. Empty means no projection. */
export function parseFields(raw: unknown): string[] | undefined {
  const parts = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  const fields = parts.map((p) => p.trim()).filter(Boolean);
  return fields.length ? fields : undefined;
}
