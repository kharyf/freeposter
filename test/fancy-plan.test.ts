import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { strictSchema, type Question } from "../src/ai/providers.ts";
import { cachedPlan, keywordPlan, planGraphics, PLAN_VERSION, validatePlan, type FancyPlan } from "../src/edit/fancy/plan.ts";
import { fancyTemplates } from "../src/edit/fancy/templates.ts";
import type { Word } from "../src/edit/transcribe.ts";
import { tmp } from "./helpers.ts";

// About 18 s of speech in a 20 s video: each word 0.4 s with a 0.15 s gap, and 0.4 s more between sentences.
const SCRIPT = [
  "Most people never start.",
  "They wait for the perfect moment.",
  "I posted every single day for ninety days.",
  "My views grew three times faster.",
  "Small steps compound into something huge.",
];
const WORDS_20S: Word[] = (() => {
  const out: Word[] = [];
  let t = 0.3;
  for (const sentence of SCRIPT) {
    for (const text of sentence.split(" ")) {
      out.push({ text, start: +t.toFixed(2), end: +(t + 0.4).toFixed(2) });
      t += 0.55;
    }
    t += 0.4;
  }
  return out;
})();
const at = (text: string) => WORDS_20S.find((w) => w.text.replace(/\W/g, "") === text)!;

// Three good graphics on the words they illustrate.
const GOOD_PLAN = {
  graphics: [
    { start: at("They").start, end: at("moment").end, template: "pull-quote", params: { quote: "They wait for the perfect moment" }, why: "the line about waiting" },
    { start: at("My").start, end: at("faster").end, template: "stat-counter", params: JSON.stringify({ value: 3, suffix: "×", label: "faster growth" }), why: "three times faster" },
    { start: at("Small").start, end: at("huge").end, template: "kinetic-words", params: { words: "Small steps compound" }, why: "the takeaway" },
  ],
  emphasis: [at("ninety").start, at("three").start],
  cover: { title: "Post every day", at: at("posted").start },
};

const starts = new Set(WORDS_20S.map((w) => w.start));
const ends = new Set(WORDS_20S.map((w) => w.end));
const overlapping = (gs: { start: number; end: number }[]) => gs.some((g, i) => i > 0 && g.start < gs[i - 1].end);

test("invalid graphics are dropped, not the plan", () => {
  const { plan, problems } = validatePlan({ graphics: [
    { start: 2, end: 5, template: "pull-quote", params: { quote: "ok" } },
    { start: 4, end: 7, template: "pull-quote", params: { quote: "overlaps" } },
    { start: 8, end: 99, template: "kinetic-words", params: { words: "late" } },
    { start: 10, end: 12, template: "nope", params: {} },
  ], emphasis: [3.1], cover: { title: "One secret", at: 2.5 } }, WORDS_20S, 20);
  assert.deepEqual(plan.graphics.map((g) => g.template), ["pull-quote", "kinetic-words"]);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /nope/.test(p)) && problems.some((p) => /overlap/.test(p)), problems.join("; "));
  const late = plan.graphics[1];
  assert.ok(late.end <= 20 && late.end - late.start <= fancyTemplates()["kinetic-words"].maxSec, "clamped to the template's longest");
  assert.ok(ends.has(late.end), "snapped to a word's end");
  assert.equal(plan.cover.title, "One secret");
  assert.equal(plan.cover.at, 2.5);
  assert.equal(plan.emphasis.length, 1);
  assert.ok(starts.has(plan.emphasis[0]), "emphasis lands on a word");
});

test("graphics start no earlier than 1.5 s, last 2–6 s, and snap to word gaps", () => {
  const { plan } = validatePlan({ graphics: [
    { start: 0, end: 0.9, template: "kinetic-words", params: { words: "Never start" } },          // too early, too short
    { start: 5.07, end: 6.0, template: "pull-quote", params: { quote: "Every single day" } },     // too short, off-word
    { start: 9.33, end: 30, template: "compare", params: { left_title: "Before", left: "1×", right_title: "After", right: "3×" } }, // too long
    { start: 16.1, end: 16.2, template: "icon-callout", params: { icon: "🌱", label: "Small steps" } },
  ], emphasis: [], cover: { title: "", at: 0 } }, WORDS_20S, 20);
  assert.equal(plan.graphics.length, 4);
  const t = fancyTemplates();
  for (const g of plan.graphics) {
    assert.ok(g.start >= 1.5, `${g.template} starts at ${g.start}`);
    assert.ok(starts.has(g.start), `${g.template} starts on a word (${g.start})`);
    assert.ok(ends.has(g.end), `${g.template} ends on a word (${g.end})`);
    const len = g.end - g.start;
    assert.ok(len >= Math.max(2, t[g.template].minSec) - 1e-9 && len <= Math.min(6, t[g.template].maxSec) + 1e-9, `${g.template} lasts ${len}`);
    assert.ok(g.phrase.length > 0 && g.phrase.length <= 40, `phrase "${g.phrase}"`);
  }
  assert.ok(!overlapping(plan.graphics));
  for (const g of plan.graphics) {
    // The words said during it, as many whole words as fit in 40 characters.
    let said = "";
    for (const w of WORDS_20S.filter((w) => w.start >= g.start && w.end <= g.end)) if ((said ? `${said} ${w.text}` : w.text).length <= 40) said = said ? `${said} ${w.text}` : w.text; else break;
    assert.equal(g.phrase, said, "the phrase is the words said during it");
  }
});

test("more than 2 Blender graphics: the extras are dropped", () => {
  const { plan, problems } = validatePlan({ graphics: [
    { start: 2, end: 4.5, template: "gold-3d-word", params: { word: "Start" } },
    { start: 7, end: 9.5, template: "gold-3d-word", params: { word: "Daily" } },
    { start: 12, end: 14.5, template: "gold-3d-word", params: { word: "Faster" } },
  ], emphasis: [], cover: { title: "", at: 1 } }, WORDS_20S, 20);
  assert.deepEqual(plan.graphics.map((g) => g.params.word), ["Start", "Daily"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Blender/);
});

test("params that don't fit the template drop that graphic, and params may come as a JSON string", () => {
  const { plan, problems } = validatePlan({ graphics: [
    { start: 2, end: 5, template: "gold-3d-object", params: JSON.stringify({ object: "rocket", label: "Go" }) },
    { start: 7, end: 10, template: "pull-quote", params: "{not json" },
    { start: 12, end: 15, template: "stat-counter", params: JSON.stringify({ value: 3, suffix: "×", label: "faster" }) },
  ], emphasis: [], cover: { title: "", at: 1 } }, WORDS_20S, 20);
  assert.deepEqual(plan.graphics.map((g) => g.template), ["stat-counter"]);
  assert.deepEqual(plan.graphics[0].params, { value: 3, prefix: "", suffix: "×", label: "faster" });
  assert.equal(problems.length, 2);
});

test("template names that aren't the catalogue's own are unknown, not a crash", () => {
  const { plan, problems } = validatePlan({ graphics: [
    { start: 2, end: 5, template: "constructor", params: {} },
    { start: 7, end: 10, template: "__proto__", params: {} },
    { start: 12, end: 15, template: "toString", params: {} },
  ], emphasis: [], cover: { title: "", at: 1 } }, WORDS_20S, 20);
  assert.deepEqual(plan.graphics, []);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => /unknown template/.test(p)), problems.join("; "));
});

test("an answer that can't even be checked gives the keyword plan", async () => {
  const broken = { get graphics(): unknown { throw new Error("boom"); }, emphasis: [], cover: { title: "", at: 0 } };
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const plan = await planGraphics(WORDS_20S, 20, { ask: async <T>() => broken as T });
    assert.equal(plan.source, "keywords");
    assert.ok(plan.graphics.length >= 3);
  } finally {
    console.error = log;
  }
  assert.equal(errors.length, 1);
});

test("graphics under 40% of a video of 8 s or longer are topped up with keyword graphics", async () => {
  // Three valid graphics of about 2 s: about 6 s of a 20 s video.
  const short = { ...GOOD_PLAN, graphics: [
    { start: at("They").start, end: at("the").end, template: "pull-quote", params: { quote: "They wait" }, why: "" },
    { start: at("My").start, end: at("three").end, template: "stat-counter", params: { value: 3, suffix: "×", label: "views" }, why: "" },
    { start: at("Small").start, end: at("into").end, template: "kinetic-words", params: { words: "Small steps" }, why: "" },
  ] };
  const plan = await planGraphics(WORDS_20S, 20, { ask: async <T>() => short as T });
  const covered = plan.graphics.reduce((s, g) => s + g.end - g.start, 0);
  assert.ok(covered >= 8, `covered ${covered} s`);
  assert.deepEqual(plan.graphics.filter((g) => g.template !== "kinetic-words" || g.params.words === "Small steps").length, 3, "the AI's graphics stay");
  assert.ok(!overlapping(plan.graphics));
  for (const g of plan.graphics) assert.ok(g.start >= 1.5 && g.end <= 20 && g.end - g.start >= 2 - 1e-9 && g.end - g.start <= 6 + 1e-9);
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /40%/);
});

test("the cover: at most 6 words, its time clamped into the video, or just before the first graphic", () => {
  const long = validatePlan({ ...GOOD_PLAN, cover: { title: "  One two three four five six seven  ", at: 45 } }, WORDS_20S, 20).plan.cover;
  assert.deepEqual(long, { title: "One two three four five six", at: 20 - 1 / 30 }, "no later than the last frame");
  const bad = validatePlan({ ...GOOD_PLAN, cover: { title: "Hi", at: "soon" } }, WORDS_20S, 20).plan;
  assert.equal(bad.cover.at, bad.graphics[0].start - 0.5);
});

test("the question: high effort, the catalogue without keyword-card, the timed words and the duration", async () => {
  let asked: Question | undefined;
  await planGraphics(WORDS_20S, 20, { ask: async <T>(q: Question) => { asked = q; return GOOD_PLAN as T; } });
  assert.ok(asked);
  assert.equal(asked.effort, "high");
  for (const id of Object.keys(fancyTemplates())) {
    if (id === "keyword-card") assert.ok(!asked.system.includes(id), "keyword-card isn't offered");
    else assert.ok(asked.system.includes(id), `${id} is offered`);
  }
  assert.match(asked.system, /gold-and-ink/);
  assert.match(asked.system, /editorial/);
  assert.match(asked.prompt, /\[0\.30-0\.70\] Most/);
  assert.match(asked.prompt, /20\.0 s/);
  assert.match(asked.prompt, /at least 3 graphics/);
  const schema = asked.schema as any;
  assert.deepEqual(schema.required, ["graphics", "emphasis", "cover"]);
  assert.ok(!schema.properties.graphics.items.properties.template.enum.includes("keyword-card"));
  assert.deepEqual(strictSchema(schema), schema, "already strict, so Codex and OpenRouter take it as it is");
  assert.match(asked.system, /"2 to 4 items separated by \\"\|\\", at most 40 characters in all, joined"/, "list params say their length is for all the items");
});

test("too few valid graphics asks once more, listing the problems", async () => {
  const asked: string[] = [];
  const answers = [{ graphics: [], emphasis: [], cover: { title: "", at: 0 } }, GOOD_PLAN];
  const plan = await planGraphics(WORDS_20S, 20, { ask: async (q) => { asked.push(q.prompt); return answers.shift() as any; } });
  assert.equal(asked.length, 2); assert.match(asked[1], /fewer than 3/); assert.equal(plan.source, "ai");
  assert.deepEqual(plan.graphics.map((g) => g.template), ["pull-quote", "stat-counter", "kinetic-words"]);
  assert.equal(plan.cover.title, "Post every day");
  assert.deepEqual(plan.notes, []);
});

test("a good plan is asked for once", async () => {
  let n = 0;
  const plan = await planGraphics(WORDS_20S, 20, { ask: async <T>() => { n++; return GOOD_PLAN as T; } });
  assert.equal(n, 1);
  assert.equal(plan.source, "ai");
  assert.equal(plan.graphics.length, 3);
});

test("no AI: a keyword plan with at least 3 kinetic-words graphics and a note", async () => {
  const plan = await planGraphics(WORDS_20S, 20, { ask: async () => { throw new Error("no AI provider is connected"); } });
  assert.equal(plan.source, "keywords"); assert.ok(plan.graphics.length >= 3);
  assert.ok(plan.graphics.every((g) => g.template === "kinetic-words"));
  assert.deepEqual(plan.notes, ["no AI connected: keyword graphics only"]); assert.equal(plan.cover.title, "");
});

test("keyword graphics: spread across the video, on long words, within the rules", () => {
  const gs = keywordPlan(WORDS_20S, 20, 3);
  assert.equal(gs.length, 3);
  assert.ok(!overlapping(gs));
  for (const g of gs) {
    assert.ok(g.start >= 1.5 && g.end <= 20);
    assert.ok(g.end - g.start >= 2 - 1e-9 && g.end - g.start <= 5 + 1e-9);
    assert.ok(starts.has(g.start) && ends.has(g.end));
    const words = String(g.params.words).split(" ");
    assert.equal(words.length, 2, "the top word and its neighbour");
    assert.ok(!words.some((w) => ["the", "for", "into", "they", "my", "i"].includes(w.toLowerCase())), `no stopwords in "${g.params.words}"`);
  }
  // One from each third of the video.
  assert.ok(gs[0].start < 8 && gs[2].start > 12, gs.map((g) => g.start).join(", "));
  const covered = gs.reduce((s, g) => s + g.end - g.start, 0);
  assert.ok(covered >= 0.35 * 20 && covered <= 0.6 * 20, `covered ${covered}`);
});

test("AI graphics short of the minimum are topped up with keyword graphics", async () => {
  const two = { ...GOOD_PLAN, graphics: GOOD_PLAN.graphics.slice(0, 2) };
  let n = 0;
  const plan = await planGraphics(WORDS_20S, 20, { ask: async <T>() => { n++; return two as T; } });
  assert.equal(n, 2);
  assert.equal(plan.source, "ai");
  assert.ok(plan.graphics.length >= 3);
  assert.deepEqual(plan.graphics.filter((g) => g.template !== "kinetic-words").map((g) => g.template), ["pull-quote", "stat-counter"]);
  assert.ok(plan.graphics.some((g) => g.template === "kinetic-words"));
  assert.ok(!overlapping(plan.graphics), "the extras sit in free gaps");
  assert.equal(plan.notes.length, 1);
});

test("an AI that fails on the second ask still gives its first answer, topped up", async () => {
  const two = { ...GOOD_PLAN, graphics: GOOD_PLAN.graphics.slice(0, 2) };
  const answers: unknown[] = [two];
  const plan = await planGraphics(WORDS_20S, 20, { ask: async <T>() => { const a = answers.shift(); if (!a) throw new Error("usage limit"); return a as T; } });
  assert.equal(plan.source, "ai");
  assert.ok(plan.graphics.length >= 3);
});

test("no speech: no graphics", async () => { const p = await planGraphics([], 12, { ask: async () => { throw new Error("x"); } }); assert.deepEqual(p.graphics, []); });

test("short videos need fewer graphics", async () => {
  const words = WORDS_20S.filter((w) => w.end <= 6);
  let prompt = "";
  await planGraphics(words, 6, { ask: async <T>(q: Question) => { prompt = q.prompt; return { graphics: [], emphasis: [], cover: { title: "", at: 0 } } as T; } });
  assert.match(prompt, /at least 2 graphics/);
});

test("the plan is cached on disk", async () => {
  const path = join(tmp(), "edits", "x.fancy-plan.json");
  let made = 0;
  const make = async (): Promise<FancyPlan> => { made++; return { graphics: [], emphasis: [], cover: { title: "Hi", at: 1 }, source: "ai", notes: [] }; };
  const a = await cachedPlan(path, make);
  const b = await cachedPlan(path, make);
  assert.equal(made, 1);
  assert.deepEqual(b, a);
  assert.ok(existsSync(path));
  // A plan from an older version is made again.
  writeFileSync(path, JSON.stringify({ version: PLAN_VERSION - 1, plan: a }));
  await cachedPlan(path, make);
  assert.equal(made, 2);
});

test("a keyword plan made because the AI couldn't answer isn't cached, so connecting one later helps", async () => {
  const path = join(tmp(), "y.fancy-plan.json");
  await cachedPlan(path, () => planGraphics(WORDS_20S, 20, { ask: async () => { throw new Error("no AI provider is connected"); } }));
  assert.ok(!existsSync(path));
});
