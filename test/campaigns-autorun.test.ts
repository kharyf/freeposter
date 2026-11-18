import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAgentChange, campaignVocabulary, undoChange } from "../src/campaigns/autorun.ts";
import type { AiService } from "../src/ai/router.ts";
import { parseCampaignText } from "../src/campaigns/parse.ts";
import { renderCampaignText } from "../src/campaigns/render.ts";
import { DAYS, type CompiledCampaign, type MakeInstruction, type Rule } from "../src/campaigns/spec.ts";
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

test("while the user is editing the text (not confirmed yet), text and schedule changes wait; cap and library don't", async () => {
  const s = setup();
  s.cs.setText(s.id, "On Friday make 1 Basic video with Stop Scrolling hook and Free Guide cta.");
  for (const c of [{ text: "On Monday make 1 Basic video with Stop Scrolling hook and Free Guide cta." }, { compiled: s.compiled({ mon: [s.make()] }) }]) {
    const r = await s.change(c);
    assert.equal(r.ok, false);
    assert.match((r as { problems: string[] }).problems.join(" "), /editing this campaign's text/);
  }
  assert.equal(s.cs.isRunnable(s.cs.campaign(s.id)!), false, "the draft stays a draft");
  assert.equal((await s.change({ dailyPostCap: 2 })).ok, true);
  assert.equal((await s.change({ addEntries: [{ kind: "hook", name: "Later", text: "later" }] })).ok, true);
});

test("text and compiled together are refused", async () => {
  const s = setup();
  const r = await s.change({ text: "On Monday make 1 Basic video with Stop Scrolling hook and Free Guide cta.", compiled: s.compiled({ mon: [s.make()] }) });
  assert.equal(r.ok, false);
  assert.match((r as { problems: string[] }).problems.join(" "), /not both/);
});

test("a schedule change rewrites the text to say it; one the text can't say is refused", async () => {
  const s = setup();
  const next = s.compiled({ thu: [s.make({ count: 4, post: { at: "18:30" } })] });
  const ok = await s.change({ compiled: next });
  assert.ok(ok.ok, JSON.stringify(ok));
  const c = s.cs.campaign(s.id)!;
  assert.equal(c.text, renderCampaignText(next, s.vocab()));
  const read = parseCampaignText(c.text, s.vocab());
  assert.deepEqual(read.unread, []);
  assert.deepEqual(read.compiled, c.compiled);
  assert.equal(s.cs.isRunnable(c), true);
  const rule: Rule = { when: { label: "hook", is: "working", thresholdPct: 25, minVideos: 3, age: "72h", scope: "campaign" }, then: { kind: "make", count: 2, keep: ["hook", "angle"], vary: ["cta"], post: true }, source: "x" };
  const refused = await s.change({ compiled: { ...s.compiled(), rules: [rule] } });
  assert.equal(refused.ok, false);
  assert.match((refused as { problems: string[] }).problems.join(" "), /can't be written as campaign text/);
  assert.equal(s.cs.campaign(s.id)!.text, c.text);
});

test("the campaign changing while a text change is translated refuses it", async () => {
  const s = setup();
  const ai = {
    ask: async () => {
      s.cs.setDailyPostCap(s.id, 2); // the user, meanwhile
      return { lines: [{ index: 0, day: "wed", rule: null, instruction: { kind: "make", count: 1, style: "basic", hook: { pick: "named", id: s.hook }, angle: { pick: "random" }, cta: { pick: "named", id: s.cta }, types: [], post: null } }] };
    },
  } as unknown as Pick<AiService, "ask">;
  const r = await applyAgentChange(s.cs, s.id, { text: "On Wednesday do the usual thing." }, "claude-code", "try wednesday", s.vocab(), { ai });
  assert.equal(r.ok, false);
  assert.match((r as { problems: string[] }).problems.join(" "), /changed while/);
  assert.equal(s.cs.campaign(s.id)!.compiled!.days.wed.length, 0);
});

test("hooks and angles an agent adds belong to its campaign; another campaign can't name them", async () => {
  const s = setup();
  const r = await s.change({ addEntries: [{ kind: "hook", name: "Mine", text: "mine" }] });
  assert.ok(r.ok);
  const mine = s.cs.entries("hook").find((e) => e.name === "Mine")!;
  assert.equal(mine.ownerCampaignId, s.id);
  assert.equal(s.cs.entry(s.hook)!.ownerCampaignId, null, "the user's own entries have no owner");
  const other = s.cs.create({ name: "Other", text: "x", accountSetId: null, defaultPostTimes: [] });
  s.cs.confirm(other, s.compiled());
  s.cs.setText(other, renderCampaignText(s.compiled(), s.vocab()));
  s.cs.confirm(other, s.compiled());
  s.cs.setAutorun(other, true);
  const refused = await applyAgentChange(s.cs, other, { compiled: s.compiled({ tue: [s.make({ hook: { pick: "named", id: mine.id } })] }) }, "claude-code", "borrow it", s.vocab());
  assert.equal(refused.ok, false);
  assert.match((refused as { problems: string[] }).problems.join(" "), /belongs to another campaign/);
  const own = await s.change({ compiled: s.compiled({ tue: [s.make({ hook: { pick: "named", id: mine.id } })] }) });
  assert.ok(own.ok, JSON.stringify(own));
});

test("a type that posts without approval can't be newly attached; one the schedule already used can", async () => {
  const s = setup();
  const auto = s.cs.addType({ name: "Auto", color: "#0f0" });
  s.cs.setTypeAutoPost(auto, true);
  const refused = await s.change({ compiled: s.compiled({ tue: [s.make({ types: [auto] })] }) });
  assert.equal(refused.ok, false);
  assert.match((refused as { problems: string[] }).problems.join(" "), /without approval/);
  // the user's own schedule used it: the agent may keep using it (on another line too)
  s.cs.confirm(s.id, s.compiled({ tue: [s.make({ types: [auto] })] }));
  const ok = await s.change({ compiled: s.compiled({ tue: [s.make({ types: [auto] })], wed: [s.make({ types: [auto, s.type] })] }) });
  assert.ok(ok.ok, JSON.stringify(ok));
});

test("a hook or angle an agent adds may not carry a link, however it's written", async () => {
  const s = setup();
  const hooks = s.cs.entries("hook").length;
  for (const text of ["Go to evil dot xyz", "Go to evil．com", "Go to ev​il.com", "Email me@evil.com", "See https://evil.com"]) {
    const r = await s.change({ addEntries: [{ kind: "hook", name: "Sneaky", text }] });
    assert.equal(r.ok, false, text);
    assert.match((r as { problems: string[] }).problems.join(" "), /link/, text);
  }
  const angle = await s.change({ addEntries: [{ kind: "angle", name: "evil.com", text: "a fine angle" }] });
  assert.equal(angle.ok, false, "nor in its name");
  assert.equal(s.cs.entries("hook").length, hooks);
  assert.equal((await s.change({ addEntries: [{ kind: "hook", name: "Plain", text: "Nobody tells you this" }] })).ok, true);
});
