import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { budget, OverBudget, todayUse } from "../src/ai/budget.ts";
import { AiService } from "../src/ai/router.ts";
import { newStore } from "./helpers.ts";

const q = { system: "s", prompt: "p", schema: { type: "object" } };
const use = (store: ReturnType<typeof newStore>, job: string, n: number, extra: { promptTokens?: number; completionTokens?: number; ok?: boolean } = {}) => {
  for (let i = 0; i < n; i++) store.recordAiUse({ provider: "claude", job, ok: extra.ok ?? true, promptTokens: extra.promptTokens, completionTokens: extra.completionTokens });
};
// With nothing connected `ask` fails after the budget check, which tells "allowed" (not OverBudget) from "refused".
const outcome = async (ai: AiService, job: "campaign" | "script" | "label" | "caption") => {
  try { await ai.ask(job, q); return "answered"; } catch (e) { return e instanceof OverBudget ? "over" : "allowed"; }
};

test("defaults are 50 calls and 200k tokens, and prefs override them", () => {
  const store = newStore();
  assert.deepEqual(budget(store), { calls: 50, tokens: 200_000 });
  store.setPref("ai.budget.calls", 3);
  store.setPref("ai.budget.tokens", 1000);
  assert.deepEqual(budget(store), { calls: 3, tokens: 1000 });
});

test("the 50th budgeted call is allowed and the 51st is refused; caption never is", async () => {
  const store = newStore();
  store.setPref("ai.providers", {});
  const ai = new AiService(store);
  use(store, "campaign", 49);
  assert.equal(await outcome(ai, "script"), "allowed");
  use(store, "label", 1, { ok: false }); // failed attempts count too
  assert.equal(await outcome(ai, "script"), "over");
  assert.equal(await outcome(ai, "campaign"), "over");
  assert.equal(await outcome(ai, "caption"), "allowed");
  use(store, "caption", 100);
  assert.equal(await outcome(ai, "caption"), "allowed");
  assert.deepEqual(todayUse(store).budgeted, { calls: 50, tokens: 0 });
  assert.equal(todayUse(store).all.calls, 150);
});

test("the token ceiling trips with fewer calls; unreported tokens count only as calls", async () => {
  const store = newStore();
  store.setPref("ai.providers", {});
  const ai = new AiService(store);
  use(store, "script", 2, { promptTokens: 90_000, completionTokens: 5_000 });
  use(store, "label", 3);
  assert.deepEqual(todayUse(store).budgeted, { calls: 5, tokens: 190_000 });
  assert.equal(await outcome(ai, "label"), "allowed");
  use(store, "label", 1, { promptTokens: 10_000 });
  assert.equal(await outcome(ai, "label"), "over");
});

test("the day rolls over at local midnight", () => {
  const store = newStore();
  use(store, "campaign", 4);
  const now = Date.now();
  assert.equal(todayUse(store, now).budgeted.calls, 4);
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const tomorrow = midnight.getTime() + 25 * 3600_000;
  const t = new Date(tomorrow); t.setHours(0, 0, 0, 0);
  assert.equal(todayUse(store, t.getTime() + 1).budgeted.calls, 0);
  assert.equal(todayUse(store, t.getTime() - 1).budgeted.calls, 4);
});
