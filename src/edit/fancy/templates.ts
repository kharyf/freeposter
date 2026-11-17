// The Fancy editing style's graphic templates: what each shows, its params and seconds, which tool renders it and
// what to try when that tool can't. Each lives in templates/fancy/<id>/ as a schema.json beside its Shot.tsx
// (Remotion), index.html (HyperFrames) or template.py (Blender); keyword-card is FreePoster's own (ffmpeg).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codeDir } from "../../config.ts";
import { templateParams, type ShotSpec, type TemplateParam } from "../../produce/spec.ts";
import { fancyFontFile, PALETTE } from "./palette.ts";

/** Checks beyond the production schema's: a fixed list of values, a count of separated parts, a single emoji. */
export interface FancyParam extends TemplateParam {
  enum?: string[];
  /** e.g. 2 to 4 items separated by "|" */
  parts?: { separator: string; min: number; max: number; noun: string };
  emoji?: boolean;
}

export interface FancyTemplate {
  id: string;
  tool: "remotion" | "hyperframes" | "blender" | "builtin";
  description: string;
  params: Record<string, FancyParam>;
  minSec: number;
  maxSec: number;
  fallback: string | null;
  /**
   * fallback param name → this template's param name, "$main" (the graphic's own text), "$phrase" (the graphic's
   * spoken key phrase, a last resort) or "$icon" (the object's emoji)
   */
  fallbackParams: Record<string, string>;
  /** params that render well: the dev samples and the AI's prompt use them */
  example: Record<string, string | number | boolean>;
  dir: string;
}

/** Every graphic is this size: one half of the 1080x1920 frame. */
export const GRAPHIC_SIZE = { width: 1080, height: 960 } as const;

/** gold-3d-object's objects, and the emoji icon-callout shows for each when Blender can't render. */
export const OBJECT_ICONS: Record<string, string> = {
  coin: "🪙", "arrow-up": "⬆️", "arrow-down": "⬇️", globe: "🌍", clock: "⏰", bars: "📊", lightbulb: "💡",
};

const FONTS = { boldItalic: "PlayfairDisplay-BoldItalic.ttf", italic: "PlayfairDisplay-Italic.ttf" } as const;
/** GSAP 3.15.0, the version HyperFrames's own templates load; see templates/fancy/_shared/GSAP-LICENSE.txt. */
const GSAP = "gsap.min.js";
const TOOLS = ["remotion", "hyperframes", "blender", "builtin"];

// In the installed app they are unpacked beside app.asar, since the tools read them as plain files.
export const fancyTemplateDir = () => join(codeDir.replace(/app\.asar$/, "app.asar.unpacked"), "templates", "fancy");

let loaded: Record<string, FancyTemplate> | null = null;

/** The catalogue, by id. Read once: the templates ship with FreePoster. */
export function fancyTemplates(): Record<string, FancyTemplate> {
  if (loaded) return loaded;
  const out: Record<string, FancyTemplate> = {};
  for (const id of readdirSync(fancyTemplateDir()).sort()) {
    const dir = join(fancyTemplateDir(), id);
    if (!existsSync(join(dir, "schema.json"))) continue;
    const raw = JSON.parse(readFileSync(join(dir, "schema.json"), "utf8"));
    if (!TOOLS.includes(raw.tool)) throw new Error(`Fancy template ${id}: unknown tool "${raw.tool}"`);
    out[id] = {
      id, tool: raw.tool, description: raw.description ?? "", params: raw.params ?? {},
      minSec: raw.minSec, maxSec: raw.maxSec, fallback: raw.fallback ?? null, fallbackParams: raw.fallbackParams ?? {},
      example: raw.example ?? {}, dir,
    };
  }
  for (const t of Object.values(out)) if (t.fallback && !out[t.fallback]) throw new Error(`Fancy template ${t.id}: unknown fallback "${t.fallback}"`);
  return (loaded = out);
}

const graphemes = (s: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].map((g) => g.segment);

/** Params checked like a production's Blender template params, plus the Fancy checks; every problem is listed. */
export function checkParams(t: FancyTemplate, raw: unknown): { params: Record<string, string | number | boolean>; problems: string[] } {
  const problems: string[] = [];
  const params = templateParams(raw, { description: t.description, params: t.params }, "", (m) => problems.push(m));
  for (const [k, p] of Object.entries(t.params)) {
    const v = params[k];
    if (typeof v !== "string") continue;
    if (p.enum && !p.enum.includes(v)) problems.push(`params.${k} must be one of ${p.enum.join(", ")}`);
    if (p.parts) {
      const sep = p.parts.separator;
      const parts = v.trim().split(sep === " " ? /\s+/ : sep).map((s) => s.trim());
      const n = v.trim() ? parts.length : 0;
      if (n < p.parts.min || n > p.parts.max || parts.some((s) => !s)) {
        problems.push(`params.${k} must be ${p.parts.min} to ${p.parts.max} ${p.parts.noun} separated by ${sep === " " ? "spaces" : sep}`);
      }
    }
    if (p.emoji) {
      const g = graphemes(v.trim());
      if (g.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g[0])) problems.push(`params.${k} must be a single emoji`);
    }
  }
  return { params, problems };
}

/** Words in a kinetic-words list, as checkParams splits them. */
const wordsIn = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/**
 * The graphic's own text, for a fallback that shows words: what t would have put on screen, kept within `limit`
 * (the fallback param's most words and characters) where t has parts to choose from. Empty when params lack it.
 */
function mainText(t: FancyTemplate, params: Record<string, string | number | boolean>, limit: { words: number; chars: number }): string {
  const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string).trim() : "");
  const fits = (s: string) => wordsIn(s).length <= limit.words && s.length <= limit.chars;
  /** As many of the parts, in order, as fit (at least the first: repair shortens it). */
  const fitting = (parts: string[]) => {
    let out = parts[0] ?? "";
    for (const part of parts.slice(1)) if (fits(`${out} ${part}`)) out = `${out} ${part}`; else break;
    return out;
  };
  const items = (k: string) => str(k).split("|").map((s) => s.trim()).filter(Boolean);
  switch (t.id) {
    case "stat-counter": {
      if (typeof params.value !== "number") return "";
      const n = params.value.toLocaleString("en-US", { maximumFractionDigits: 6 });
      return fitting([`${str("prefix")}${n}${str("suffix")}`, str("label")].filter(Boolean));
    }
    case "compare": return str("left") && str("right") ? `${str("left")} vs ${str("right")}` : "";
    case "pull-quote": return str("quote");
    case "build-list": return fitting(items("items"));
    case "steps": return fitting(items("steps"));
    case "icon-callout": case "gold-3d-object": return str("label");
    case "gold-3d-word": return str("word");
    case "kinetic-words": return str("words");
    default: return "";
  }
}

/**
 * The params for t's fallback template, from t's params and the graphic's key phrase. "$main" is the graphic's own
 * text (mainText); the spoken key phrase stands in only when that's missing.
 */
export function fallbackParamsFor(t: FancyTemplate, params: Record<string, string | number | boolean>, phrase: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const target = t.fallback ? fancyTemplates()[t.fallback] : undefined;
  for (const [to, from] of Object.entries(t.fallbackParams)) {
    if (from === "$phrase") out[to] = phrase;
    else if (from === "$main") {
      const p = target?.params[to];
      const limit = { words: p?.parts?.separator === " " ? p.parts.max : Infinity, chars: p?.maxLength ?? Infinity };
      out[to] = mainText(t, params, limit) || phrase;
    } else if (from === "$icon") out[to] = OBJECT_ICONS[String(params.object)] ?? "✨";
    else if (params[from] !== undefined) out[to] = params[from];
  }
  return out;
}

/** JSON that's safe inside an HTML <script>. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** The production shot that renders t at 1080x960, with the palette and fonts. keyword-card has none (renderKeywordCard). */
export function toShot(t: FancyTemplate, params: Record<string, string | number | boolean>, durationSec: number, id: string): ShotSpec {
  const size = { ...GRAPHIC_SIZE };
  const assets = [
    { name: FONTS.boldItalic, path: fancyFontFile("boldItalic") },
    { name: FONTS.italic, path: fancyFontFile("italic") },
  ];
  const palette = { ink: PALETTE.ink, ink2: PALETTE.ink2, yellow: PALETTE.yellow, gold: PALETTE.gold, cream: PALETTE.cream, shadowAlpha: PALETTE.shadowAlpha };
  switch (t.tool) {
    case "remotion":
      return {
        id, kind: "remotion", duration_sec: durationSec, size, assets,
        tsx: readFileSync(join(t.dir, "Shot.tsx"), "utf8"),
        props: { ...params, palette, fontUrl: FONTS.boldItalic, italicFontUrl: FONTS.italic },
      };
    case "hyperframes": {
      // One pass, so a param that happens to contain a placeholder ("__GSAP__") stays as the user's text.
      const values: Record<string, string> = {
        __DURATION__: String(durationSec),
        __PARAMS__: scriptJson(params),
        __PALETTE__: scriptJson(palette),
        __FONT_BOLD_ITALIC__: FONTS.boldItalic,
        __FONT_ITALIC__: FONTS.italic,
        __GSAP__: GSAP,
      };
      const html = readFileSync(join(t.dir, "index.html"), "utf8").replace(/__[A-Z_]+?__/g, (m) => values[m] ?? m);
      // GSAP ships with FreePoster (templates/fancy/_shared), so the compositions render offline.
      const gsap = { name: GSAP, path: join(fancyTemplateDir(), "_shared", GSAP) };
      return { id, kind: "hyperframes", duration_sec: durationSec, size, assets: [...assets, gsap], html };
    }
    case "blender":
      return {
        id, kind: "blender", duration_sec: durationSec, size, engine: "eevee",
        template: t.id, script: join(t.dir, "template.py"),
        params: { ...params, font: fancyFontFile("boldItalic"), italic_font: fancyFontFile("italic"), ink: palette.ink, ink2: palette.ink2, gold: palette.gold, yellow: palette.yellow, cream: palette.cream },
      };
    default:
      throw new Error(`${t.id} is built in: render it with renderKeywordCard`);
  }
}
