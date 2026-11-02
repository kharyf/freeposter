import { createHash } from "node:crypto";

/** Which parts of the edit to apply. Every combination is its own cached edit. */
export interface EditSettings {
  tighten: boolean;
  captions: boolean;
  reframe: boolean;
  audio: boolean;
  punchIn: boolean;
}

export const DEFAULT_EDIT: EditSettings = { tighten: true, captions: true, reframe: true, audio: true, punchIn: true };

export function parseEditSettings(raw: unknown): EditSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_EDIT };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("edit settings must be an object");
  const out = { ...DEFAULT_EDIT };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULT_EDIT)) throw new Error(`${k} is not an edit setting`);
    if (typeof v !== "boolean") throw new Error(`edit setting ${k} must be true or false`);
    out[k as keyof EditSettings] = v;
  }
  return out;
}

/** Source hash plus a hash of the settings: the same file with the same settings is edited once. */
export function editKey(sourceSha: string, s: EditSettings): string {
  const canonical = JSON.stringify(Object.keys(DEFAULT_EDIT).sort().map((k) => [k, s[k as keyof EditSettings]]));
  return `${sourceSha}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}
