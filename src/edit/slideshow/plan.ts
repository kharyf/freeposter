// The Slideshow style's plan: which asset each slide shows, for how long, and the title and text on it.
// The user's AI writes it from the instructions, the tagged assets and (with a video) what's said; the answer is
// checked here. Without an AI the slides are laid out in order, so a slideshow always renders.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { askAi } from "../../ai/router.ts";
import type { Question } from "../../ai/providers.ts";
import type { Word } from "../transcribe.ts";

/** frame: a still taken from the edit's own video at atSec of source time */
export interface SlideAsset { index: number; kind: "image" | "video" | "frame"; path: string; name: string; durationSec: number | null; atSec?: number }
/** asset null: a text card */
export interface Slide { start: number; end: number; asset: number | null; title: string; body: string }
export interface SlideshowPlan { slides: Slide[]; durationSec: number; source: "ai" | "fallback"; notes: string[] }

/** Bump when a change here should replace cached plans. */
export const SLIDESHOW_PLAN_VERSION = 1;
export const MIN_SLIDE = 2, MAX_SLIDE = 8, DEFAULT_SLIDE = 4, MAX_SLIDES = 30, MAX_TITLE = 60, MAX_BODY = 140, MIN_TOTAL = 6, MAX_TOTAL = 90;

export interface PlanInput { instructions: string; context: string; words: Word[]; durationSec: number | null; musicSec: number | null; assets: SlideAsset[] }

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const ms = (t: number) => Math.round(t * 1000) / 1000;
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** How long the slideshow runs: the narration's length, else the slides at 4 s each, within the music and 6–90 s. */
export function targetDuration(i: Pick<PlanInput, "durationSec" | "musicSec">, slideCount: number): number {
  if (i.durationSec !== null) return i.durationSec;
  const natural = slideCount * DEFAULT_SLIDE;
  if (i.musicSec !== null) return Math.max(MIN_TOTAL, Math.min(natural, i.musicSec, MAX_TOTAL));
  return clamp(natural, MIN_TOTAL, MAX_TOTAL);
}

/**
 * Times for the slides: their wanted seconds scaled to `total`, each kept within 2–8 s, and the last one taking what's left,
 * so the slides end exactly at `total`. Slides that can't each get 2 s are dropped from the end.
 */
export function layoutSlides(raw: { asset: number | null; seconds: number; title: string; body: string }[], total: number): Slide[] {
  const fit = Math.max(1, Math.min(MAX_SLIDES, Math.floor(total / MIN_SLIDE)));
  const list = raw.slice(0, fit);
  if (!list.length) return [];
  let secs = list.map((s) => (Number.isFinite(s.seconds) && s.seconds > 0 ? s.seconds : DEFAULT_SLIDE));
  for (let pass = 0; pass < 3; pass++) {
    const sum = secs.reduce((a, b) => a + b, 0);
    secs = secs.map((s) => clamp((s * total) / sum, MIN_SLIDE, MAX_SLIDE));
  }
  const slides: Slide[] = [];
  let at = 0;
  list.forEach((s, k) => {
    const end = k === list.length - 1 ? ms(total) : ms(at + secs[k]);
    slides.push({ start: ms(at), end, asset: s.asset, title: s.title, body: s.body });
    at = end;
  });
  return slides;
}

type RawSlide = { asset: number | null; seconds: number; title: string; body: string };

/** Checks an AI answer: out-of-range assets become text cards, unused assets get a slide at the end, long text is trimmed. */
export function validateSlides(raw: unknown, i: PlanInput): { slides: Slide[]; problems: string[] } {
  const problems: string[] = [];
  const list: unknown = Array.isArray(raw) ? raw : (raw as any)?.slides;
  if (!Array.isArray(list) || !list.length) return { slides: [], problems: ["the answer has no slides"] };
  const slides: RawSlide[] = [];
  for (const [n, r] of list.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    let asset: number | null = null;
    if (typeof o.asset === "number" && Number.isInteger(o.asset) && o.asset >= 0) {
      if (o.asset < i.assets.length) asset = o.asset;
      else problems.push(`slide ${n + 1} uses asset ${o.asset}, but there are only ${i.assets.length}`);
    }
    let title = typeof o.title === "string" ? o.title.trim() : "";
    let body = typeof o.body === "string" ? o.body.trim() : "";
    if (title.length > MAX_TITLE) { problems.push(`slide ${n + 1}'s title is over ${MAX_TITLE} characters`); title = cut(title, MAX_TITLE); }
    if (body.length > MAX_BODY) { problems.push(`slide ${n + 1}'s text is over ${MAX_BODY} characters`); body = cut(body, MAX_BODY); }
    slides.push({ asset, seconds: typeof o.seconds === "number" ? o.seconds : DEFAULT_SLIDE, title, body });
  }
  if (slides.length > MAX_SLIDES) {
    problems.push(`${slides.length} slides, but at most ${MAX_SLIDES}`);
    slides.length = MAX_SLIDES;
  }
  for (const a of i.assets) {
    if (!slides.some((s) => s.asset === a.index) && slides.length < MAX_SLIDES) {
      problems.push(`asset ${a.index} (${a.name}) is never shown`);
      slides.push({ asset: a.index, seconds: DEFAULT_SLIDE, title: "", body: "" });
    }
  }
  return { slides: layoutSlides(slides, targetDuration(i, slides.length)), problems };
}

const nameOf = (a: SlideAsset) => (a.kind === "frame" ? "" : cut(basename(a.name, extname(a.name)).replace(/[_-]+/g, " ").trim(), MAX_TITLE));

/** The slides in order, with no AI: one per asset (cycling to fill a narration), or one text card per sentence. */
export function fallbackSlides(i: PlanInput): Slide[] {
  let raw: RawSlide[];
  if (i.assets.length) {
    const count = Math.min(MAX_SLIDES, i.durationSec !== null ? Math.max(i.assets.length, Math.round(i.durationSec / DEFAULT_SLIDE)) : i.assets.length);
    raw = Array.from({ length: count }, (_, k) => {
      const a = i.assets[k % i.assets.length];
      return { asset: a.index, seconds: DEFAULT_SLIDE, title: i.instructions ? "" : nameOf(a), body: "" };
    });
  } else {
    const sentences = i.instructions.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_SLIDES);
    raw = (sentences.length ? sentences : ["Slideshow"]).map((s) => ({ asset: null, seconds: DEFAULT_SLIDE, title: cut(s, MAX_TITLE), body: "" }));
  }
  return layoutSlides(raw, targetDuration(i, raw.length));
}

function system(): string {
  return [
    "You plan a short vertical (9:16) slideshow for social media.",
    `Each slide shows one asset (an image, a video clip or a still frame, chosen by its index) or, with asset -1, a plain text card. A slide lasts ${MIN_SLIDE}–${MAX_SLIDE} seconds.`,
    `Give each slide a short title (at most ${MAX_TITLE} characters) and optionally a line of text (at most ${MAX_BODY}); either may be empty.`,
    `Use every asset at least once, in a sensible order, with at most ${MAX_SLIDES} slides. When there is narration, the slides follow what is said and are timed to it.`,
    "Follow the user's instructions and notes where they apply. Write in the language of the instructions or narration.",
  ].join("\n");
}

function prompt(i: PlanInput, problems: string[] | null): string {
  const assets = i.assets.length
    ? i.assets.map((a) => `${a.index}: ${a.kind}${a.name ? ` "${a.name}"` : ""}${a.durationSec ? `, ${a.durationSec.toFixed(1)} s` : ""}${a.atSec !== undefined ? `, from ${a.atSec.toFixed(1)} s of the video` : ""}`).join("\n")
    : "(none: use text cards, asset -1)";
  const total = targetDuration(i, Math.max(1, i.assets.length));
  const parts = [
    i.durationSec !== null
      ? `The slideshow plays over narration and is ${i.durationSec.toFixed(1)} s long.`
      : `The slideshow runs about ${Math.round(total)} s (more or fewer slides stretch it, between ${MIN_TOTAL} and ${MAX_TOTAL} s${i.musicSec ? `, and no longer than the ${i.musicSec.toFixed(0)} s of music` : ""}).`,
    `Assets:\n${assets}`,
    i.instructions ? `Instructions:\n${i.instructions}` : "",
    i.context ? `Notes from the user:\n${i.context}` : "",
    i.words.length ? `The words said, as [start-end] word, in seconds:\n${i.words.map((w) => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}] ${w.text}`).join("\n")}` : "",
  ].filter(Boolean);
  const ask = parts.join("\n\n");
  if (!problems?.length) return ask;
  return `${ask}\n\nYour last answer had these problems:\n${problems.map((p) => `- ${p}`).join("\n")}\nAnswer again with the whole plan, fixing them.`;
}

function schema(): object {
  return {
    type: "object",
    properties: {
      slides: {
        type: "array",
        items: {
          type: "object",
          properties: {
            asset: { type: "integer", description: "the asset's index, or -1 for a text card" },
            seconds: { type: "number" },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["asset", "seconds", "title", "body"],
          additionalProperties: false,
        },
      },
    },
    required: ["slides"],
    additionalProperties: false,
  };
}

/** The slides. The AI is asked once, and once more with what was wrong; if it can't answer, they're laid out in order. */
export async function planSlideshow(i: PlanInput, opts: { ask?: <T>(q: Question) => Promise<T> } = {}): Promise<SlideshowPlan> {
  const ask = opts.ask ?? (<T>(q: Question) => askAi<T>("graphics", q));
  let best: Slide[] | null = null;
  let problems: string[] | null = null;
  let failure = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: unknown;
    try {
      raw = await ask({ system: system(), prompt: prompt(i, problems), schema: schema(), effort: "medium" });
    } catch (err) {
      failure = (err as Error).message;
      break;
    }
    const checked = validateSlides(raw, i);
    if (checked.slides.length && (!best || !checked.problems.length)) best = checked.slides;
    if (!checked.problems.length) break;
    problems = checked.problems;
  }
  if (best) return { slides: best, durationSec: best[best.length - 1].end, source: "ai", notes: [] };
  const slides = fallbackSlides(i);
  const none = /no AI provider is connected|isn't installed/.test(failure);
  if (failure && !none) console.error(`Slideshow plan: the AI didn't answer (${failure}); laying the slides out in order`);
  return { slides, durationSec: slides[slides.length - 1].end, source: "fallback", notes: [none ? "no AI connected: slides laid out in order" : "the AI didn't answer: slides laid out in order"] };
}

/** A saved plan, or a new one saved for next time. A fallback plan isn't saved, so connecting an AI later gets a real one. */
export async function cachedSlideshowPlan(path: string, make: () => Promise<SlideshowPlan>): Promise<SlideshowPlan> {
  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved?.version === SLIDESHOW_PLAN_VERSION && saved.plan) return saved.plan as SlideshowPlan;
    } catch {}
  }
  const plan = await make();
  if (plan.source === "ai") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: SLIDESHOW_PLAN_VERSION, plan }));
  }
  return plan;
}
