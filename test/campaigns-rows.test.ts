import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRows, parseRows, rowIssues } from "../src/campaigns/rows.ts";
import type { Vocabulary } from "../src/campaigns/spec.ts";

const vocab: Vocabulary = {
  styles: [{ id: "Fancy", token: "fancy" }], types: [], hooks: [], angles: [], ctas: [], looks: [{ key: "lemo:ukiyo-e" }],
} as Vocabulary;
const pick = { pick: "random" };
const agent = (over: Record<string, unknown> = {}) => ({
  id: 1, quantity: 1, hook: pick, angle: pick, cta: pick, style: null, type: null, time: "18:00", days: ["tue"], sec: 30,
  origin: "agent", look: "lemo:ukiyo-e", text: "make it moody", ...over,
});
const rows = (raw: unknown[], v = vocab) => {
  const r = parseRows(raw, v);
  assert.ok(r.ok, r.ok ? "" : r.problems.join("; "));
  return r.ok ? r.value : [];
};

test("an agent row compiles to a make instruction with its look", () => {
  const c = compileRows(rows([agent()]), vocab);
  const ins = c.days.tue[0] as any;
  assert.equal(ins.kind, "make");
  assert.equal(ins.look, "lemo:ukiyo-e");
  assert.equal(ins.style, null);
  assert.deepEqual(ins.post, { at: "18:00" });
  assert.equal(ins.instructions, "make it moody");
});

test("rowIssues for agent rows", () => {
  assert.ok(rowIssues(rows([agent({ look: null })])[0]).includes("no look"));
  const [gone] = rows([agent({ look: "lemo:old" })], { ...vocab, looks: [{ key: "lemo:old" }] });
  assert.deepEqual(rowIssues(gone, vocab), ["look no longer in the catalogue"]);
  assert.deepEqual(rowIssues(gone), []);
  assert.deepEqual(compileRows([gone], vocab).days.tue, []);
  assert.ok(rowIssues(rows([agent({ sec: null })])[0]).includes("no length"));
});

test("style null is only for agent rows", () => {
  const r = parseRows([agent({ origin: "create", look: null })], vocab);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problems.some((p) => /style must be one of/.test(p)));
  const bad = parseRows([agent({ style: "nope" })], vocab);
  assert.equal(bad.ok, false);
});

test("rows saved before looks existed still parse", () => {
  const old: Record<string, unknown> = agent({ origin: "create", style: "Fancy" });
  delete old.look;
  const [r] = rows([old]);
  assert.equal(r.look, null);
});
