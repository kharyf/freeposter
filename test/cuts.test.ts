import assert from "node:assert/strict";
import { test } from "node:test";
import { planCuts, remapWords, type Segment } from "../src/edit/cuts.ts";
import type { Word } from "../src/edit/transcribe.ts";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });
const total = (segs: Segment[]) => segs.reduce((n, s) => n + s.end - s.start, 0);
const overlaps = (segs: Segment[], a: number, b: number) => segs.some((s) => s.start < b && s.end > a);

test("drops fillers", () => {
  const words = [w("so", 0, 0.3), w("um,", 0.4, 0.6), w("today", 0.7, 1.0)];
  const segs = planCuts(words, 1.2);
  assert.ok(!overlaps(segs, 0.4, 0.6), JSON.stringify(segs));
  assert.deepEqual(remapWords(words, segs).map((x) => x.text), ["so", "today"]);
});

test("long gap is cut to padding", () => {
  const segs = planCuts([w("a", 0, 0.5), w("b", 3.0, 3.5)], 4);
  assert.ok(total(segs) < 1.3, `kept ${total(segs)}s`);
});

test("leading and trailing silence are trimmed", () => {
  const segs = planCuts([w("hello", 2, 2.5)], 10);
  assert.ok(segs[0].start >= 1.9 && segs.at(-1)!.end <= 2.6, JSON.stringify(segs));
});

test("repeated take keeps the last", () => {
  const words = [w("I", 0, 0.2), w("want", 0.2, 0.5), w("to", 0.5, 0.9), w("I", 1.5, 1.7), w("want", 1.7, 2.0), w("to", 2.0, 2.2), w("talk", 2.2, 2.6)];
  const kept = remapWords(words, planCuts(words, 3)).map((x) => x.text);
  assert.deepEqual(kept, ["I", "want", "to", "talk"]);
});

test("a single false-start word before a pause is dropped", () => {
  const words = [w("The", 0, 0.3), w("the", 0.8, 1.0), w("plan", 1.0, 1.4)];
  assert.deepEqual(remapWords(words, planCuts(words, 2)).map((x) => x.text), ["the", "plan"]);
});

test("never cuts inside a word", () => {
  const words = [w("one", 0.1, 0.4), w("uh", 0.5, 0.7), w("two", 0.72, 1.1), w("three", 2.5, 3.0), w("four", 3.02, 3.4)];
  const segs = planCuts(words, 4);
  for (const word of words) {
    for (const s of segs) {
      const inside = word.start >= s.start - 1e-9 && word.end <= s.end + 1e-9;
      const outside = word.end <= s.start + 1e-9 || word.start >= s.end - 1e-9;
      assert.ok(inside || outside, `${word.text} split by ${JSON.stringify(s)}`);
    }
  }
});

test("remapped times are on the edited timeline", () => {
  const words = [w("a", 0, 0.5), w("b", 3.0, 3.5)];
  const out = remapWords(words, planCuts(words, 4));
  assert.ok(out[0].start < 0.1);
  assert.ok(out[1].start < 1.0 && out[1].start > out[0].end, JSON.stringify(out));
});

test("no words keeps whole clip", () => {
  assert.deepEqual(planCuts([], 12), [{ start: 0, end: 12 }]);
});

test("a clip of only fillers keeps the whole clip", () => {
  assert.deepEqual(planCuts([w("um", 0.2, 0.5)], 5), [{ start: 0, end: 5 }]);
});
