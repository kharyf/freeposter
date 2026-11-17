// The Fancy style's graphics plan: which template illustrates which stretch of speech, what it says, which words
// get a snap zoom and where the cover frame is. The user's AI picks from the template catalogue; the answer is
// checked here and anything that breaks the rules is dropped. Without an AI, the longest words become
// kinetic-words graphics. Times are on the edited timeline throughout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { askAi } from "../../ai/router.ts";
import type { Question } from "../../ai/providers.ts";
import type { Word } from "../transcribe.ts";
import { checkParams, fancyTemplates, type FancyParam, type FancyTemplate } from "./templates.ts";

export interface PlannedGraphic {
  start: number;
  end: number;
  template: string;
  params: Record<string, string | number | boolean>;
  /** the words said while it's on screen (at most 40 characters): keyword-card shows it when nothing else renders */
  phrase: string;
}

export interface FancyPlan {
  graphics: PlannedGraphic[];
  /** times of words that get a snap zoom */
  emphasis: number[];
  /** the cover's title (blank: the cover is just the frame) and the time of its frame */
  cover: { title: string; at: number };
  source: "ai" | "keywords";
  /** for the review card */
  notes: string[];
}

/** Bump when a change here should replace cached plans. */
export const PLAN_VERSION = 1;

/** The face opens the video: no graphic before this. */
const FIRST_START = 1.5;
const MIN_SEC = 2;
const MAX_SEC = 6;
const MAX_GRAPHICS = 12;
/** Graphics cover at least this share of a video of 8 s or longer. */
const MIN_COVERAGE = 0.4;
const MAX_BLENDER = 2;
const PHRASE_CHARS = 40;
const COVER_WORDS = 6;
/** The keyword graphic, and the seconds it can last. */
const KEYWORD_TEMPLATE = "kinetic-words";
/** FreePoster's own fallback card: never offered to the AI. */
const BUILTIN_ONLY = "keyword-card";
const EPS = 1e-6;

/** At least this many graphics: 3 on a video of 8 s or longer, one per 3 s on a shorter one. */
const minimumGraphics = (durationSec: number) => (durationSec >= 8 ? 3 : Math.floor(durationSec / 3));

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** The value in `list` nearest x, within [lo, hi]; null when none is. */
function nearest(list: number[], x: number, lo: number, hi: number): number | null {
  let best: number | null = null;
  for (const v of list) if (v >= lo - EPS && v <= hi + EPS && (best === null || Math.abs(v - x) < Math.abs(best - x))) best = v;
  return best;
}

/** The words said inside [start, end], as many whole words as fit in 40 characters. */
function phraseIn(words: Word[], start: number, end: number): string {
  let out = "";
  for (const w of words) {
    if (w.start < start - EPS || w.end > end + EPS) continue;
    const next = out ? `${out} ${w.text}` : w.text;
    if (next.length > PHRASE_CHARS) return out || w.text.slice(0, PHRASE_CHARS);
    out = next;
  }
  return out;
}

const offered = () => Object.values(fancyTemplates()).filter((t) => t.id !== BUILTIN_ONLY);

// ---- checking the AI's answer ----

/**
 * The AI's answer, made to follow the rules: each graphic clamped into the timeline after 1.5 s, started on a
 * word's start and ended on a word's end, 2 to 6 s long (within its template's own seconds). Unknown templates,
 * bad params, overlaps (the earlier one stays), a third Blender graphic and a thirteenth graphic are dropped
 * and listed in `problems`; the rest of the plan stays.
 */
export function validatePlan(raw: unknown, words: Word[], durationSec: number): { plan: Omit<FancyPlan, "source" | "notes">; problems: string[] } {
  const problems: string[] = [];
  const answer = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (answer !== raw) problems.push("the answer isn't a JSON object");
  const templates = fancyTemplates();
  const starts = words.map((w) => w.start);
  const ends = words.map((w) => w.end);

  const placed: (PlannedGraphic & { at: string; tool: FancyTemplate["tool"] })[] = [];
  const list = Array.isArray(answer.graphics) ? answer.graphics : [];
  if (answer.graphics !== undefined && !Array.isArray(answer.graphics)) problems.push("graphics isn't a list");
  list.forEach((g: any, i) => {
    const at = `graphics[${i}]`;
    // Own keys only: "constructor" or "__proto__" isn't a template.
    const t = typeof g?.template === "string" && Object.hasOwn(templates, g.template) ? templates[g.template] : undefined;
    if (!t || t.id === BUILTIN_ONLY) return problems.push(`${at}: unknown template "${g?.template}"`);
    const name = `${at} (${t.id})`;
    let rawParams = g.params;
    if (typeof rawParams === "string") {
      try { rawParams = JSON.parse(rawParams); } catch { return problems.push(`${name}: params isn't a JSON object`); }
    }
    const { params, problems: wrong } = checkParams(t, rawParams);
    if (wrong.length) return problems.push(`${name}: ${wrong.join("; ")}`);
    if (!isTime(g.start) || !isTime(g.end)) return problems.push(`${name}: start and end must be numbers of seconds`);
    // A template that allows less than 2 s keeps its own minimum.
    const lo = t.minSec;
    const hi = Math.min(MAX_SEC, t.maxSec);
    const latest = durationSec - lo;
    if (latest < FIRST_START - EPS) return problems.push(`${name}: the video is too short for it`);
    const s0 = clamp(g.start, FIRST_START, latest);
    const start = nearest(starts, s0, FIRST_START, latest) ?? s0;
    const endMax = Math.min(start + hi, durationSec);
    const e0 = clamp(g.end, start + lo, endMax);
    const end = nearest(ends, e0, start + lo, endMax) ?? e0;
    placed.push({ start, end, template: t.id, params, phrase: phraseIn(words, start, end), at: name, tool: t.tool });
  });

  placed.sort((a, b) => a.start - b.start);
  const graphics: PlannedGraphic[] = [];
  let blender = 0;
  let lastEnd = -Infinity;
  for (const { at, tool, ...g } of placed) {
    if (g.start < lastEnd - EPS) { problems.push(`${at}: overlaps the graphic before it`); continue; }
    if (tool === "blender" && blender >= MAX_BLENDER) { problems.push(`${at}: more than ${MAX_BLENDER} Blender graphics`); continue; }
    if (graphics.length >= MAX_GRAPHICS) { problems.push(`${at}: more than ${MAX_GRAPHICS} graphics`); continue; }
    if (tool === "blender") blender++;
    graphics.push(g);
    lastEnd = g.end;
  }

  const emphasis = new Set<number>();
  const asked = Array.isArray(answer.emphasis) ? answer.emphasis : [];
  asked.forEach((t, i) => {
    if (!isTime(t) || t < 0 || t > durationSec) return problems.push(`emphasis[${i}] isn't a time in the video`);
    emphasis.add(nearest(starts, t, 0, durationSec) ?? t);
  });

  const cover = (answer.cover ?? {}) as Record<string, unknown>;
  const title = typeof cover.title === "string" ? cover.title.trim().split(/\s+/).filter(Boolean).slice(0, COVER_WORDS).join(" ") : "";
  return {
    plan: { graphics, emphasis: [...emphasis].sort((a, b) => a - b), cover: { title, at: coverAt(cover.at, graphics, durationSec) } },
    problems,
  };
}

/** The cover frame's time: the AI's, clamped into the video (no later than its last frame), or just before the first graphic. */
function coverAt(at: unknown, graphics: PlannedGraphic[], durationSec: number): number {
  const last = Math.max(0, durationSec - 1 / 30);
  if (isTime(at)) return clamp(at, 0, last);
  return graphics.length ? clamp(graphics[0].start - 0.5, 0, last) : 0;
}

// ---- the keyword plan (no AI) ----

const STOPWORDS = new Set(`
a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each even
ever every few for from further get gets getting got gonna had hadn't has hasn't have haven't having he he'd he'll
he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its
itself just kind know let's like literally lot me more most much must my myself no nor not now of off ok okay on
once only or other ought our ours ourselves out over own really right same say said she she'd she'll she's should
shouldn't so some something such than that that's the their theirs them themselves then there there's these they
they'd they'll they're they've thing things think this those through to too under until up us very want was wasn't
we we'd we'll we're we've well were weren't what what's when when's where where's which while who who's whom why
why's will with won't would wouldn't yeah yes you you'd you'll you're you've your yours yourself yourselves
`.trim().split(/\s+/));

/** A word as a keyword: no surrounding punctuation, curly apostrophes made straight. */
const bare = (text: string) => text.replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}$£€]+|[^\p{L}\p{N}%]+$/gu, "");
const score = (text: string) => {
  const b = bare(text);
  return b && !STOPWORDS.has(b.toLowerCase()) ? b.length : 0;
};

/** Sentences end at . ? or ! or a pause of 0.4 s or more. */
function sentences(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (!next || /[.?!]["'”’)]*$/.test(w.text.trim()) || next.start - w.end >= 0.4) { out.push(cur); cur = []; }
  });
  return out;
}

interface Pick { start: number; words: string; score: number }

/** The words of a sentence a graphic may start on. */
const eligible = (sentence: Word[]) => sentence.filter((w) => w.start >= FIRST_START - EPS);
const goodNeighbour = (ok: Word[], i: number) => [ok[i - 1], ok[i + 1]].filter((n) => n && score(n.text) > 0).sort((a, b) => score(b.text) - score(a.text))[0];

/** ok[i] and the better of its neighbours. */
function pairAt(ok: Word[], i: number): Pick {
  const n = goodNeighbour(ok, i) ?? ok[i + 1] ?? ok[i - 1];
  const pair = n ? [ok[i], n].sort((a, b) => a.start - b.start) : [ok[i]];
  const shown = pair.map((w) => bare(w.text)).join(" ");
  return { start: pair[0].start, words: shown.charAt(0).toUpperCase() + shown.slice(1), score: score(ok[i].text) };
}

/** A sentence's keyword pair: its longest word that isn't a stopword, and the better of its neighbours. */
function pairIn(sentence: Word[]): Pick | null {
  const ok = eligible(sentence);
  let top = -1;
  for (let i = 0; i < ok.length; i++) {
    const s = score(ok[i].text);
    if (!s) continue;
    // Among equally long words, one with a word worth showing beside it.
    if (top < 0 || s > score(ok[top].text) || (s === score(ok[top].text) && !goodNeighbour(ok, top) && goodNeighbour(ok, i))) top = i;
  }
  return top < 0 ? null : pairAt(ok, top);
}

/** Keyword graphics in the time `taken` leaves free. */
function keywordGraphics(words: Word[], durationSec: number, need: number, taken: { start: number; end: number }[]): PlannedGraphic[] {
  if (need <= 0) return [];
  const kinetic = fancyTemplates()[KEYWORD_TEMPLATE];
  const lo = Math.max(MIN_SEC, kinetic.minSec);
  const hi = Math.min(MAX_SEC, kinetic.maxSec);
  const fits = (p: Pick | null): p is Pick => p !== null && checkParams(kinetic, { words: p.words }).problems.length === 0;
  const picks = sentences(words).map(pairIn).filter(fits);
  // When those don't fit the free time, any other word worth showing, best first.
  const spare = sentences(words)
    .flatMap((s) => { const ok = eligible(s); return ok.map((w, i) => (score(w.text) ? pairAt(ok, i) : null)); })
    .filter(fits)
    .filter((p) => !picks.some((q) => q.start === p.start && q.words === p.words));

  // The best pick in each equal stretch of the video first, then the best of the rest.
  const span = (durationSec - FIRST_START) / need;
  const slot = (p: Pick) => Math.min(need - 1, Math.floor((p.start - FIRST_START) / span));
  const byScore = (a: Pick, b: Pick) => b.score - a.score || a.start - b.start;
  const firsts = [...Array(need).keys()].map((s) => picks.filter((p) => slot(p) === s).sort(byScore)[0]).filter(Boolean);
  const order = [...firsts, ...picks.filter((p) => !firsts.includes(p)).sort(byScore), ...spare.sort(byScore)];

  const busy = [...taken];
  const chosen: Pick[] = [];
  for (const p of order) {
    if (chosen.length >= need) break;
    const free = p.start + lo <= durationSec + EPS && busy.every((b) => p.start + lo <= b.start + EPS || p.start >= b.end - EPS);
    if (!free) continue;
    chosen.push(p);
    busy.push({ start: p.start, end: p.start + lo });
  }

  // Each lasts its share of half the video, up to the next graphic.
  const target = clamp((durationSec * 0.5) / need, lo, hi);
  const ends = words.map((w) => w.end);
  return chosen.sort((a, b) => a.start - b.start).map((p) => {
    const next = Math.min(...[...taken.map((t) => t.start), ...chosen.map((c) => c.start)].filter((s) => s > p.start + EPS), durationSec);
    const endMax = Math.min(p.start + hi, next);
    const e0 = clamp(p.start + target, p.start + lo, endMax);
    const end = nearest(ends, e0, p.start + lo, endMax) ?? e0;
    return { start: p.start, end, template: KEYWORD_TEMPLATE, params: { words: p.words }, phrase: phraseIn(words, p.start, end) };
  });
}

/** `need` kinetic-words graphics on the longest words of sentences spread across the video. */
export function keywordPlan(words: Word[], durationSec: number, need: number): PlannedGraphic[] {
  return keywordGraphics(words, durationSec, need, []);
}

// ---- asking the AI ----

/** What each template is good for, beside its description. */
const USE_FOR: Record<string, string> = {
  "pull-quote": "a striking line worth reading: the speaker's own words, trimmed to the memorable part",
  "kinetic-words": "a punchy idea in 1 to 4 words; the default when nothing more specific fits",
  "stat-counter": "a number the speaker says (a price, a percentage, a multiple, a count)",
  "build-list": "things the speaker lists, shown as they are named",
  steps: "a process or sequence the speaker walks through, in order",
  compare: "a contrast the speaker draws: before/after, old way/new way, them/you",
  "icon-callout": "a concrete thing or feeling an emoji can stand for (a phone, money, time, a rocket for launching)",
  "gold-3d-word": "the single most important word of the whole video, once",
  "gold-3d-object": "a moment about money, growth or decline, the world, time, data or an idea, matching one of its objects",
};

/** A template's params as the JSON Schema the AI fills. */
function paramsSchema(t: FancyTemplate): object {
  const property = (p: FancyParam) => {
    const out: Record<string, unknown> = { type: p.type === "color" ? "string" : p.type };
    if (p.maxLength !== undefined) out.maxLength = p.maxLength;
    if (p.min !== undefined) out.minimum = p.min;
    if (p.max !== undefined) out.maximum = p.max;
    if (p.enum) out.enum = p.enum;
    if (p.parts) {
      out.description = `${p.parts.min} to ${p.parts.max} ${p.parts.noun} separated by ${p.parts.separator === " " ? "spaces" : `"${p.parts.separator}"`}` +
        (p.maxLength !== undefined ? `, at most ${p.maxLength} characters in all, joined` : "");
    }
    if (p.emoji) out.description = "exactly one emoji";
    if (p.default !== undefined) out.default = p.default;
    return out;
  };
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, property(p)])),
    required: Object.entries(t.params).filter(([, p]) => p.required).map(([k]) => k),
    additionalProperties: false,
  };
}

function system(): string {
  const catalogue = offered().map((t) => [
    `- ${t.id} (${Math.max(MIN_SEC, t.minSec)}–${Math.min(MAX_SEC, t.maxSec)} s${t.tool === "blender" ? ", Blender" : ""}): ${t.description}`,
    ...(USE_FOR[t.id] ? [`  Use for: ${USE_FOR[t.id]}.`] : []),
    `  params: ${JSON.stringify(paramsSchema(t))}`,
    `  example params: ${JSON.stringify(t.example)}`,
  ].join("\n")).join("\n");
  const blender = offered().filter((t) => t.tool === "blender").map((t) => t.id).join(" and ");
  return `You are the motion-graphics editor for one short vertical talking-head video, cut in the "Fancy" style. The frame is split in two: the speaker fills one half and a graphic about what they are saying fills the other. You decide which graphic illustrates which stretch of speech, and what it says.

The look is elegant, gold-and-ink, editorial: a well-designed magazine spread, never a meme. Every template is already designed in that look (ink backgrounds, gold and yellow accents, cream text, an italic serif). You only pick templates and write their words and numbers. Write like a magazine editor: short, specific and calm. Sentence case or title case, never ALL CAPS, no hashtags, no exclamation marks, no filler such as "Did you know?" or "Wow". Use an emoji only where a template asks for one.

Choosing graphics:
- Each graphic illustrates the words said while it is on screen. Find the moments that carry a concrete idea (a number, a contrast, a list, a sequence, a memorable line, a key object) and place the graphic over the words that say it, starting as the idea starts.
- Use the speaker's own words and numbers. Never invent a fact, figure, item or claim they didn't say. A stat-counter needs a number they said; compare needs a contrast they drew; build-list and steps need items they named.
- Keep the text short enough to read at a glance in the time it is on screen.
- Pick the template that fits the idea, and vary them: don't use the same template twice in a row when another fits.
- Spread the graphics across the video, with the speaker alone in between.

Rules (graphics that break them are thrown away):
- Times are seconds on the video's timeline, as in the word list. Start each graphic at a word's start and end it at a word's end.
- Each graphic lasts within its template's seconds, and always 2 to 6 seconds.
- No graphic starts before 1.5 s: the video opens on the speaker's face.
- Graphics never overlap.
- Together, graphics are on screen for 40–60% of the video.
- At least the number of graphics the request asks for, and at most 12.
- At most 2 graphics from Blender templates (${blender}): they are slow to render, so save them for the strongest moments.
- params is a JSON object written as a string, with exactly the template's params (see each template's schema), for example "{\\"quote\\":\\"Ship it before it's perfect\\"}".
- why says in a few words which spoken words the graphic illustrates.

Also give:
- emphasis: the start times (from the word list) of the few words that land the point, such as a number, the key noun or the punchline; about one every 3 to 5 seconds. The picture snaps in on each.
- cover: a title of at most 6 words for the video's cover image, a hook in the speaker's own terms (sentence case, no clickbait), and at: the start time of a word in the hook or the most striking line, whose frame becomes the cover.

The templates:
${catalogue}`;
}

function prompt(words: Word[], durationSec: number, need: number, problems: string[] | null): string {
  const lines = words.map((w) => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}] ${w.text}`);
  const ask = `The video is ${durationSec.toFixed(1)} s long. Plan at least ${need} graphics, on screen for ${(durationSec * 0.4).toFixed(1)}–${(durationSec * 0.6).toFixed(1)} s in total.

The words said, as [start-end] word, in seconds:
${lines.join("\n")}`;
  if (!problems) return ask;
  return `${ask}

Your last answer had these problems:
${problems.map((p) => `- ${p}`).join("\n")}
Answer again with the whole plan, fixing them.`;
}

function schema(): object {
  return {
    type: "object",
    properties: {
      graphics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            start: { type: "number" },
            end: { type: "number" },
            template: { type: "string", enum: offered().map((t) => t.id) },
            // A string, so every provider's strict schema mode takes it: each template has its own params.
            params: { type: "string", description: "the template's params as a JSON object" },
            why: { type: "string" },
          },
          required: ["start", "end", "template", "params", "why"],
          additionalProperties: false,
        },
      },
      emphasis: { type: "array", items: { type: "number" } },
      cover: {
        type: "object",
        properties: { title: { type: "string" }, at: { type: "number" } },
        required: ["title", "at"],
        additionalProperties: false,
      },
    },
    required: ["graphics", "emphasis", "cover"],
    additionalProperties: false,
  };
}

/**
 * The plan for a video's graphics. The AI is asked once, and once more when too few graphics survive the
 * checks; it is topped up with keyword graphics if still short. Without an AI, it's keyword graphics only.
 */
export async function planGraphics(words: Word[], durationSec: number, opts: { ask?: <T>(q: Question) => Promise<T> } = {}): Promise<FancyPlan> {
  const need = minimumGraphics(durationSec);
  if (!words.length || need <= 0) return { graphics: [], emphasis: [], cover: { title: "", at: 0 }, source: "keywords", notes: [] };
  const ask = opts.ask ?? (<T>(q: Question) => askAi<T>("graphics", q));

  let best: Omit<FancyPlan, "source" | "notes"> | null = null;
  let problems: string[] | null = null;
  let failure = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: unknown;
    try {
      raw = await ask({ system: system(), prompt: prompt(words, durationSec, need, problems), schema: schema(), effort: "high" });
    } catch (err) {
      failure = (err as Error).message;
      break;
    }
    let checked: ReturnType<typeof validatePlan>;
    try {
      checked = validatePlan(raw, words, durationSec);
    } catch (err) {
      // A graphic never fails the edit: an answer that can't even be checked counts as no answer.
      failure = `its answer couldn't be checked: ${(err as Error).message}`;
      break;
    }
    if (!best || checked.plan.graphics.length >= best.graphics.length) best = checked.plan;
    if (checked.plan.graphics.length >= need) break;
    problems = [...checked.problems, `only ${checked.plan.graphics.length} valid graphics, fewer than ${need}`];
  }

  if (!best) {
    // Enough of them to cover about half the video at about 4 s each.
    const count = Math.min(MAX_GRAPHICS, Math.max(need, Math.round((durationSec * 0.5) / 4)));
    const filled = fillCoverage(words, durationSec, keywordPlan(words, durationSec, count));
    const none = /no AI provider is connected|isn't installed/.test(failure);
    if (!none) console.error(`Fancy graphics plan: the AI didn't answer (${failure}); using keyword graphics`);
    return {
      graphics: filled.graphics, emphasis: [], cover: { title: "", at: coverAt(undefined, filled.graphics, durationSec) }, source: "keywords",
      notes: [none ? "no AI connected: keyword graphics only" : "the AI didn't answer: keyword graphics only", ...filled.notes],
    };
  }

  const notes: string[] = [];
  let graphics = best.graphics;
  if (graphics.length < need) {
    const extra = keywordGraphics(words, durationSec, need - graphics.length, graphics);
    if (extra.length) notes.push(`the AI planned ${graphics.length} of ${need} graphics: ${extra.length} keyword graphic${extra.length === 1 ? "" : "s"} added`);
    graphics = [...graphics, ...extra].sort((a, b) => a.start - b.start);
  }
  const filled = fillCoverage(words, durationSec, graphics);
  return { ...best, graphics: filled.graphics, source: "ai", notes: [...notes, ...filled.notes] };
}

/** Seconds of the video with a graphic on screen. */
const coverage = (graphics: PlannedGraphic[]) => graphics.reduce((s, g) => s + g.end - g.start, 0);

/**
 * On a video of 8 s or longer, keyword graphics in the free time until graphics cover 40% of it, there are 12
 * of them, or no free stretch fits one. The 60% ceiling is left to the prompt.
 */
function fillCoverage(words: Word[], durationSec: number, graphics: PlannedGraphic[]): { graphics: PlannedGraphic[]; notes: string[] } {
  if (durationSec < 8) return { graphics, notes: [] };
  let out = graphics;
  let added = 0;
  while (coverage(out) < MIN_COVERAGE * durationSec - EPS && out.length < MAX_GRAPHICS) {
    const extra = keywordGraphics(words, durationSec, 1, out);
    if (!extra.length) break;
    out = [...out, ...extra].sort((a, b) => a.start - b.start);
    added++;
  }
  const notes = added ? [`graphics covered under 40% of the video: ${added} keyword graphic${added === 1 ? "" : "s"} added`] : [];
  return { graphics: out, notes };
}

// ---- caching ----

/**
 * The plan saved at `path`, or a new one from `make`, saved there. A keyword plan made because the AI couldn't
 * answer isn't saved, so connecting one later gets real graphics.
 */
export async function cachedPlan(path: string, make: () => Promise<FancyPlan>): Promise<FancyPlan> {
  if (existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved?.version === PLAN_VERSION && saved.plan) return saved.plan as FancyPlan;
    } catch {}
  }
  const plan = await make();
  if (plan.source === "ai" || !plan.notes.length) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: PLAN_VERSION, plan }));
  }
  return plan;
}
