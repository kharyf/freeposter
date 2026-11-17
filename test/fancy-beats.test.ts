import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cadenceProblems, planBeats, type Beat, type Layout } from "../src/edit/fancy/beats.ts";
import { keywordPlan, type PlannedGraphic } from "../src/edit/fancy/plan.ts";
import type { Word } from "../src/edit/transcribe.ts";

const EPS = 1e-6;

/** A small seeded PRNG (mulberry32): the same seed always gives the same words. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mostly words worth showing, so the keyword plan has graphics to place. */
const VOCAB = ["people", "growth", "the", "money", "started", "single", "creators", "and", "audience", "habit", "posting",
  "consistency", "views", "compound", "momentum", "camera", "you", "daily", "results", "patience"];

/**
 * Deterministic random words over `seconds`: each 0.15–0.6 s, gaps of 0–0.5 s, and now and then a 4 s run of
 * words touching end to end. About one word in six ends a sentence.
 */
function gen(seconds: number, seed: number): Word[] {
  const r = rng(seed);
  const out: Word[] = [];
  let t = 0.2 + r() * 0.3;
  let runUntil = -1;
  while (true) {
    if (runUntil < 0 && r() < 0.08) runUntil = t + 4;
    const len = 0.15 + r() * 0.45;
    if (t + len > seconds - 0.05) break;
    let text = VOCAB[Math.floor(r() * VOCAB.length)];
    if (r() < 1 / 6) text += ".";
    out.push({ text, start: t, end: t + len });
    t += len;
    if (t >= runUntil) {
      runUntil = -1;
      t += r() * 0.5;
    }
  }
  return out;
}

const isSplit = (b: Beat) => b.layout !== "full";

/** Split sections: consecutive split beats sharing a graphic are one section. */
function sections(beats: Beat[]): { graphic: number; layout: Layout; beats: Beat[] }[] {
  const out: { graphic: number; layout: Layout; beats: Beat[] }[] = [];
  beats.forEach((b, i) => {
    if (!isSplit(b)) return;
    const prev = beats[i - 1];
    if (prev && isSplit(prev) && prev.graphic === b.graphic) out.at(-1)!.beats.push(b);
    else out.push({ graphic: b.graphic!, layout: b.layout, beats: [b] });
  });
  return out;
}

function assertTiles(beats: Beat[], durationSec: number) {
  assert.equal(beats[0].start, 0);
  assert.equal(beats.at(-1)!.end, durationSec);
  beats.slice(1).forEach((b, i) => assert.equal(b.start, beats[i].end));
  beats.forEach((b) => assert.ok(b.end - b.start > 0, `beat ${b.start}–${b.end} has no length`));
}

const graphic = (start: number, end: number): PlannedGraphic => ({ start, end, template: "kinetic-words", params: { words: "Test" }, phrase: "" });
const touching = (from: number, to: number, len = 0.5): Word[] => {
  const out: Word[] = [];
  for (let i = 0; from + (i + 1) * len <= to + EPS; i++) out.push({ text: "word", start: from + i * len, end: from + (i + 1) * len });
  return out;
};

test("gen is deterministic and includes 4 s runs of touching words", () => {
  assert.deepEqual(gen(30, 7), gen(30, 7));
  const words = gen(90, 90);
  let longest = 0;
  let runStart = words[0].start;
  words.forEach((w, i) => {
    if (i > 0 && w.start - words[i - 1].end > EPS) runStart = w.start;
    longest = Math.max(longest, w.end - runStart);
  });
  assert.ok(longest >= 4 - 0.6, `longest touching run ${longest} s`);
});

for (const sec of [5, 8, 12, 30, 61, 90]) for (const punchIn of [true, false]) test(`cadence holds: ${sec}s punchIn=${punchIn}`, () => {
  const words = gen(sec, sec);
  const graphics = keywordPlan(words, sec, sec >= 8 ? 3 : Math.floor(sec / 3));
  const beats = planBeats({ durationSec: sec, words, graphics, emphasis: [], cutTimes: [], punchIn });
  assertTiles(beats, sec);
  if (punchIn) assert.deepEqual(cadenceProblems(beats, []), []);
  const splits = sections(beats); // consecutive split beats sharing a graphic = one section
  // Every graphic is a section, and no section is invented. keywordPlan finds only 2 graphics in these 8 s of
  // words (a Task 6 limit: see the 8 s test below for 3 graphics there), so the 3-section rule is asserted above 8 s.
  assert.equal(splits.length, graphics.length);
  if (sec > 8) assert.ok(splits.length >= 3, `${splits.length} split sections`);
  splits.forEach((s, i) => assert.equal(s.layout, i % 2 === 0 ? "speakerBottom" : "speakerTop"));
  // Each section spans its graphic exactly, and its graphicOffset runs with the clip.
  splits.forEach((s) => {
    const g = graphics[s.graphic];
    assert.equal(s.beats[0].start, g.start);
    assert.equal(s.beats.at(-1)!.end, g.end);
    s.beats.forEach((b) => assert.ok(Math.abs(b.graphicOffset - (b.start - g.start)) < EPS));
  });
  beats.filter((b) => !isSplit(b)).forEach((b) => { assert.equal(b.graphic, null); assert.equal(b.graphicOffset, 0); });
});

test("8 s with three graphics: three alternating sections and the 2 s rule", () => {
  const words = gen(8, 8);
  const graphics = [graphic(1.5, 3.5), graphic(3.6, 5.6), graphic(5.8, 7.8)];
  const beats = planBeats({ durationSec: 8, words, graphics, emphasis: [], cutTimes: [], punchIn: true });
  assertTiles(beats, 8);
  assert.deepEqual(cadenceProblems(beats, []), []);
  assert.deepEqual(sections(beats).map((s) => s.layout), ["speakerBottom", "speakerTop", "speakerBottom"]);
});

test("a 4 s run with no word gaps splits at exactly 2.0 s", () => {
  const beats = planBeats({ durationSec: 4, words: touching(0, 4), graphics: [], emphasis: [], cutTimes: [], punchIn: true });
  assert.deepEqual(beats.map((b) => [b.start, b.end]), [[0, 2], [2, 4]]);
});

test("a beat splits at the word gap nearest 1.6 s in, between 1.2 and 2.0 s", () => {
  // Gaps at 1.3–1.35 and 1.75–1.8: 1.6 is nearer the second, so the split lands at its start, 1.75.
  const words: Word[] = [
    { text: "a", start: 0, end: 1.3 }, { text: "b", start: 1.35, end: 1.75 }, { text: "c", start: 1.8, end: 3.5 },
  ];
  const beats = planBeats({ durationSec: 3.5, words, graphics: [], emphasis: [], cutTimes: [], punchIn: true });
  assert.deepEqual(beats.map((b) => [b.start, b.end]), [[0, 1.75], [1.75, 3.5]]);
  // A gap that holds 1.6 s itself: the split is at 1.6 exactly.
  const wide: Word[] = [{ text: "a", start: 0, end: 1.4 }, { text: "b", start: 1.9, end: 3.5 }];
  const b2 = planBeats({ durationSec: 3.5, words: wide, graphics: [], emphasis: [], cutTimes: [], punchIn: true });
  assert.deepEqual(b2.map((b) => [b.start, b.end]), [[0, 1.6], [1.6, 3.5]]);
});

test("full layout zoom levels cycle 1.00, 1.18, 1.08, 1.30; split speaker alternates 1.00, 1.12", () => {
  // 0–9 full (no gaps: splits every 2 s → 5 full beats), 9–15 a graphic (3 split beats), 15–19 full (2 beats).
  const beats = planBeats({ durationSec: 19, words: touching(0, 19), graphics: [graphic(9, 15)], emphasis: [], cutTimes: [], punchIn: true });
  assertTiles(beats, 19);
  const full = beats.filter((b) => b.layout === "full");
  const split = beats.filter(isSplit);
  assert.deepEqual(full.map((b) => b.zoom), [1.0, 1.18, 1.08, 1.3, 1.0, 1.18, 1.08]);
  assert.deepEqual(split.map((b) => b.zoom), [1.0, 1.12, 1.0]);
  assert.deepEqual(split.map((b) => b.layout), ["speakerBottom", "speakerBottom", "speakerBottom"]);
  assert.ok(beats.every((b) => b.pushPerSec === 0.025));

  // The split cycle restarts in each section.
  const two = planBeats({ durationSec: 16, words: touching(0, 16), graphics: [graphic(2, 6), graphic(8, 12)], emphasis: [], cutTimes: [], punchIn: true });
  const secs = sections(two);
  assert.deepEqual(secs.map((s) => s.beats.map((b) => b.zoom)), [[1.0, 1.12], [1.0, 1.12]]);
  assert.deepEqual(secs.map((s) => s.layout), ["speakerBottom", "speakerTop"]);
});

test("an emphasis word sets snapAt on its beat; punchIn off clears zoom, push and snap", () => {
  const input = { durationSec: 4, words: touching(0, 4), graphics: [], emphasis: [0.5, 1.0, 2.5], cutTimes: [] };
  const on = planBeats({ ...input, punchIn: true });
  assert.deepEqual(on.map((b) => b.snapAt), [0.5, 2.5]);
  const none = planBeats({ ...input, emphasis: [], punchIn: true });
  assert.deepEqual(none.map((b) => b.snapAt), [null, null]);

  const off = planBeats({ ...input, punchIn: false });
  assert.ok(off.every((b) => b.zoom === 1 && b.pushPerSec === 0 && b.snapAt === null));
  // No cadence splits either: one 4 s beat, and the over-long stretch is reported.
  assert.deepEqual(off.map((b) => [b.start, b.end]), [[0, 4]]);
  assert.deepEqual(cadenceProblems(off, []), ["no change between 0.00s and 4.00s"]);
});

test("footage cuts reset the 2 s count", () => {
  const words = touching(0, 3.8, 0.38);
  const withCut = planBeats({ durationSec: 3.8, words, graphics: [], emphasis: [], cutTimes: [1.9], punchIn: true });
  assert.deepEqual(withCut.map((b) => [b.start, b.end]), [[0, 3.8]]);
  assert.deepEqual(cadenceProblems(withCut, [1.9]), []);
  // Without the cut, the same stretch needs a split.
  const without = planBeats({ durationSec: 3.8, words, graphics: [], emphasis: [], cutTimes: [], punchIn: true });
  assert.ok(without.length > 1);
  assert.deepEqual(cadenceProblems(without, []), []);
  // The cut doesn't count once it's ignored: the one long beat is reported.
  assert.deepEqual(cadenceProblems(withCut, []), ["no change between 0.00s and 3.80s"]);
});

test("no speech: full-frame beats of at most 2 s", () => {
  const b = planBeats({ durationSec: 7, words: [], graphics: [], emphasis: [], cutTimes: [], punchIn: true });
  assertTiles(b, 7);
  assert.ok(b.every((x) => x.layout === "full" && x.end - x.start <= 2.0 + 1e-9));
});

test("too few graphics: no splits are invented, and cadenceProblems doesn't count sections", () => {
  // 30 s with no speech, so the plan has no graphics: only full beats, and no problem reported for the missing splits.
  const b = planBeats({ durationSec: 30, words: [], graphics: [], emphasis: [], cutTimes: [], punchIn: true });
  assertTiles(b, 30);
  assert.ok(b.every((x) => x.layout === "full"));
  assert.deepEqual(cadenceProblems(b, []), []);
});

test("graphic windows are trusted, clamped into the video, and never make empty beats", () => {
  // Starts before 1.5 s, overlaps the next one, and the last runs past the end.
  const graphics = [graphic(0.5, 3), graphic(2.5, 5), graphic(5, 5), graphic(8, 12)];
  const beats = planBeats({ durationSec: 10, words: [], graphics, emphasis: [], cutTimes: [], punchIn: true });
  assertTiles(beats, 10);
  const secs = sections(beats);
  assert.deepEqual(secs.map((s) => s.graphic), [0, 1, 3]);
  assert.deepEqual(secs.map((s) => s.layout), ["speakerBottom", "speakerTop", "speakerBottom"]);
  // The overlapping graphic starts where the first ends, half a second into its clip.
  assert.equal(secs[1].beats[0].start, 3);
  assert.ok(Math.abs(secs[1].beats[0].graphicOffset - 0.5) < EPS);
  assert.equal(secs[2].beats.at(-1)!.end, 10);
});

test("cadenceProblems reports splits that don't alternate", () => {
  const beat = (start: number, end: number, layout: Layout, graphic: number | null): Beat =>
    ({ start, end, layout, graphic, graphicOffset: 0, zoom: 1, pushPerSec: 0, snapAt: null });
  const beats = [beat(0, 2, "full", null), beat(2, 4, "speakerTop", 0), beat(4, 6, "full", null), beat(6, 8, "speakerTop", 1)];
  assert.deepEqual(cadenceProblems(beats, []), ["split 1 doesn't alternate"]);
});
