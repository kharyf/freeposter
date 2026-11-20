import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAgentChange, campaignVocabulary, undoChange } from "../src/campaigns/autorun.ts";
import type { Row } from "../src/campaigns/rows.ts";
import type { MakeInstruction, PostInstruction } from "../src/campaigns/spec.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { newStore } from "./helpers.ts";

function setup(opts: { autorun?: boolean } = {}) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const hook = cs.addEntry({ kind: "hook", name: "Stop Scrolling", text: "Stop scrolling" });
  const angle = cs.addEntry({ kind: "angle", name: "Myth Bust", text: "Everyone gets this wrong" });
  const cta = cs.addEntry({ kind: "cta", name: "Free Guide", text: "Get the free guide", url: "https://example.com/guide" });
  const other = cs.addEntry({ kind: "cta", name: "Paid Course", text: "Buy the course", url: "https://example.com/course" });
  const type = cs.addType({ name: "Clip", color: "#f00" });
  const row = (extra: Partial<Row> = {}): Row => ({
    id: 1, quantity: 2, hook: { pick: "named", id: hook }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, style: "basic",
    type: null, time: "09:00", days: ["tue"], sec: 30, origin: "create", look: null, text: "", ...extra,
  });
  const id = cs.create({ name: "Weekday Growth", text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 100 });
  cs.setRows(id, [row()]);
  if (opts.autorun !== false) cs.setAutorun(id, true);
  const vocab = () => campaignVocabulary(store, cs);
  const change = (c: Parameters<typeof applyAgentChange>[2], reason = "the 9am slot does better") => applyAgentChange(cs, id, c, "claude-code", reason, vocab());
  const problems = (r: Awaited<ReturnType<typeof change>>) => (r as { problems: string[] }).problems.join(" ");
  return { store, cs, id, hook, angle, cta, other, type, row, vocab, change, problems };
}

test("with Autorun off every change is refused", async () => {
  const s = setup({ autorun: false });
  const r = await s.change({ rows: [s.row({ quantity: 3 })] });
  assert.equal(r.ok, false);
  assert.match(s.problems(r), /Autorun is off/);
  assert.equal(s.cs.campaign(s.id)!.rows[0].quantity, 2);
  assert.equal(s.cs.changes(s.id).length, 0);
});

test("a reason is required", async () => {
  const s = setup();
  for (const reason of ["", "   ", "x".repeat(501)]) {
    const r = await s.change({ rows: [s.row({ quantity: 3 })] }, reason);
    assert.equal(r.ok, false, JSON.stringify(reason));
  }
  assert.equal(s.cs.campaign(s.id)!.rows[0].quantity, 2);
});

test("the cap, text and compiled schedule can't be sent: the table is the change", async () => {
  const s = setup();
  for (const [bad, why] of [[{ dailyPostCap: 2 }, /daily post cap/], [{ text: "On Monday…" }, /send rows/], [{ compiled: {} }, /send rows/]] as const) {
    const r = await s.change(bad as never);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(s.problems(r), why);
  }
  assert.equal(s.cs.campaign(s.id)!.dailyPostCap, 100);
});

test("CTAs can't change: no other CTA, no new or edited CTA, no random CTA where there was none", async () => {
  const s = setup();
  const before = JSON.stringify(s.cs.campaign(s.id));
  const otherCta = await s.change({ rows: [s.row({ cta: { pick: "named", id: s.other } })] });
  assert.equal(otherCta.ok, false);
  assert.match(s.problems(otherCta), /CTA/);
  const randomCta = await s.change({ rows: [s.row({ cta: { pick: "random" } })] });
  assert.equal(randomCta.ok, false);
  const addCta = await s.change({ addEntries: [{ kind: "cta" as "hook", name: "New", text: "x" }] });
  assert.equal(addCta.ok, false);
  assert.equal(JSON.stringify(s.cs.campaign(s.id)), before);
  assert.equal(s.cs.entries("cta").length, 2);
  assert.equal(s.cs.entries("cta").find((e) => e.id === s.cta)!.url, "https://example.com/guide");
});

test("no type approval, Autorun, start/stop or kill switch through a change", async () => {
  const s = setup();
  for (const bad of [{ autoPost: true }, { autorun: false }, { killed: true }, { url: "https://evil.example" }, { enabled: false }]) {
    const r = await s.change(bad as never);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(s.cs.types()[0].autoPost, false);
  assert.equal(s.cs.campaign(s.id)!.autorun, true);
  assert.equal(s.cs.campaign(s.id)!.enabled, true);
  assert.equal(s.cs.killed(), false);
});

test("rows must pass the strict check, then run at once", async () => {
  const s = setup();
  const bad = await s.change({ rows: [s.row({ quantity: 11 }), { ...s.row({ id: 2 }), extra: 1 }] });
  assert.equal(bad.ok, false);
  assert.match(s.problems(bad), /row 1: quantity/);
  assert.match(s.problems(bad), /row 2: unknown field "extra"/);
  const ok = await s.change({ rows: [s.row({ quantity: 3 }), s.row({ id: 2, quantity: 1, style: "fancy", type: s.type, days: ["wed", "fri"], text: "Show the before and after" })] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const c = s.cs.campaign(s.id)!;
  assert.equal(s.cs.isRunnable(c), true);
  const wed = c.compiled!.days.wed[0] as MakeInstruction;
  assert.equal(wed.style, "fancy");
  assert.deepEqual(wed.types, [s.type]);
  assert.equal(wed.instructions, "Show the before and after");
  assert.equal(c.compiled!.days.fri.length, 1);
  assert.equal((c.compiled!.days.tue[0] as MakeInstruction).count, 3);
});

test("each change is logged with before, after and reason, and notified", async () => {
  const s = setup();
  const r = await s.change({ rows: [s.row({ quantity: 1 })] });
  assert.ok(r.ok);
  const [log] = s.cs.changes(s.id);
  assert.equal(log.id, r.changeId);
  assert.equal(log.agent, "claude-code");
  assert.equal(log.reason, "the 9am slot does better");
  assert.equal((log.before as any).rows[0].quantity, 2);
  assert.equal((log.after as any).rows[0].quantity, 1);
  const ev = s.store.eventByKey(`campaign.changed:${r.changeId}`);
  assert.ok(ev);
  assert.match(ev.body, /the 9am slot does better/);
  assert.match(ev.body, /campaign\.changed/);
});

test("added hooks and angles are library entries, usable in the same change", async () => {
  const s = setup();
  const r = await s.change({
    addEntries: [{ kind: "hook", name: "Nobody Tells", text: "Nobody tells you this", keywords: ["nobody"] }],
    rows: [s.row({ hook: { pick: "named", id: -1 } })],
  });
  assert.ok(r.ok, JSON.stringify(r));
  const added = s.cs.entries("hook").find((e) => e.name === "Nobody Tells")!;
  assert.deepEqual(added.keywords, ["nobody"]);
  const c = s.cs.campaign(s.id)!;
  assert.deepEqual(c.rows[0].hook, { pick: "named", id: added.id });
  assert.deepEqual((c.compiled!.days.tue[0] as MakeInstruction).hook, { pick: "named", id: added.id });
  // a refused change adds nothing
  const refused = await s.change({ addEntries: [{ kind: "angle", name: "Lost", text: "x" }], rows: [s.row({ quantity: 0 })] });
  assert.equal(refused.ok, false);
  assert.equal(s.cs.entries("angle").some((e) => e.name === "Lost"), false);
});

test("undo restores the campaign as it was, once, and only if nothing changed since", async () => {
  const s = setup();
  const original = s.cs.campaign(s.id)!;
  const r = await s.change({ addEntries: [{ kind: "angle", name: "Fresh", text: "A fresh angle" }], rows: [s.row({ days: ["fri"] })] });
  assert.ok(r.ok);
  assert.equal(s.cs.entries("angle").length, 2);
  assert.deepEqual(undoChange(s.cs, r.changeId), { ok: true });
  const back = s.cs.campaign(s.id)!;
  assert.deepEqual({ rows: back.rows, compiled: back.compiled, compiledSha: back.compiledSha }, { rows: original.rows, compiled: original.compiled, compiledSha: original.compiledSha });
  assert.equal(s.cs.isRunnable(back), true);
  assert.notEqual(s.cs.changes(s.id)[0].undoneAt, null);
  assert.equal(s.cs.entries("angle").length, 1, "the unused entry it added is gone");
  assert.equal(undoChange(s.cs, r.changeId).ok, false, "only once");

  const a = await s.change({ rows: [s.row({ quantity: 3 })] });
  const b = await s.change({ rows: [s.row({ quantity: 4 })] });
  assert.ok(a.ok && b.ok);
  const refused = undoChange(s.cs, a.changeId);
  assert.equal(refused.ok, false);
  assert.match((refused as { problem: string }).problem, /changed since/);
  assert.equal(s.cs.campaign(s.id)!.rows[0].quantity, 4);
  assert.deepEqual(undoChange(s.cs, b.changeId), { ok: true });
  assert.deepEqual(undoChange(s.cs, a.changeId), { ok: true });
  assert.equal(s.cs.campaign(s.id)!.rows[0].quantity, 2);
});

test("undo keeps an entry it added once something uses it", async () => {
  const s = setup();
  const r = await s.change({ addEntries: [{ kind: "hook", name: "Kept", text: "kept" }] });
  assert.ok(r.ok);
  const kept = s.cs.entries("hook").find((e) => e.name === "Kept")!;
  const other = s.cs.create({ name: "Other", text: "", accountSetId: null, defaultPostTimes: [] });
  s.cs.setRows(other, [s.row({ hook: { pick: "named", id: kept.id }, days: [] })]); // even a row that isn't running yet
  assert.deepEqual(undoChange(s.cs, r.changeId), { ok: true });
  assert.ok(s.cs.entry(kept.id), "still used by another campaign's table");
});

test("the user changing the campaign meanwhile makes an undo wait", async () => {
  const s = setup();
  const r = await s.change({ rows: [s.row({ quantity: 3 })] });
  assert.ok(r.ok);
  s.cs.setRows(s.id, [s.row({ quantity: 5 })]); // the user, in the table
  const refused = undoChange(s.cs, r.changeId);
  assert.equal(refused.ok, false);
  assert.equal(s.cs.campaign(s.id)!.rows[0].quantity, 5);
});

test("hooks and angles an agent adds belong to its campaign; another campaign can't name them", async () => {
  const s = setup();
  const r = await s.change({ addEntries: [{ kind: "hook", name: "Mine", text: "mine" }] });
  assert.ok(r.ok);
  const mine = s.cs.entries("hook").find((e) => e.name === "Mine")!;
  assert.equal(mine.ownerCampaignId, s.id);
  assert.equal(s.cs.entry(s.hook)!.ownerCampaignId, null, "the user's own entries have no owner");
  const other = s.cs.create({ name: "Other", text: "", accountSetId: null, defaultPostTimes: [] });
  s.cs.setRows(other, [s.row()]);
  s.cs.setAutorun(other, true);
  const borrow = [s.row({ hook: { pick: "named", id: mine.id } })];
  const refused = await applyAgentChange(s.cs, other, { rows: borrow }, "claude-code", "borrow it", s.vocab());
  assert.equal(refused.ok, false);
  assert.match((refused as { problems: string[] }).problems.join(" "), /belongs to another campaign/);
  // nor as a Drive row's label
  const label = await applyAgentChange(s.cs, other, { rows: [s.row({ origin: "drive", text: "Clip", hook: { pick: "named", id: mine.id } })] }, "claude-code", "label it", s.vocab());
  assert.equal(label.ok, false);
  const own = await s.change({ rows: borrow });
  assert.ok(own.ok, JSON.stringify(own));
});

test("a type that posts without approval can't be newly attached; one the table already used can", async () => {
  const s = setup();
  const auto = s.cs.addType({ name: "Auto", color: "#0f0" });
  s.cs.setTypeAutoPost(auto, true);
  const refused = await s.change({ rows: [s.row({ type: auto })] });
  assert.equal(refused.ok, false);
  assert.match(s.problems(refused), /without approval/);
  // the user's own table used it: the agent may keep using it (on another row too)
  s.cs.setRows(s.id, [s.row({ type: auto })]);
  const ok = await s.change({ rows: [s.row({ type: auto }), s.row({ id: 2, type: auto, days: ["wed"] })] });
  assert.ok(ok.ok, JSON.stringify(ok));
});

test("a Drive row posts its file by name, labelled by its named hook, angle and CTA", async () => {
  const s = setup();
  const r = await s.change({ rows: [s.row(), s.row({ id: 2, origin: "drive", text: "Gatekeeping", time: "17:30", days: ["mon"], angle: { pick: "named", id: s.angle }, sec: 45 })] });
  assert.ok(r.ok, JSON.stringify(r));
  const mon = s.cs.campaign(s.id)!.compiled!.days.mon[0] as PostInstruction;
  assert.equal(mon.kind, "post");
  assert.equal(mon.name, "Gatekeeping");
  assert.equal(mon.at, "17:30");
  assert.deepEqual(mon.angle, { pick: "named", id: s.angle });
  assert.equal(mon.sec, 45);
});

test("a hook or angle an agent adds may not carry a link, however it's written", async () => {
  const s = setup();
  const hooks = s.cs.entries("hook").length;
  for (const text of ["Go to evil dot xyz", "Go to evil．com", "Go to ev​il.com", "Email me@evil.com", "See https://evil.com"]) {
    const r = await s.change({ addEntries: [{ kind: "hook", name: "Sneaky", text }] });
    assert.equal(r.ok, false, text);
    assert.match(s.problems(r), /link/, text);
  }
  const angle = await s.change({ addEntries: [{ kind: "angle", name: "evil.com", text: "a fine angle" }] });
  assert.equal(angle.ok, false, "nor in its name");
  assert.equal(s.cs.entries("hook").length, hooks);
  assert.equal((await s.change({ addEntries: [{ kind: "hook", name: "Plain", text: "Nobody tells you this" }] })).ok, true);
});
