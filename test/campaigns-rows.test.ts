import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compileRows, isClaudeModel, isLemo, migrateRow, parseRows, rowIssues, type Row } from "../src/campaigns/rows.ts";
import type { Vocabulary } from "../src/campaigns/spec.ts";

const vocab: Vocabulary = {
  styles: [{ id: "Fancy", token: "fancy" }], types: [], hooks: [], angles: [], ctas: [], looks: [{ key: "lemo:ukiyo-e" }],
} as Vocabulary;
const pick = { pick: "random" };
const agent = (over: Record<string, unknown> = {}) => ({
  id: 1, quantity: 1, hook: pick, angle: pick, cta: pick, style: "lemo:ukiyo-e", model: null, type: null, time: "18:00", days: ["tue"], sec: 30,
  origin: "agent", text: "make it moody", ...over,
});
const create = (over: Record<string, unknown> = {}) => agent({ origin: "create", style: "Fancy", text: "", ...over });
const drive = (over: Record<string, unknown> = {}) => agent({ origin: "drive", style: "Fancy", text: "Clip", ...over });
const rows = (raw: unknown[], v = vocab) => {
  const r = parseRows(raw, v);
  assert.ok(r.ok, r.ok ? "" : r.problems.join("; "));
  return r.ok ? r.value : [];
};
/** The row's issues with this vocabulary, after checking it is left out of the schedule because of them. */
const issues = (raw: Record<string, unknown>, v: Vocabulary = vocab): string[] => {
  const [r] = rows([raw], { ...vocab, ...v });
  const out = rowIssues(r, v);
  if (out.length) assert.deepEqual(compileRows([r], v).days.tue, [], "left out of the schedule");
  return out;
};

test("isLemo and isClaudeModel", () => {
  assert.equal(isLemo("lemo:ukiyo-e"), true);
  assert.equal(isLemo("Fancy"), false);
  assert.equal(isLemo(null), false);
  assert.equal(isClaudeModel("claude:claude-opus-5-5"), true);
  assert.equal(isClaudeModel("openrouter:anthropic/claude-opus"), false);
  assert.equal(isClaudeModel(null), false);
});

test("an agent row compiles to a make instruction with its look", () => {
  const c = compileRows(rows([agent()]), vocab);
  const ins = c.days.tue[0] as any;
  assert.equal(ins.kind, "make");
  assert.equal(ins.look, "lemo:ukiyo-e");
  assert.equal(ins.style, null);
  assert.deepEqual(ins.post, { at: "18:00" });
  assert.equal(ins.instructions, "make it moody");
});

test("an Agent row compiles with no scripted flag", () => {
  const ins = compileRows(rows([agent()]), vocab).days.tue[0] as any;
  assert.equal("scripted" in ins, false);
  assert.equal("model" in ins, false, "a null model compiles with no model");
  const withModel = compileRows(rows([agent({ model: "claude:claude-sonnet-5-5" })]), vocab).days.tue[0] as any;
  assert.equal(withModel.model, "claude:claude-sonnet-5-5");
  assert.equal("scripted" in withModel, false);
});

test("an old agent row with a look parses with the look as its style, and warns", () => {
  const old: Record<string, unknown> = agent({ style: null, look: "lemo:ukiyo-e" });
  delete old.model;
  const r = parseRows([old], vocab);
  assert.ok(r.ok, r.ok ? "" : r.problems.join("; "));
  if (!r.ok) return;
  assert.equal(r.value[0].style, "lemo:ukiyo-e");
  assert.equal(r.value[0].model, null);
  assert.equal("look" in r.value[0], false);
  assert.deepEqual(r.warnings, ['row 1: "look" is now part of "style"; send the Lemo style as style']);
  assert.deepEqual(parseRows([agent()], vocab), { ok: true, value: rows([agent()]), warnings: [] });
});

test("migrateRow is idempotent and drops look", () => {
  const old = { ...agent({ style: "basic", look: "lemo:ukiyo-e" }) } as Record<string, unknown>;
  delete old.model;
  const once = migrateRow(old);
  assert.equal(once.style, "lemo:ukiyo-e");
  assert.equal(once.model, null);
  assert.equal("look" in once, false);
  assert.deepEqual(migrateRow(once), once);
  const plain = migrateRow({ ...create(), look: null, model: "claude:claude-opus-5-5" });
  assert.equal(plain.style, "Fancy");
  assert.equal(plain.model, "claude:claude-opus-5-5");
  assert.equal("look" in plain, false);
});

test("a Create row with a Lemo style compiles to a scripted make with the look and model", () => {
  const ins = compileRows(rows([create({ style: "lemo:ukiyo-e", model: "claude:claude-sonnet-5-5" })]), vocab).days.tue[0] as any;
  assert.equal(ins.kind, "make");
  assert.deepEqual({ style: ins.style, look: ins.look, scripted: ins.scripted, model: ins.model }, { style: null, look: "lemo:ukiyo-e", scripted: true, model: "claude:claude-sonnet-5-5" });
});

test("a Create row with a FreePoster style and a model compiles with the model", () => {
  const ins = compileRows(rows([create({ model: "chatgpt:default" })]), vocab).days.tue[0] as any;
  assert.equal(ins.style, "Fancy");
  assert.equal(ins.model, "chatgpt:default");
  assert.equal("look" in ins, false);
  assert.equal("scripted" in ins, false);
  const none = compileRows(rows([create()]), vocab).days.tue[0] as any;
  assert.equal("model" in none, false);
});

test("a model of an unknown provider is refused", () => {
  for (const model of ["acme:x", "claude", "claude:", "Claude:x", "claude:has space", 7]) {
    const r = parseRows([create({ model })], vocab);
    assert.equal(r.ok, false, String(model));
    assert.ok(!r.ok && r.problems.some((p) => /model/.test(p)), String(model));
  }
  assert.ok(parseRows([create({ model: "openrouter:anthropic/claude-opus" })], vocab).ok);
});

test("issue: an Agent row with no style", () => {
  assert.deepEqual(issues(agent({ style: null })), ["no editing style"]);
});

test("issue: an Agent row needs a Lemo style", () => {
  assert.deepEqual(issues(agent({ style: "Fancy" })), ["an Agent row needs a Lemo style"]);
});

test("issue: an Agent row needs a Claude model", () => {
  assert.deepEqual(issues(agent({ model: "openrouter:anthropic/claude-opus" })), ["an Agent row needs a Claude model"]);
  assert.deepEqual(issues(agent({ model: "claude:claude-opus-5-5" })), []);
});

test("issue: Lemo styles need a Claude model", () => {
  assert.deepEqual(issues(create({ style: "lemo:ukiyo-e" })), ["Lemo styles need a Claude model"]);
  assert.deepEqual(issues(create({ style: "lemo:ukiyo-e", model: "chatgpt:default" })), ["Lemo styles need a Claude model"]);
});

test("issue: Drive videos can't use a Lemo style", () => {
  assert.deepEqual(issues(drive({ style: "lemo:ukiyo-e" })), ["Drive videos can't use a Lemo style"]);
});

test("issue: Lemo-Opuscar isn't installed on this computer", () => {
  assert.deepEqual(issues(agent(), { ...vocab, looks: [] }), ["Lemo-Opuscar isn't installed on this computer"]);
});

test("issue: a Lemo style no longer in Lemo-Opuscar", () => {
  const [gone] = rows([agent({ style: "lemo:old" })]);
  assert.deepEqual(rowIssues(gone, vocab), ["lemo:old is no longer in Lemo-Opuscar"]);
  assert.deepEqual(rowIssues(gone), [], "without a vocabulary the catalogue isn't checked");
  assert.deepEqual(compileRows([gone], vocab).days.tue, []);
});

test("issue: a model that isn't available", () => {
  const v = { ...vocab, models: ["claude:claude-opus-5-5"] };
  assert.deepEqual(issues(create({ model: "chatgpt:default" }), v), ["chatgpt:default isn't available; pick another model"]);
  assert.deepEqual(issues(agent({ model: "claude:claude-sonnet-5-5" }), v), ["claude:claude-sonnet-5-5 isn't available; pick another model"]);
  assert.deepEqual(issues(create({ model: "claude:claude-opus-5-5" }), v), []);
  assert.deepEqual(issues(create({ model: null }), v), []);
  assert.deepEqual(issues(create({ model: "chatgpt:default" })), [], "without models the availability isn't checked");
});

test("rowIssues for agent rows", () => {
  assert.ok(rowIssues(rows([agent({ sec: null })])[0]).includes("no length"));
});

test("style null is only for agent rows", () => {
  const r = parseRows([create({ style: null })], vocab);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.problems.some((p) => /style must be one of/.test(p)));
  const bad = parseRows([agent({ style: "nope" })], vocab);
  assert.equal(bad.ok, false);
});

test("rows saved before looks and models existed still parse", () => {
  const old: Record<string, unknown> = create();
  delete old.model;
  const [r] = rows([old]);
  assert.equal(r.model, null);
  assert.equal((r as Row & { look?: unknown }).look, undefined);
});
