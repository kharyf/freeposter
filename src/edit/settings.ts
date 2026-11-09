import { createHash } from "node:crypto";

/** A stretch of the source video, in seconds. */
export interface Range {
  start: number;
  end: number;
}

/** A misheard word: the caption word nearest `at` (source seconds) that reads `from` is shown as `to`. */
export interface CaptionFix {
  at: number;
  from: string;
  to: string;
}

/** Which parts of the edit to apply. Every combination is its own cached edit. */
export interface EditSettings {
  tighten: boolean;
  captions: boolean;
  reframe: boolean;
  audio: boolean;
  punchIn: boolean;
  /** source ranges always kept, whatever the cut plan says (a redo: "don't cut 0:12-0:15") */
  keep?: Range[];
  /** source ranges always cut ("drop the cough at 0:31") */
  drop?: Range[];
  captionFixes?: CaptionFix[];
}

export const DEFAULT_EDIT: EditSettings = { tighten: true, captions: true, reframe: true, audio: true, punchIn: true };

const SWITCHES = ["tighten", "captions", "reframe", "audio", "punchIn"] as const;
const MAX_ITEMS = 50;

const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 24 * 3600;

function ranges(key: string, raw: unknown): Range[] {
  if (!Array.isArray(raw)) throw new Error(`edit setting ${key} must be a list of { start, end } in seconds`);
  if (raw.length > MAX_ITEMS) throw new Error(`edit setting ${key} takes at most ${MAX_ITEMS} ranges`);
  return raw.map((r) => {
    if (!r || typeof r !== "object" || !isSeconds(r.start) || !isSeconds(r.end) || r.end <= r.start) {
      throw new Error(`each ${key} range needs start and end in seconds, with end after start`);
    }
    return { start: r.start, end: r.end };
  });
}

function fixes(raw: unknown): CaptionFix[] {
  if (!Array.isArray(raw)) throw new Error("edit setting captionFixes must be a list of { at, from, to }");
  if (raw.length > MAX_ITEMS) throw new Error(`edit setting captionFixes takes at most ${MAX_ITEMS} fixes`);
  return raw.map((f) => {
    if (!f || typeof f !== "object" || !isSeconds(f.at) || typeof f.from !== "string" || !f.from.trim() || typeof f.to !== "string" || !f.to.trim()) {
      throw new Error("each caption fix needs at (seconds), from (the word as captioned) and to (what it should say)");
    }
    return { at: f.at, from: f.from.trim(), to: f.to.trim() };
  });
}

export function parseEditSettings(raw: unknown, base: EditSettings = DEFAULT_EDIT): EditSettings {
  const out: EditSettings = { ...base };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("edit settings must be an object");
  for (const [k, v] of Object.entries(raw)) {
    if ((SWITCHES as readonly string[]).includes(k)) {
      if (typeof v !== "boolean") throw new Error(`edit setting ${k} must be true or false`);
      out[k as (typeof SWITCHES)[number]] = v;
    } else if (k === "keep" || k === "drop") {
      out[k] = ranges(k, v);
    } else if (k === "captionFixes") {
      out.captionFixes = fixes(v);
    } else {
      throw new Error(`${k} is not an edit setting`);
    }
  }
  for (const k of ["keep", "drop", "captionFixes"] as const) if (out[k] && !out[k]!.length) delete out[k];
  return out;
}

/**
 * Bump when the editing itself changes, so earlier results aren't reused.
 * 2: sound tags like "(upbeat music)" and song lyrics no longer count as speech.
 */
const EDIT_VERSION = 2;

/** Source hash plus a hash of the settings: the same file with the same settings is edited once. */
export function editKey(sourceSha: string, s: EditSettings): string {
  const entries: [string, unknown][] = SWITCHES.slice().sort().map((k) => [k, s[k]]);
  // Only when used, so every edit made before these existed keeps its key (and its cached file).
  for (const k of ["captionFixes", "drop", "keep"] as const) if (s[k]?.length) entries.push([k, s[k]]);
  const canonical = JSON.stringify([EDIT_VERSION, ...entries]);
  return `${sourceSha}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}
