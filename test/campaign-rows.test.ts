import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { rowIssues as serverRowIssues, type Row } from "../src/campaigns/rows.ts";
import type { Vocabulary } from "../src/campaigns/spec.ts";

const g: any = { structuredClone };
vm.runInNewContext(readFileSync("public/campaign-rows.js", "utf8"), g);
const R = g.FreePosterRows;
/** Results come from another realm, so compare them as plain JSON. */
const j = (x: unknown) => JSON.parse(JSON.stringify(x));

const lemo = (key: string, name: string, category: string) => ({ key, name, description: `about ${name}`, category, needsImageGen: false });
const ctx = (over: any = {}) => ({
  styles: [{ id: "bold", name: "Bold" }, { id: "calm", name: "Calm" }],
  lemo: [lemo("lemo:ukiyo-e", "Ukiyo-e", "Painting"), lemo("lemo:impasto", "Impasto", "Painting"), lemo("lemo:teardown", "Teardown", "Explainer")],
  lemoInstalled: true,
  models: [
    { provider: "claude", label: "Claude", models: [{ id: "claude:claude-opus-5-5", name: "Opus 5.5" }, { id: "claude:claude-sonnet-5-5", name: "Sonnet 5.5" }] },
    { provider: "openrouter", label: "OpenRouter", models: [{ id: "openrouter:anthropic/claude-x", name: "Claude X" }] },
  ],
  defaultClaude: "claude:claude-opus-5-5",
  ...over,
});
const row = (over: any = {}) => ({
  id: 1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, style: "bold", type: null, time: "09:00",
  days: ["Monday"], sec: 30, origin: "create", model: null, text: "", ...over,
});
const change = (r: any, f: string, v: any, c = ctx()) => j(R.applyChange(r, f, v, c));
const OPUS = "claude:claude-opus-5-5";

test("isLemo and isClaudeModel", () => {
  assert.equal(R.isLemo("lemo:x"), true);
  assert.equal(R.isLemo("bold"), false);
  assert.equal(R.isLemo(null), false);
  assert.equal(R.isClaudeModel(OPUS), true);
  assert.equal(R.isClaudeModel("openrouter:anthropic/claude-x"), false);
  assert.equal(R.isClaudeModel(null), false);
});

test("the Model column shows only when a row is Create or Agent", () => {
  assert.equal(R.showModelColumn([row({ origin: "drive" })]), false);
  assert.equal(R.showModelColumn([]), false);
  assert.equal(R.showModelColumn([row({ origin: "drive" }), row({ origin: "create" })]), true);
  assert.equal(R.showModelColumn([row({ origin: "agent" })]), true);
});

test("a Drive row offers only FreePoster edits", () => {
  const out = j(R.styleGroups(row({ origin: "drive" }), ctx()));
  assert.deepEqual(out, [{ label: "FreePoster edits", options: [{ value: "bold", label: "Bold" }, { value: "calm", label: "Calm" }] }]);
});

test("a Create row with Claude lists Lemo styles by category, sorted by name", () => {
  const out = j(R.styleGroups(row({ model: OPUS }), ctx()));
  assert.deepEqual(out.map((x: any) => x.label), ["FreePoster edits", "Lemo-Opuscar films (Claude): Explainer", "Lemo-Opuscar films (Claude): Painting"]);
  assert.deepEqual(out[2].options, [
    { value: "lemo:impasto", label: "Impasto", title: "about Impasto" },
    { value: "lemo:ukiyo-e", label: "Ukiyo-e", title: "about Ukiyo-e" },
  ]);
});

test("a non-Claude Create row shows Lemo styles disabled under \"need a Claude model\"", () => {
  const out = j(R.styleGroups(row({ model: "openrouter:anthropic/claude-x" }), ctx()));
  assert.equal(out[1].label, "Lemo-Opuscar films: need a Claude model on Claude Code: Explainer");
  for (const grp of out.slice(1)) for (const o of grp.options) assert.equal(o.disabled, true);
  assert.equal(out[0].options.some((o: any) => o.disabled), false);
});

test("Lemo styles without a category go in an unsuffixed group after the categorised ones", () => {
  const c = ctx({ lemo: [lemo("lemo:loose", "Loose", null as unknown as string), lemo("lemo:teardown", "Teardown", "Explainer")] });
  const on = j(R.styleGroups(row({ model: OPUS }), c));
  assert.deepEqual(on.map((x: any) => x.label), ["FreePoster edits", "Lemo-Opuscar films (Claude): Explainer", "Lemo-Opuscar films (Claude)"]);
  assert.deepEqual(on[2].options, [{ value: "lemo:loose", label: "Loose", title: "about Loose" }]);
  const off = j(R.styleGroups(row({ model: "openrouter:anthropic/claude-x" }), c));
  assert.deepEqual(off.map((x: any) => x.label).slice(1), ["Lemo-Opuscar films: need a Claude model on Claude Code: Explainer", "Lemo-Opuscar films: need a Claude model on Claude Code"]);
});

test("an Agent row offers only Lemo styles and only Claude models", () => {
  const a = row({ origin: "agent", style: null, model: "openrouter:anthropic/claude-x" });
  const out = j(R.styleGroups(a, ctx()));
  assert.deepEqual(out.map((x: any) => x.label), ["Lemo-Opuscar films (Claude): Explainer", "Lemo-Opuscar films (Claude): Painting"]);
  assert.equal(out.some((x: any) => x.options.some((o: any) => o.disabled)), false);
  const m = j(R.modelOptions(row({ origin: "agent", model: null }), ctx()));
  assert.deepEqual(m[0].options, [{ value: "", label: "Default (Claude Code's setting)" }]);
  assert.deepEqual(m.slice(1).map((x: any) => x.label), ["Claude"]);
});

test("a Create row's models: Use AI settings, then each connected provider", () => {
  const m = j(R.modelOptions(row(), ctx()));
  assert.deepEqual(m[0].options, [{ value: "", label: "Use AI settings" }]);
  assert.deepEqual(m.slice(1).map((x: any) => x.label), ["Claude", "OpenRouter"]);
  assert.deepEqual(m[1].options[0], { value: OPUS, label: "Opus 5.5" });
});

test("a model no longer available stays selected and is flagged", () => {
  const m = j(R.modelOptions(row({ model: "claude:gone" }), ctx()));
  const last = m[m.length - 1].options.at(-1);
  assert.equal(last.value, "claude:gone");
  assert.equal(last.label, "claude:gone (not available)");
  assert.deepEqual(j(R.rowIssues(row({ model: "claude:gone" }), ctx())), ["claude:gone isn't available; pick another model"]);
});

test("a style that is gone stays in the list, flagged", () => {
  const f = j(R.styleGroups(row({ style: "old" }), ctx())).flatMap((x: any) => x.options).at(-1);
  assert.equal(f.value, "old");
  assert.equal(f.label, "old (gone)");
  const l = j(R.styleGroups(row({ style: "lemo:nope", model: OPUS }), ctx())).flatMap((x: any) => x.options).at(-1);
  assert.equal(l.label, "lemo:nope (no longer in Lemo-Opuscar)");
});

test("an empty catalogue gives one disabled option", () => {
  const a = j(R.styleGroups(row({ origin: "agent", style: null }), ctx({ lemo: [], lemoInstalled: false })));
  assert.deepEqual(a, [{ label: "Lemo-Opuscar films", options: [{ value: "", label: "Lemo-Opuscar isn't installed on this computer", disabled: true }] }]);
  const b = j(R.styleGroups(row({ origin: "agent", style: null }), ctx({ lemo: [] })));
  assert.equal(b[0].options[0].label, "No Lemo styles found");
});

test("picking a Lemo style with Use AI settings switches to the default Claude model and flashes it", () => {
  const r = change(row(), "style", "lemo:ukiyo-e");
  assert.equal(r.row.style, "lemo:ukiyo-e");
  assert.equal(r.row.model, OPUS);
  assert.equal(r.flash, "model");
});

test("picking a Lemo style keeps an explicit model; a FreePoster style changes nothing else", () => {
  const a = change(row({ model: "openrouter:anthropic/claude-x" }), "style", "lemo:ukiyo-e");
  assert.equal(a.row.model, "openrouter:anthropic/claude-x");
  assert.equal(a.flash, undefined);
  const b = change(row(), "style", "calm");
  assert.equal(b.row.model, null);
  assert.equal(b.flash, undefined);
});

test("switching to Agent with a non-Claude model switches to the default Claude model and flashes it", () => {
  const r = change(row({ model: "openrouter:anthropic/claude-x", style: "lemo:ukiyo-e" }), "origin", "agent");
  assert.equal(r.row.model, OPUS);
  assert.equal(r.flash, "model");
  const keep = change(row({ model: null }), "origin", "agent");
  assert.equal(keep.row.model, null);
  assert.equal(keep.flash, undefined);
  assert.equal(change(row({ model: "claude:claude-sonnet-5-5" }), "origin", "agent").row.model, "claude:claude-sonnet-5-5");
});

test("Create → Drive → Create keeps the model and the Lemo style", () => {
  const start = row({ style: "lemo:ukiyo-e", model: "claude:claude-sonnet-5-5" });
  const drive = change(start, "origin", "drive").row;
  assert.equal(drive.style, "lemo:ukiyo-e");
  assert.equal(drive.model, "claude:claude-sonnet-5-5");
  const back = change(drive, "origin", "create").row;
  assert.equal(back.style, "lemo:ukiyo-e");
  assert.equal(back.model, "claude:claude-sonnet-5-5");
});

test("switching the model away from Claude keeps a Lemo style; an empty value means null", () => {
  const r = change(row({ style: "lemo:ukiyo-e", model: OPUS }), "model", "openrouter:anthropic/claude-x");
  assert.equal(r.row.style, "lemo:ukiyo-e");
  assert.equal(r.row.model, "openrouter:anthropic/claude-x");
  assert.equal(change(row({ model: "claude:x" }), "model", "").row.model, null);
});

test("applyChange returns a new row", () => {
  const r = row();
  const out = R.applyChange(r, "sec", 45, ctx());
  assert.notEqual(out.row, r);
  assert.equal(r.sec, 30);
  assert.equal(out.row.sec, 45);
});

test("rowIssues: the existing checks", () => {
  assert.deepEqual(j(R.rowIssues(row(), ctx())), []);
  assert.deepEqual(j(R.rowIssues(row({ days: [], sec: null }), ctx())), ["no days ticked", "no length"]);
  assert.deepEqual(j(R.rowIssues(row({ origin: "drive", text: " ", time: null, sec: null }), ctx())), ["no file name", "a Drive video needs a time"]);
});

test("rowIssues: the Lemo and model rules, with the server's texts", () => {
  const c = ctx();
  assert.deepEqual(j(R.rowIssues(row({ style: "lemo:ukiyo-e" }), c)), ["Lemo styles need a Claude model"]);
  assert.deepEqual(j(R.rowIssues(row({ style: "lemo:ukiyo-e", model: OPUS }), c)), []);
  assert.deepEqual(j(R.rowIssues(row({ origin: "drive", text: "f", style: "lemo:ukiyo-e" }), c)), ["Drive videos can't use a Lemo style"]);
  assert.deepEqual(j(R.rowIssues(row({ origin: "agent", style: null }), c)), ["no editing style"]);
  assert.deepEqual(j(R.rowIssues(row({ origin: "agent", style: "bold" }), c)), ["an Agent row needs a Lemo style"]);
  assert.deepEqual(j(R.rowIssues(row({ origin: "agent", style: "lemo:ukiyo-e", model: "openrouter:anthropic/claude-x" }), c)), ["an Agent row needs a Claude model"]);
  assert.deepEqual(j(R.rowIssues(row({ origin: "agent", style: "lemo:ukiyo-e", model: OPUS }), c)), []);
});

test("rowIssues: a Lemo style that left the catalogue, or no catalogue", () => {
  assert.deepEqual(j(R.rowIssues(row({ style: "lemo:nope", model: OPUS }), ctx())), ["lemo:nope is no longer in Lemo-Opuscar"]);
  assert.deepEqual(j(R.rowIssues(row({ style: "lemo:ukiyo-e", model: OPUS }), ctx({ lemo: [], lemoInstalled: false }))), ["Lemo-Opuscar isn't installed on this computer"]);
});

test("rowIssues: a Drive row's model is not checked", () => {
  assert.deepEqual(j(R.rowIssues(row({ origin: "drive", text: "f", model: "claude:gone" }), ctx())), []);
});

test("rowIssues: an empty catalogue is worded by whether Lemo-Opuscar is installed", () => {
  const r = row({ style: "lemo:ukiyo-e", model: OPUS });
  assert.deepEqual(j(R.rowIssues(r, ctx({ lemo: [], lemoInstalled: false }))), ["Lemo-Opuscar isn't installed on this computer"]);
  assert.deepEqual(j(R.rowIssues(r, ctx({ lemo: [], lemoInstalled: true }))), ["No Lemo styles found"]);
});

test("rowIssues: a catalogue filled by sync_looks runs Lemo rows even when the library isn't on this computer", () => {
  assert.deepEqual(j(R.rowIssues(row({ style: "lemo:ukiyo-e", model: OPUS }), ctx({ lemoInstalled: false }))), []);
  assert.deepEqual(j(R.rowIssues(row({ origin: "agent", style: "lemo:ukiyo-e" }), ctx({ lemoInstalled: false }))), []);
});

test("switching an Agent row with a Lemo style and the default model to Create picks the default Claude model", () => {
  const r = change(row({ origin: "agent", style: "lemo:ukiyo-e", model: null }), "origin", "create");
  assert.equal(r.row.origin, "create");
  assert.equal(r.row.model, OPUS);
  assert.equal(r.flash, "model");
  assert.deepEqual(j(R.rowIssues(r.row, ctx())), []);
  const plain = change(row({ origin: "agent", style: "bold", model: null }), "origin", "create");
  assert.equal(plain.row.model, null, "a FreePoster style keeps Use AI settings");
  assert.equal(plain.flash, undefined);
  const chosen = change(row({ origin: "agent", style: "lemo:ukiyo-e", model: "claude:claude-sonnet-5-5" }), "origin", "create");
  assert.equal(chosen.row.model, "claude:claude-sonnet-5-5", "a chosen model is kept");
  assert.equal(chosen.flash, undefined);
  // The add-row path makes its new Create row through the same change (copying the last row's Lemo style, no model).
  assert.equal(change(row({ style: "lemo:ukiyo-e", model: null }), "origin", "create").row.model, OPUS);
});

test("parity: the server's and the browser's rowIssues agree", () => {
  // lemoInstalled false: the browser words an empty catalogue as the server does (it refines it only when installed).
  const c = ctx({ lemoInstalled: false });
  const vocab = (over: Partial<Vocabulary> = {}): Vocabulary => ({
    styles: c.styles.map((s: any) => ({ id: s.id, token: s.id })), types: [], hooks: [], angles: [], ctas: [],
    looks: c.lemo.map((l: any) => ({ key: l.key })), models: c.models.flatMap((p: any) => p.models.map((m: any) => m.id)), ...over,
  });
  const cases: [string, any, any?][] = [
    ["runnable Create", row()],
    ["runnable Create with Lemo", row({ style: "lemo:ukiyo-e", model: OPUS })],
    ["runnable Agent", row({ origin: "agent", style: "lemo:impasto", model: null })],
    ["runnable Drive", row({ origin: "drive", text: "clip", model: "claude:gone" })],
    ["no days, no length", row({ days: [], sec: null })],
    ["Drive with nothing", row({ origin: "drive", text: " ", time: null, sec: null })],
    ["Lemo styles need a Claude model", row({ style: "lemo:ukiyo-e" })],
    ["Lemo with a non-Claude model", row({ style: "lemo:ukiyo-e", model: "openrouter:anthropic/claude-x" })],
    ["an Agent row needs a Lemo style", row({ origin: "agent", style: "bold" })],
    ["an Agent row needs a Claude model", row({ origin: "agent", style: "lemo:ukiyo-e", model: "openrouter:anthropic/claude-x" })],
    ["Drive videos can't use a Lemo style", row({ origin: "drive", text: "f", style: "lemo:ukiyo-e" })],
    ["model isn't available", row({ model: "claude:gone" })],
    ["no editing style", row({ origin: "agent", style: null })],
    ["no longer in Lemo-Opuscar", row({ style: "lemo:nope", model: OPUS })],
    ["not installed", row({ origin: "agent", style: "lemo:ukiyo-e" }), { lemo: [] }],
    ["everything at once", row({ origin: "agent", style: "bold", model: "claude:gone", days: [], sec: null })],
    ["Agent with a gone Lemo style and gone model", row({ origin: "agent", style: "lemo:nope", model: "claude:gone", days: [] })],
  ];
  const seen = new Set<string>();
  for (const [name, r, over] of cases) {
    const bc = over ? ctx({ lemoInstalled: false, ...over }) : c;
    const v = vocab(over?.lemo ? { looks: over.lemo } : {});
    const server = serverRowIssues(r as Row, v);
    assert.deepEqual(j(R.rowIssues(r, bc)), server, name);
    server.forEach((x) => seen.add(x));
  }
  for (const text of ["Lemo styles need a Claude model", "an Agent row needs a Lemo style", "an Agent row needs a Claude model",
    "Drive videos can't use a Lemo style", "claude:gone isn't available; pick another model", "no editing style",
    "lemo:nope is no longer in Lemo-Opuscar", "Lemo-Opuscar isn't installed on this computer"]) assert.ok(seen.has(text), `a case gives "${text}"`);
});
