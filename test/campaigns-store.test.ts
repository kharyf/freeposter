import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignStore } from "../src/campaigns/store.ts";
import { DAYS, type CompiledCampaign } from "../src/campaigns/spec.ts";
import { newStore } from "./helpers.ts";

const compiled = (): CompiledCampaign => ({ version: 1, days: Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"], rules: [] });
const mk = (cs: CampaignStore) => cs.create({ name: "Weekday Growth", text: "Tuesday make 2", accountSetId: null, defaultPostTimes: ["09:00"] });
const task = (campaignId: number) => ({ campaignId, date: "2026-11-17", dayIndex: 2, instructionIndex: 0, kind: "make" as const });

test("a task can be materialized only once per day, instruction and copy", () => {
  const cs = new CampaignStore(newStore());
  const id = mk(cs);
  const t = task(id);
  assert.notEqual(cs.addTask(t), null);
  assert.equal(cs.addTask(t), null);
  assert.notEqual(cs.addTask({ ...t, copy: 2 }), null);
  assert.notEqual(cs.addTask({ ...t, date: "2026-11-24" }), null);
  assert.equal(cs.tasksOn(id, "2026-11-17").length, 2);
});

test("editing text makes a confirmed campaign not runnable until confirmed again", () => {
  const cs = new CampaignStore(newStore());
  const id = mk(cs);
  assert.equal(cs.isRunnable(cs.campaign(id)!), false, "unconfirmed");
  cs.confirm(id, compiled());
  let c = cs.campaign(id)!;
  assert.equal(cs.isRunnable(c), true);
  assert.equal(c.compiled?.version, 1);
  assert.notEqual(c.confirmedAt, null);
  cs.setText(id, "Tuesday make 3");
  c = cs.campaign(id)!;
  assert.notEqual(c.compiled, null, "compiled is kept");
  assert.equal(cs.isRunnable(c), false);
  cs.confirm(id, compiled());
  assert.equal(cs.isRunnable(cs.campaign(id)!), true);
  cs.setEnabled(id, false);
  assert.equal(cs.isRunnable(cs.campaign(id)!), false);
});

test("ruleFired is true once, then false for the same key", () => {
  const cs = new CampaignStore(newStore());
  assert.equal(cs.ruleFired(1, 0, "hook:5"), true);
  assert.equal(cs.ruleFired(1, 0, "hook:5"), false);
  assert.equal(cs.ruleFired(1, 1, "hook:5"), true);
  assert.equal(cs.ruleFired(1, 0, "hook:6"), true);
});

test("defaults: autorun off, cap 3, enabled; types start without auto-post", () => {
  const cs = new CampaignStore(newStore());
  const c = cs.campaign(mk(cs))!;
  assert.equal(c.autorun, false);
  assert.equal(c.dailyPostCap, 3);
  assert.equal(c.enabled, true);
  assert.deepEqual(c.defaultPostTimes, ["09:00"]);
  const t = cs.addType({ name: "Tips", color: "#fff" });
  assert.equal(cs.types()[0].autoPost, false);
  cs.setTypeAutoPost(t, true);
  assert.equal(cs.types()[0].autoPost, true);
  cs.setAutorun(c.id, true);
  assert.equal(cs.campaign(c.id)!.autorun, true);
});

test("library entries add, filter, update and delete", () => {
  const cs = new CampaignStore(newStore());
  const h = cs.addEntry({ kind: "hook", name: "Stop", text: "Stop scrolling" });
  const c = cs.addEntry({ kind: "cta", name: "Site", text: "Visit", url: "https://x.test", keywords: ["go"] });
  assert.equal(cs.entries().length, 2);
  assert.deepEqual(cs.entries("cta").map((e) => e.id), [c]);
  assert.equal(cs.entry(c)?.url, "https://x.test");
  cs.updateEntry(h, { name: "Stop it", keywords: ["a", "b"] });
  assert.deepEqual(cs.entry(h)?.keywords, ["a", "b"]);
  assert.equal(cs.entry(h)?.name, "Stop it");
  cs.deleteEntry(h);
  assert.equal(cs.entry(h), undefined);
});

test("tasks update and filter by state; changes log and undo; kill switch", () => {
  const cs = new CampaignStore(newStore());
  const id = mk(cs);
  const t1 = cs.addTask(task(id))!;
  cs.addTask({ ...task(id), instructionIndex: 1, state: "posted" });
  cs.updateTask(t1, { state: "made", productionId: 9, choices: { hook: 1 } });
  const t = cs.task(t1)!;
  assert.equal(t.state, "made");
  assert.equal(t.productionId, 9);
  assert.deepEqual(t.choices, { hook: 1 });
  assert.deepEqual(cs.tasksIn(["made", "planned"]).map((x) => x.id), [t1]);
  assert.deepEqual(cs.tasksIn([]), []);
  const ch = cs.logChange({ campaignId: id, agent: "claude", before: { a: 1 }, after: { a: 2 }, reason: "because" });
  assert.equal(cs.changes(id)[0].undoneAt, null);
  cs.markUndone(ch);
  assert.notEqual(cs.changes(id)[0].undoneAt, null);
  assert.deepEqual(cs.changes(id)[0].after, { a: 2 });
  assert.equal(cs.killed(), false);
  cs.setKilled(true);
  assert.equal(cs.killed(), true);
  cs.setKilled(false);
  assert.equal(cs.killed(), false);
});
