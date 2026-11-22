import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { calendar, campaignPlan } from "../src/calendar.ts";
import { ROW_INSTRUCTION_BASE, type Row } from "../src/campaigns/rows.ts";
import { DAYS } from "../src/campaigns/spec.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { dayKey, localAt } from "../src/campaigns/time.ts";
import { account, newStore } from "./helpers.ts";

const DAY = 86_400_000;
/** Midnight, local, some days from now (always in the future, so nothing has "passed"). */
const dayFromNow = (n: number) => { const d = new Date(Date.now() + n * DAY); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

const row = (over: Partial<Row> = {}): Row => ({
  id: 1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, style: "basic", model: null,
  type: null, time: "09:00", days: [...DAYS], sec: 30, origin: "create", text: "Show the new feature", ...over,
});

function setup(rows: Row[]) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const id = cs.create({ name: "Launch", text: "", accountSetId: null, defaultPostTimes: [] });
  cs.setRows(id, rows);
  return { store, cs, id };
}

test("a running campaign's rows show on the calendar at their time on each ticked day still to come", () => {
  const { store, cs } = setup([row({ quantity: 2 }), row({ id: 2, time: null }), row({ id: 3, time: "18:30", days: ["mon"] })]);
  const from = dayFromNow(2), to = from + 7 * DAY;
  const plan = campaignPlan(store, cs, from, to);
  const at9 = plan.filter((e) => new Date(e.at).getHours() === 9);
  assert.equal(at9.length, 14, "two copies a day for a week");
  assert.ok(at9.every((e) => e.status === "planned" && e.source === "campaign" && e.campaign?.name === "Launch" && e.name === "Show the new feature"));
  const mondays = plan.filter((e) => new Date(e.at).getHours() === 18);
  assert.equal(mondays.length, 1, "the Monday row once in a week");
  assert.equal(new Date(mondays[0].at).getDay(), 1);
  assert.equal(new Date(mondays[0].at).getMinutes(), 30);
  assert.equal(plan.length, 15, "a row made to keep (no time) isn't on the calendar");
  // The Calendar's own answer includes them.
  assert.equal(calendar(store, from, to, cs).filter((e) => e.source === "campaign").length, 15);
});

test("a stopped campaign, the kill switch, or a day already made plans nothing more", () => {
  const { store, cs, id } = setup([row()]);
  const from = dayFromNow(2), to = from + DAY;
  assert.equal(campaignPlan(store, cs, from, to).length, 1);
  const date = dayKey(from);
  cs.addTask({ campaignId: id, date, dayIndex: new Date(from).getDay(), instructionIndex: ROW_INSTRUCTION_BASE + 1, copy: 0, kind: "make", choices: { postTime: "09:00", instruction: { kind: "make", post: { at: "09:00" } } } });
  const made = campaignPlan(store, cs, from, to);
  assert.equal(made.length, 1, "the task is shown in place of the plan");
  assert.equal(made[0].status, "waiting to be made");
  assert.match(made[0].key, /^task:/);
  cs.setKilled(true);
  assert.deepEqual(campaignPlan(store, cs, from + DAY, to + DAY), [], "nothing planned under the kill switch");
  cs.setKilled(false);
  cs.setEnabled(id, false);
  assert.deepEqual(campaignPlan(store, cs, from, to), []);
});

test("a time already passed today isn't planned", () => {
  const { store, cs } = setup([row({ time: "09:00" })]);
  const today = dayFromNow(0);
  assert.deepEqual(campaignPlan(store, cs, today, today + DAY, localAt(dayKey(today), "10:00")), []);
  assert.equal(campaignPlan(store, cs, today, today + DAY, localAt(dayKey(today), "08:00")).length, 1);
});

/** A campaign task for row 1 on `date` with a post placed at 09:00, held or not. */
function placed(store: ReturnType<typeof newStore>, cs: CampaignStore, id: number, date: string, opts: { held?: boolean } = {}) {
  const acct = store.upsertAccount(account("x"));
  const postId = store.createPost({ caption: "", title: "", sourcePath: "x.mp4", sha256: `s-${date}-${Math.random()}`, tiktok: null, scheduledAt: localAt(date, "09:00") }, [acct.id], { held: opts.held });
  const taskId = cs.addTask({ campaignId: id, date, dayIndex: 0, instructionIndex: ROW_INSTRUCTION_BASE + 1, copy: 0, kind: "make", choices: { postTime: "09:00", instruction: { kind: "make", post: { at: "09:00" } } } })!;
  cs.updateTask(taskId, { state: "scheduled", postId });
  return { postId, taskId };
}

test("a row's new time moves its placed post that hasn't gone out, and a video being made takes the new time", () => {
  const { store, cs, id } = setup([row()]);
  const date = dayKey(dayFromNow(3));
  const { postId } = placed(store, cs, id, date);
  const making = cs.addTask({ campaignId: id, date: dayKey(dayFromNow(4)), dayIndex: 0, instructionIndex: ROW_INSTRUCTION_BASE + 1, copy: 0, kind: "make", choices: { postTime: "09:00", instruction: { kind: "make", post: { at: "09:00" } } } })!;
  cs.setRows(id, [row({ time: "14:15" })]);
  const at = localAt(date, "14:15");
  assert.equal(store.post(postId)!.scheduledAt, at);
  assert.ok(store.jobsForPost(postId).every((j) => j.nextRunAt === at));
  const ch = cs.task(making)!.choices as { postTime: string; instruction: { post: { at: string } } };
  assert.equal(ch.postTime, "14:15");
  assert.equal(ch.instruction.post.at, "14:15");
});

test("a held post stays held at its new time; a post already going out, or a row that stops posting, isn't moved", () => {
  const { store, cs, id } = setup([row()]);
  const date = dayKey(dayFromNow(3));
  const held = placed(store, cs, id, date, { held: true });
  const started = placed(store, cs, id, date);
  const job = store.jobsForPost(started.postId)[0];
  store.saveProgress(job.id, { uploadUrl: "https://example.test/u" });
  cs.setRows(id, [row({ time: "11:00" })]);
  const hj = store.jobsForPost(held.postId)[0];
  assert.equal(hj.nextRunAt, Number.MAX_SAFE_INTEGER, "still held");
  assert.equal((hj.progress as { heldFrom: number }).heldFrom, localAt(date, "11:00"));
  assert.equal(store.post(held.postId)!.scheduledAt, localAt(date, "11:00"));
  assert.equal(store.post(started.postId)!.scheduledAt, localAt(date, "09:00"), "an upload under way keeps its time");
  cs.setRows(id, [row({ time: null })]);
  assert.equal(store.post(held.postId)!.scheduledAt, localAt(date, "11:00"), "no time: left as it is");
});

test("a row's new time moves an open brief: its post time, and an Agent row's deadline", () => {
  const { store, cs, id } = setup([row({ origin: "agent", style: "lemo:ukiyo-e" }), row({ id: 2, style: "lemo:ukiyo-e" })]);
  const date = dayKey(dayFromNow(3));
  const brief = (postAt: number, deadline: number) => ({ look: "lemo:ukiyo-e", postAt, deadline });
  const nine = localAt(date, "09:00");
  const agent = cs.addTask({ campaignId: id, date, dayIndex: 0, instructionIndex: ROW_INSTRUCTION_BASE + 1, copy: 0, kind: "make", state: "awaiting_agent",
    choices: { postTime: "09:00", instruction: { kind: "make", look: "lemo:ukiyo-e", post: { at: "09:00" } }, brief: brief(nine, nine - 30 * 60_000), lease: { holder: "a", until: nine - 30 * 60_000, token: "t", claimedAt: 0 } } })!;
  const scriptedDeadline = Date.now() + DAY;
  const scripted = cs.addTask({ campaignId: id, date, dayIndex: 0, instructionIndex: ROW_INSTRUCTION_BASE + 2, copy: 0, kind: "make", state: "awaiting_agent",
    choices: { postTime: "09:00", instruction: { kind: "make", look: "lemo:ukiyo-e", scripted: true, post: { at: "09:00" } }, brief: brief(nine, scriptedDeadline) } })!;
  cs.setRows(id, [row({ origin: "agent", style: "lemo:ukiyo-e", time: "08:00" }), row({ id: 2, style: "lemo:ukiyo-e", time: "10:00" })]);
  const a = cs.task(agent)!.choices as any;
  assert.equal(a.brief.postAt, localAt(date, "08:00"));
  assert.equal(a.brief.deadline, localAt(date, "08:00") - 30 * 60_000, "due 30 minutes before its new slot");
  assert.equal(a.lease.until, a.brief.deadline, "a lease never outlasts the deadline");
  const b = cs.task(scripted)!.choices as any;
  assert.equal(b.brief.postAt, localAt(date, "10:00"));
  assert.equal(b.brief.deadline, scriptedDeadline, "a Create row's Lemo film stays due within a day");
});
