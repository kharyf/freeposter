import assert from "node:assert/strict";
import { test } from "node:test";
import { OverBudget } from "../src/ai/budget.ts";
import { translateCampaign } from "../src/campaigns/translate.ts";
import { parseCompiled, type Vocabulary } from "../src/campaigns/spec.ts";
import type { Question } from "../src/ai/providers.ts";

const entry = (id: number, kind: "hook" | "angle" | "cta", name: string) => ({ id, kind, name, text: "secret body", keywords: [], url: "https://x.test", createdAt: 0 });
const vocab: Vocabulary = {
  styles: [{ id: "basic", token: "Basic" }, { id: "fancy", token: "Fancy" }],
  types: [{ id: 1, name: "Clip" }],
  hooks: [entry(1, "hook", "Stop Scrolling")],
  angles: [entry(10, "angle", "Myth Bust")],
  ctas: [entry(20, "cta", "Free Guide")],
};
const make = (over: object = {}) => ({
  kind: "make", count: 2, style: "basic", hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "named", id: 20 },
  types: [], post: null, source: "ignored", ...over,
});
const fake = (answer: unknown) => {
  const calls: Question[] = [];
  return { calls, ai: { ask: async (_job: string, q: Question) => { calls.push(q); if (answer instanceof Error) throw answer; return answer; } } as never };
};
const GOOD = "On Sunday make and post 2 Basic videos with Stop Scrolling hook, Myth Bust angle, and Free Guide cta.";

test("no AI call when every line parses", async () => {
  const f = fake({ lines: [] });
  const r = await translateCampaign({ ai: f.ai }, GOOD, vocab);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(r.couldNotUnderstand, []);
  assert.equal(r.compiled.days.sun.length, 1);
});

test("three unread lines make exactly one call and merge the answers", async () => {
  const text = "Sunday: do the thing alpha. Monday: do the thing beta. Tuesday: do the thing gamma.";
  const f = fake({ lines: [
    { index: 0, day: "sun", instruction: make(), rule: null },
    { index: 1, day: null, instruction: make(), rule: null },
    { index: 2, day: "tue", instruction: null, rule: null },
  ] });
  const r = await translateCampaign({ ai: f.ai }, text, vocab);
  assert.equal(f.calls.length, 1);
  const prompt = f.calls[0].system + f.calls[0].prompt;
  assert.ok(prompt.includes("Stop Scrolling") && !prompt.includes("secret body") && !prompt.includes("x.test"));
  assert.ok(prompt.includes("alpha") && prompt.includes("gamma"));
  assert.equal(r.compiled.days.sun.length, 1);
  assert.equal(r.compiled.days.sun[0].source, "Sunday: do the thing alpha");
  assert.equal(r.compiled.days.mon.length, 1);
  assert.equal(r.couldNotUnderstand.length, 1);
  assert.ok(parseCompiled(r.compiled, vocab).ok);
});

test("an invented CTA id is dropped to couldNotUnderstand, plain items survive", async () => {
  const text = `${GOOD} Monday: do the thing alpha.`;
  const f = fake({ lines: [{ index: 0, day: "mon", instruction: make({ cta: { pick: "named", id: 999 } }), rule: null }] });
  const r = await translateCampaign({ ai: f.ai }, text, vocab);
  assert.equal(r.compiled.days.mon.length, 0);
  assert.equal(r.compiled.days.sun.length, 1);
  assert.deepEqual(r.couldNotUnderstand, ["Monday: do the thing alpha"]);
});

test("OverBudget, a failure, or no AI reports every unread line", async () => {
  const text = `${GOOD} Monday: do alpha. Tuesday: do beta.`;
  for (const ai of [fake(new OverBudget()).ai, fake(new Error("boom")).ai, null]) {
    const r = await translateCampaign({ ai }, text, vocab);
    assert.deepEqual(r.couldNotUnderstand, ["Monday: do alpha", "Tuesday: do beta"]);
    assert.equal(r.compiled.days.sun.length, 1);
  }
});
