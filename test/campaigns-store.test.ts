import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignStore, confirmedForText, heldNames } from "../src/campaigns/store.ts";
import { DAYS, type CompiledCampaign } from "../src/campaigns/spec.ts";
import { compileRows, ROW_ID_PREF, ROW_IDS_MIGRATED_PREF, ROW_INSTRUCTION_BASE, rowIdHex, type Row } from "../src/campaigns/rows.ts";
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
  assert.equal(confirmedForText(cs.campaign(id)!), true, "off, but its schedule is still the current text's");
  cs.setText(id, "Tuesday make 4");
  assert.equal(confirmedForText(cs.campaign(id)!), false);
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
  cs.updateTask(t1, { state: "rendering", productionId: 9, choices: { hook: 1 } });
  const t = cs.task(t1)!;
  assert.equal(t.state, "rendering");
  assert.equal(t.productionId, 9);
  assert.deepEqual(t.choices, { hook: 1 });
  assert.deepEqual(cs.tasksIn(["rendering", "queued"]).map((x) => x.id), [t1]);
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

test("heldNames: the lowercased post-line names of enabled campaigns, an edited one by its last confirmed schedule", () => {
  const store = newStore();
  const cs = new CampaignStore(store);
  const line = (name: string) => ({ kind: "post" as const, name, at: "20:00", style: null, types: [], source: `post ${name}` });
  const on = mk(cs);
  cs.confirm(on, { ...compiled(), days: { ...compiled().days, mon: [line("Gatekeeping")], fri: [line("Launch")] } });
  const off = mk(cs);
  cs.confirm(off, { ...compiled(), days: { ...compiled().days, tue: [line("Disabled")] } });
  cs.setEnabled(off, false);
  const edited = mk(cs);
  cs.confirm(edited, { ...compiled(), days: { ...compiled().days, wed: [line("Unconfirmed")] } });
  cs.setText(edited, "changed");
  const never = mk(cs);
  cs.setText(never, "post Never_9pm");
  // An edit pauses a campaign but doesn't release what it holds: it holds by the schedule it last confirmed.
  assert.deepEqual([...heldNames(store)].sort(), ["gatekeeping", "launch", "unconfirmed"]);
});

const oldAgentRow = (over: Record<string, unknown> = {}) => ({
  id: 1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, style: null, type: null, time: "18:00",
  days: ["tue"], sec: 30, origin: "agent", look: "lemo:ukiyo-e", text: "", ...over,
});
const writeRawRows = (cs: CampaignStore, id: number, rows: unknown[]) => cs.db.prepare("UPDATE campaigns SET rows = ? WHERE id = ?").run(JSON.stringify(rows), id);

test("the store returns old-shape rows migrated", () => {
  const cs = new CampaignStore(newStore());
  const id = mk(cs);
  writeRawRows(cs, id, [oldAgentRow(), { ...oldAgentRow({ id: 2, origin: "create", style: "basic", look: null }) }]);
  const [agent, create] = cs.campaign(id)!.rows;
  assert.equal(agent.style, "lemo:ukiyo-e");
  assert.equal(agent.model, null);
  assert.equal("look" in agent, false);
  assert.equal(create.style, "basic");
  assert.equal("look" in create, false);
});

test("opening the store migrates old Agent rows once and logs the removed edit", () => {
  const store = newStore();
  let cs = new CampaignStore(store);
  const id = mk(cs);
  const untouched = mk(cs);
  writeRawRows(cs, id, [oldAgentRow({ style: "basic" })]);
  writeRawRows(cs, untouched, [oldAgentRow({ origin: "create", style: "basic", look: null })]);
  cs = new CampaignStore(store);
  const raw = JSON.parse((cs.db.prepare("SELECT rows FROM campaigns WHERE id = ?").get(id) as { rows: string }).rows);
  assert.equal(raw[0].style, "lemo:ukiyo-e");
  assert.equal("look" in raw[0], false);
  assert.equal((cs.campaign(id)!.compiled!.days.tue[0] as any).look, "lemo:ukiyo-e", "its schedule is made again");
  const logged = cs.changes(id);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].agent, "FreePoster");
  assert.match(logged[0].reason, /Row 1: Lemo films are no longer edited by FreePoster; its basic edit was removed/);
  assert.equal(cs.changes(untouched).length, 0, "a campaign with no look in its rows is left alone");
  cs = new CampaignStore(store);
  assert.equal(cs.changes(id).length, 1, "a second open logs nothing new");
});

const newRow = (over: Partial<Row> = {}): Row => ({
  id: -1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, style: "basic", model: null, videoModel: null, type: null,
  time: "18:00", days: ["tue"], sec: 30, origin: "create", text: "", ...over,
});

test("setRows gives new rows (id <= 0) global ids from 1, never reused across campaigns", () => {
  const cs = new CampaignStore(newStore());
  const mkc = (name: string) => cs.create({ name, text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 3 });
  const a = mkc("A");
  const b = mkc("B");
  const given = [newRow({ id: -1 }), newRow({ id: -2 })];
  assert.deepEqual(cs.setRows(a, given).map((r) => r.id), [1, 2]);
  assert.deepEqual(given.map((r) => r.id), [-1, -2], "the caller's rows are left alone");
  assert.deepEqual(cs.setRows(b, [newRow({ id: -1 })]).map((r) => r.id), [3]);
  cs.setRows(a, [newRow({ id: 1 })]); // row 2 deleted
  assert.deepEqual(cs.setRows(a, [newRow({ id: 1 }), newRow({ id: -1 })]).map((r) => r.id), [1, 4]);
  assert.equal(rowIdHex(4), "0000004");
  assert.equal(rowIdHex(26), "000001a");
  assert.equal(rowIdHex(-1), "new");
});

test("migrateRowIds renumbers every campaign's rows once, keeping tasks and the change log on their rows", () => {
  const store = newStore();
  let cs = new CampaignStore(store);
  store.deletePref(ROW_IDS_MIGRATED_PREF);
  store.deletePref(ROW_ID_PREF);
  const mkc = (name: string) => cs.create({ name, text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 3 });
  const A = mkc("A"), B = mkc("B");
  const rowsOf = () => [newRow({ id: 1 }), newRow({ id: 2, days: ["wed"] })];
  const raw = (id: number, rows: Row[]) => cs.db.prepare("UPDATE campaigns SET rows = ? WHERE id = ?").run(JSON.stringify(rows), id);
  raw(A, rowsOf());
  raw(B, rowsOf());
  const taskB2 = cs.addTask({
    campaignId: B, date: "2026-11-17", dayIndex: 2, instructionIndex: ROW_INSTRUCTION_BASE + 2, kind: "make",
    choices: { instruction: { kind: "make", row: 2 } },
  })!;
  const before = { rows: rowsOf(), compiled: compileRows(rowsOf()) };
  const changeB = cs.logChange({ campaignId: B, agent: "x", before, after: before, reason: "r" });
  cs = new CampaignStore(store);
  assert.deepEqual(cs.campaign(A)!.rows.map((r) => r.id), [1, 2]);
  assert.deepEqual(cs.campaign(B)!.rows.map((r) => r.id), [3, 4]);
  assert.equal(cs.task(taskB2)!.instructionIndex, ROW_INSTRUCTION_BASE + 4);
  assert.equal((cs.task(taskB2)!.choices as any).instruction.row, 4);
  assert.deepEqual((cs.change(changeB)!.after as any).rows.map((r: any) => r.id), [3, 4]);
  assert.ok(JSON.stringify((cs.change(changeB)!.after as any).compiled).includes('"row":4'));
  new CampaignStore(store); // a second instance: no second renumbering
  assert.deepEqual(cs.campaign(B)!.rows.map((r) => r.id), [3, 4]);
  assert.equal(store.pref<number>(ROW_ID_PREF), 5);
});
