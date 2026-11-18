import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAgentChange, campaignVocabulary, undoChange } from "../src/campaigns/autorun.ts";
import { DAYS, type CompiledCampaign, type MakeInstruction } from "../src/campaigns/spec.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { newStore } from "./helpers.ts";

const emptyDays = () => Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"];

function setup(opts: { autorun?: boolean } = {}) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const hook = cs.addEntry({ kind: "hook", name: "Stop Scrolling", text: "Stop scrolling" });
  const angle = cs.addEntry({ kind: "angle", name: "Myth Bust", text: "Everyone gets this wrong" });
  const cta = cs.addEntry({ kind: "cta", name: "Free Guide", text: "Get the free guide", url: "https://example.com/guide" });
  const other = cs.addEntry({ kind: "cta", name: "Paid Course", text: "Buy the course", url: "https://example.com/course" });
  const type = cs.addType({ name: "Clip", color: "#f00" });
  const make = (extra: Partial<MakeInstruction> = {}): MakeInstruction => ({
    kind: "make", count: 2, style: "basic", hook: { pick: "named", id: hook }, angle: { pick: "random" }, cta: { pick: "named", id: cta },
    types: [], post: { at: "default" }, source: "make 2", ...extra,
  });
  const compiled = (days: Partial<CompiledCampaign["days"]> = { tue: [make()] }): CompiledCampaign => ({ version: 1, days: { ...emptyDays(), ...days }, rules: [] });
  const id = cs.create({ name: "Weekday Growth", text: "On Tuesday make 2 Basic videos with Stop Scrolling hook and Free Guide cta.", accountSetId: null, defaultPostTimes: ["09:00"], dailyPostCap: 3 });
  cs.confirm(id, compiled());
  if (opts.autorun !== false) cs.setAutorun(id, true);
  const vocab = () => campaignVocabulary(store, cs);
  const change = (c: Parameters<typeof applyAgentChange>[2], reason = "the 9am slot does better") => applyAgentChange(cs, id, c, "claude-code", reason, vocab());
  return { store, cs, id, hook, angle, cta, other, type, make, compiled, vocab, change };
}

test("with Autorun off every change is refused", async () => {
  const s = setup({ autorun: false });
  const r = await s.change({ dailyPostCap: 2 });
  assert.equal(r.ok, false);
  assert.match((r as { problems: string[] }).problems.join(" "), /Autorun is off/);
  assert.equal(s.cs.campaign(s.id)!.dailyPostCap, 3);
  assert.equal(s.cs.changes(s.id).length, 0);
});

test("a reason is required", async () => {
  const s = setup();
  for (const reason of ["", "   ", "x".repeat(501)]) {
    const r = await s.change({ dailyPostCap: 2 }, reason);
    assert.equal(r.ok, false, JSON.stringify(reason));
  }
  assert.equal(s.cs.campaign(s.id)!.dailyPostCap, 3);
});

test("the post cap may go down, never up", async () => {
  const s = setup();
  const up = await s.change({ dailyPostCap: 4 });
  assert.equal(up.ok, false);
  assert.match((up as { problems: string[] }).problems.join(" "), /cap/);
  assert.equal(s.cs.campaign(s.id)!.dailyPostCap, 3);
  const down = await s.change({ dailyPostCap: 2 });
  assert.equal(down.ok, true);
  assert.equal(s.cs.campaign(s.id)!.dailyPostCap, 2);
});

test("CTAs can't change: no other CTA, no new or edited CTA, no random CTA where there was none", async () => {
  const s = setup();
  const before = JSON.stringify(s.cs.campaign(s.id));
  const otherCta = await s.change({ compiled: s.compiled({ tue: [s.make({ cta: { pick: "named", id: s.other } })] }) });
  assert.equal(otherCta.ok, false);
  assert.match((otherCta as { problems: string[] }).problems.join(" "), /CTA/);
  const randomCta = await s.change({ compiled: s.compiled({ tue: [s.make({ cta: { pick: "random" } })] }) });
  assert.equal(randomCta.ok, false);
  const addCta = await s.change({ addEntries: [{ kind: "cta" as "hook", name: "New", text: "x" }] });
  assert.equal(addCta.ok, false);
  // a text change goes through the same check once it's translated
  const text = await s.change({ text: "On Tuesday make 2 Basic videos with Stop Scrolling hook and Paid Course cta." });
  assert.equal(text.ok, false);
  assert.match((text as { problems: string[] }).problems.join(" "), /CTA/);
  assert.equal(JSON.stringify(s.cs.campaign(s.id)), before);
  assert.equal(s.cs.entries("cta").length, 2);
  assert.equal(s.cs.entries("cta").find((e) => e.id === s.cta)!.url, "https://example.com/guide");
});

test("no type approval, Autorun or kill switch through a change", async () => {
  const s = setup();
  for (const bad of [{ autoPost: true }, { autorun: false }, { killed: true }, { url: "https://evil.example" }]) {
    const r = await s.change(bad as never);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(s.cs.types()[0].autoPost, false);
  assert.equal(s.cs.campaign(s.id)!.autorun, true);
  assert.equal(s.cs.killed(), false);
});

test("a compiled schedule must pass the strict check, then is confirmed directly", async () => {
  const s = setup();
  const bad = await s.change({ compiled: { version: 1, days: { tue: [] }, rules: [] } });
  assert.equal(bad.ok, false);
  assert.ok((bad as { problems: string[] }).problems.some((p) => /days\.mon/.test(p)));
  const next = s.compiled({ tue: [s.make({ count: 3 })], wed: [s.make({ count: 1, style: "fancy", types: [s.type] })] });
  const ok = await s.change({ compiled: next });
  assert.equal(ok.ok, true);
  const c = s.cs.campaign(s.id)!;
  assert.equal(s.cs.isRunnable(c), true);
  assert.equal((c.compiled!.days.wed[0] as MakeInstruction).style, "fancy");
});

test("a text change is translated and confirmed; unreadable lines are refused", async () => {
  const s = setup();
  const bad = await s.change({ text: "Do something clever on most days." });
  assert.equal(bad.ok, false);
  assert.ok((bad as { problems: string[] }).problems.some((p) => /Do something clever/.test(p)));
  const ok = await s.change({ text: "On Wednesday make 1 Basic video with Stop Scrolling hook and Free Guide cta." });
  assert.equal(ok.ok, true);
  const c = s.cs.campaign(s.id)!;
  assert.equal(s.cs.isRunnable(c), true);
  assert.equal(c.compiled!.days.wed.length, 1);
  assert.equal(c.compiled!.days.tue.length, 0);
});

test("each change is logged with before, after and reason, and notified", async () => {
  const s = setup();
  const before = s.cs.campaign(s.id)!;
  const r = await s.change({ dailyPostCap: 1 });
  assert.ok(r.ok);
  const [log] = s.cs.changes(s.id);
  assert.equal(log.id, r.changeId);
  assert.equal(log.agent, "claude-code");
  assert.equal(log.reason, "the 9am slot does better");
  assert.equal((log.before as any).dailyPostCap, before.dailyPostCap);
  assert.equal((log.after as any).dailyPostCap, 1);
  const ev = s.store.eventByKey(`campaign.changed:${r.changeId}`);
  assert.ok(ev);
  assert.match(ev.body, /the 9am slot does better/);
  assert.match(ev.body, /campaign\.changed/);
});

test("added hooks and angles are library entries, usable in the same change", async () => {
  const s = setup();
  const r = await s.change({
    addEntries: [{ kind: "hook", name: "Nobody Tells", text: "Nobody tells you this", keywords: ["nobody"] }],
    text: "On Tuesday make 2 Basic videos with Nobody Tells hook and Free Guide cta.",
  });
  assert.ok(r.ok, JSON.stringify(r));
  const added = s.cs.entries("hook").find((e) => e.name === "Nobody Tells")!;
  assert.deepEqual(added.keywords, ["nobody"]);
  const tue = s.cs.campaign(s.id)!.compiled!.days.tue[0] as MakeInstruction;
  assert.deepEqual(tue.hook, { pick: "named", id: added.id });
  // a refused change adds nothing
  const refused = await s.change({ addEntries: [{ kind: "angle", name: "Lost", text: "x" }], dailyPostCap: 9 });
  assert.equal(refused.ok, false);
  assert.equal(s.cs.entries("angle").some((e) => e.name === "Lost"), false);
});

test("undo restores the campaign as it was, once, and only if nothing changed since", async () => {
  const s = setup();
  const original = s.cs.campaign(s.id)!;
  const r = await s.change({ addEntries: [{ kind: "angle", name: "Fresh", text: "A fresh angle" }], compiled: s.compiled({ fri: [s.make()] }), dailyPostCap: 2 });
  assert.ok(r.ok);
  assert.equal(s.cs.entries("angle").length, 2);
  assert.deepEqual(undoChange(s.cs, r.changeId), { ok: true });
  const back = s.cs.campaign(s.id)!;
  assert.deepEqual({ text: back.text, compiled: back.compiled, compiledSha: back.compiledSha, cap: back.dailyPostCap }, { text: original.text, compiled: original.compiled, compiledSha: original.compiledSha, cap: original.dailyPostCap });
  assert.equal(s.cs.isRunnable(back), true);
  assert.notEqual(s.cs.changes(s.id)[0].undoneAt, null);
  assert.equal(s.cs.entries("angle").length, 1, "the unused entry it added is gone");
  assert.equal(undoChange(s.cs, r.changeId).ok, false, "only once");

  const a = await s.change({ dailyPostCap: 2 });
  const b = await s.change({ dailyPostCap: 1 });
  assert.ok(a.ok && b.ok);
  const refused = undoChange(s.cs, a.changeId);
  assert.equal(refused.ok, false);
  assert.match((refused as { problem: string }).problem, /changed since/);
  assert.equal(s.cs.campaign(s.id)!.dailyPostCap, 1);
  assert.deepEqual(undoChange(s.cs, b.changeId), { ok: true });
  assert.deepEqual(undoChange(s.cs, a.changeId), { ok: true });
  assert.equal(s.cs.campaign(s.id)!.dailyPostCap, 3);
});

test("undo keeps an entry it added once something uses it", async () => {
  const s = setup();
  const r = await s.change({ addEntries: [{ kind: "hook", name: "Kept", text: "kept" }] });
  assert.ok(r.ok);
  const kept = s.cs.entries("hook").find((e) => e.name === "Kept")!;
  const other = s.cs.create({ name: "Other", text: "x", accountSetId: null, defaultPostTimes: [] });
  s.cs.confirm(other, s.compiled({ mon: [s.make({ hook: { pick: "named", id: kept.id } })] }));
  assert.deepEqual(undoChange(s.cs, r.changeId), { ok: true });
  assert.ok(s.cs.entry(kept.id), "still used by another campaign");
});
