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

const stopRule = { when: { label: "hook", is: "not_working", thresholdPct: 20, minVideos: 3, age: "72h", scope: "campaign" }, then: { kind: "stop_using" } };
const makeRule = { when: { label: "hook", is: "working", thresholdPct: 70, minVideos: 3, age: "72h", scope: "campaign" }, then: { kind: "make", count: 2, keep: ["hook"], vary: ["angle"], post: false } };

test("an AI rule is accepted", async () => {
  const f = fake({ lines: [{ index: 0, day: null, instruction: null, rule: stopRule }] });
  const r = await translateCampaign({ ai: f.ai }, "Cut the losers alpha.", vocab);
  assert.equal(r.compiled.rules.length, 1);
  assert.equal(r.compiled.rules[0].source, "Cut the losers alpha");
  assert.deepEqual(r.couldNotUnderstand, []);
});

test("a make rule with no named CTA drops only the make rule, not an unrelated stop_using rule", async () => {
  const f = fake({ lines: [{ index: 0, day: null, instruction: null, rule: stopRule }, { index: 1, day: null, instruction: null, rule: makeRule }] });
  const r = await translateCampaign({ ai: f.ai }, "Cut the losers alpha. Clone winners beta.", vocab);
  assert.equal(r.compiled.rules.length, 1);
  assert.equal(r.compiled.rules[0].then.kind, "stop_using");
  assert.deepEqual(r.couldNotUnderstand, ["Clone winners beta"]);
});

test("a day the line didn't name is never taken from the AI", async () => {
  const f = fake({ lines: [{ index: 0, day: "wed", instruction: make(), rule: null }] });
  const r = await translateCampaign({ ai: f.ai }, "Do the thing alpha.", vocab);
  assert.equal(r.compiled.days.wed.length, 0);
  assert.deepEqual(r.couldNotUnderstand, ["Do the thing alpha"]);
});

test("a bad instruction doesn't drop the good rule on the same line", async () => {
  const f = fake({ lines: [{ index: 0, day: null, instruction: make({ style: "nope" }), rule: stopRule }] });
  const r = await translateCampaign({ ai: f.ai }, "Monday: mixed alpha.", vocab);
  assert.equal(r.compiled.days.mon.length, 0);
  assert.equal(r.compiled.rules.length, 1);
  assert.deepEqual(r.couldNotUnderstand, []);
});

test("malformed or empty answers report every unread line", async () => {
  for (const answer of [{ lines: [] }, { lines: "x" }, {}, null, { lines: [null, { index: 9 }, { index: "0" }] }]) {
    const r = await translateCampaign({ ai: fake(answer).ai }, "Monday: alpha. Tuesday: beta.", vocab);
    assert.deepEqual(r.couldNotUnderstand, ["Monday: alpha", "Tuesday: beta"]);
  }
});

test("out-of-order answers merge in unread order, over several drop passes", async () => {
  const f = fake({ lines: [
    { index: 3, day: null, instruction: make({ count: 4 }), rule: null },
    { index: 1, day: null, instruction: make({ cta: { pick: "named", id: 999 } }), rule: null },
    { index: 0, day: null, instruction: make({ count: 1 }), rule: null },
    { index: 2, day: null, instruction: make({ style: "nope" }), rule: null },
  ] });
  const r = await translateCampaign({ ai: f.ai }, "Monday: a1. Monday: b2. Monday: c3. Monday: d4.", vocab);
  assert.deepEqual(r.compiled.days.mon.map((i) => i.source), ["Monday: a1", "Monday: d4"]);
  assert.deepEqual(r.couldNotUnderstand, ["Monday: b2", "Monday: c3"]);
});
