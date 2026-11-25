import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Question } from "../src/ai/providers.ts";
import {
  cachedSlideshowPlan, fallbackSlides, layoutSlides, planSlideshow, targetDuration, validateSlides, type PlanInput, type SlideAsset,
} from "../src/edit/slideshow/plan.ts";
import { tmp } from "./helpers.ts";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({ instructions: "", context: "", words: [], durationSec: null, musicSec: null, assets: [], ...over });
const asset = (index: number, name = `pic${index}.png`): SlideAsset => ({ index, kind: "image", path: `/p/${name}`, name, durationSec: null });
const card = (seconds: number) => ({ asset: null, seconds, title: "t", body: "" });

test("targetDuration", () => {
  assert.equal(targetDuration({ durationSec: 23.4, musicSec: 10 }, 3), 23.4);
  assert.equal(targetDuration({ durationSec: null, musicSec: 10 }, 5), 10);
  assert.equal(targetDuration({ durationSec: null, musicSec: 5 }, 2), 6);
  assert.equal(targetDuration({ durationSec: null, musicSec: null }, 1), 6);
  assert.equal(targetDuration({ durationSec: null, musicSec: null }, 40), 90);
});

test("layoutSlides scales to the total within 2 to 8 seconds and ends exactly on it", () => {
  assert.deepEqual(layoutSlides([card(4), card(4), card(4)], 9).map((s) => s.end), [3, 6, 9]);
  const two = layoutSlides([card(1), card(20)], 10);
  assert.equal(two.at(-1)!.end, 10);
  for (const s of two) assert.ok(s.end - s.start >= 2 && s.end - s.start <= 8, `${s.start}-${s.end}`);
  assert.equal(layoutSlides(Array.from({ length: 10 }, () => card(4)), 6).length, 3);
  assert.deepEqual(layoutSlides([], 10), []);
});

test("validateSlides appends unused assets, flags bad indexes and trims long text", () => {
  const i = input({ assets: [asset(0), asset(1)] });
  const unused = validateSlides({ slides: [{ asset: 0, seconds: 4, title: "a", body: "" }] }, i);
  assert.deepEqual(unused.slides.map((s) => s.asset), [0, 1]);
  assert.ok(unused.problems.some((p) => /never shown/.test(p)));
  const bad = validateSlides({ slides: [{ asset: 9, seconds: 4, title: "a", body: "" }, { asset: 0, seconds: 4, title: "", body: "" }, { asset: 1, seconds: 4, title: "", body: "" }] }, i);
  assert.ok(bad.problems.some((p) => /asset 9/.test(p)));
  assert.equal(bad.slides[0].asset, null);
  const long = validateSlides({ slides: [{ asset: -1, seconds: 4, title: "x".repeat(200), body: "" }] }, input());
  assert.equal(long.slides[0].title.length, 60);
  assert.ok(long.slides[0].title.endsWith("…"));
  assert.deepEqual(validateSlides("nonsense", input()).slides, []);
});

test("fallbackSlides: a card per sentence, or a slide per asset", () => {
  const cards = fallbackSlides(input({ instructions: "First tip. Second tip!" }));
  assert.deepEqual(cards.map((s) => [s.asset, s.title]), [[null, "First tip"], [null, "Second tip"]]);
  assert.equal(fallbackSlides(input())[0].title, "Slideshow");
  const pics = fallbackSlides(input({ assets: [asset(0, "beach.png"), asset(1), asset(2)] }));
  assert.deepEqual(pics.map((s) => s.asset), [0, 1, 2]);
  assert.equal(pics[0].title, "beach");
  const withText = fallbackSlides(input({ assets: [asset(0)], instructions: "hello" }));
  assert.equal(withText[0].title, "");
  const narrated = fallbackSlides(input({ assets: [asset(0), asset(1)], durationSec: 16 }));
  assert.equal(narrated.length, 4);
  assert.deepEqual(narrated.map((s) => s.asset), [0, 1, 0, 1]);
  assert.equal(narrated.at(-1)!.end, 16);
});

test("planSlideshow: no AI falls back with a note; a good answer is used", async () => {
  const none = await planSlideshow(input({ instructions: "A. B." }), { ask: async () => { throw new Error("no AI provider is connected"); } });
  assert.equal(none.source, "fallback");
  assert.deepEqual(none.notes, ["no AI connected: slides laid out in order"]);
  const down = await planSlideshow(input({ instructions: "A. B." }), { ask: async () => { throw new Error("timed out"); } });
  assert.deepEqual(down.notes, ["the AI didn't answer: slides laid out in order"]);

  let asked: Question | undefined;
  const ai = await planSlideshow(input({ assets: [asset(0), asset(1)], instructions: "beach day", context: "brand: Acme" }), {
    ask: async <T>(q: Question) => { asked = q; return { slides: [{ asset: 0, seconds: 5, title: "Sand", body: "" }, { asset: 1, seconds: 5, title: "Sea", body: "" }] } as T; },
  });
  assert.equal(ai.source, "ai");
  assert.equal(ai.slides.at(-1)!.end, targetDuration({ durationSec: null, musicSec: null }, 2));
  assert.equal(ai.durationSec, ai.slides.at(-1)!.end);
  assert.equal(asked!.effort, "medium");
  assert.match(asked!.prompt, /0: image "pic0\.png"/);
  assert.match(asked!.prompt, /brand: Acme/);
});

test("planSlideshow asks once more with the problems", async () => {
  const prompts: string[] = [];
  const answers = [{ slides: [{ asset: 7, seconds: 4, title: "a", body: "" }] }, { slides: [{ asset: 0, seconds: 4, title: "a", body: "" }] }];
  const plan = await planSlideshow(input({ assets: [asset(0)] }), { ask: async (q: Question) => { prompts.push(q.prompt); return answers.shift() as any; } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /asset 7/);
  assert.equal(plan.source, "ai");
  assert.equal(plan.slides[0].asset, 0);
});

test("cachedSlideshowPlan saves AI plans and not fallback ones", async () => {
  const dir = tmp();
  const ai = { slides: [], durationSec: 6, source: "ai" as const, notes: [] };
  const fb = { slides: [], durationSec: 6, source: "fallback" as const, notes: ["x"] };
  const a = join(dir, "a.json"), b = join(dir, "b.json");
  await cachedSlideshowPlan(a, async () => ai);
  await cachedSlideshowPlan(b, async () => fb);
  assert.ok(existsSync(a));
  assert.ok(!existsSync(b));
  assert.equal((await cachedSlideshowPlan(a, async () => { throw new Error("not called"); })).source, "ai");
});
