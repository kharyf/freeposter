import "./isolated-home.ts";
import assert from "node:assert/strict";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import type { AiService } from "../src/ai/router.ts";
import type { Question } from "../src/ai/providers.ts";
import { checkBudget } from "../src/ai/budget.ts";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { claimBrief, openBriefs, submitBrief } from "../src/campaigns/briefs.ts";
import { syncLooks } from "../src/campaigns/looks.ts";
import type { Script, writeScript } from "../src/campaigns/script.ts";
import { DAYS, type CompiledCampaign, type Day, type MakeInstruction, type PostInstruction } from "../src/campaigns/spec.ts";
import { ROW_INSTRUCTION_BASE, type Row } from "../src/campaigns/rows.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { CampaignWorker, localAt } from "../src/campaigns/worker.ts";
import { publishers } from "../src/platforms/index.ts";
import type { ProductionSpec } from "../src/produce/spec.ts";
import { ProductionStore } from "../src/produce/store.ts";
import { ReviewService } from "../src/review/service.ts";
import { account, makeVideo, newStore, tmp } from "./helpers.ts";

// Local-time days are the point of these tests: pin a zone with a daylight-saving change.
process.env.TZ = "America/New_York";

/** Distinct clips: each generated video is its own file, so no two are "the same video" to the duplicate check. */
let clips: string[] = [];
before(() => {
  const dir = tmp();
  clips = [3, 4, 5, 6, 7, 3.5, 4.5, 5.5, 6.5, 7.5].map((sec, i) => makeVideo(dir, `clip${i}.mp4`, ["-f", "lavfi", "-i", `testsrc2=size=360x640:rate=24`, "-t", String(sec), "-c:v", "libx264", "-pix_fmt", "yuv420p"]));
});

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
/** Tuesday 17 November 2026, 08:00 local */
const TUE = at(2026, 11, 17, 8);

const emptyDays = () => Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"];

function setup(opts: { cap?: number; defaults?: string[]; writeScript?: typeof writeScript } = {}) {
  const store = newStore();
  store.upsertAccount(account("x"));
  const cs = new CampaignStore(store);
  const hooks = ["Stop scrolling", "Nobody tells you this", "Here is the secret"].map((t, i) => cs.addEntry({ kind: "hook", name: `h${i}`, text: t }));
  const angles = ["Your week is a mess", "You never plan", "You waste mornings"].map((t, i) => cs.addEntry({ kind: "angle", name: `a${i}`, text: t }));
  const cta = cs.addEntry({ kind: "cta", name: "try", text: "Try it free today", url: "https://example.com/plan" });
  const clock = { now: TUE };
  const reviews = new ReviewService(store, { publishers, runner: { tick() {} }, dir: tmp() });
  const ps = new ProductionStore(store);
  const staged: ProductionSpec[] = [];
  const gpu: string[] = [];
  const productions = {
    productions: ps,
    createStaged: async (spec: ProductionSpec) => { staged.push(spec); return ps.create(spec, []); },
    borrowGpu: async <T>(fn: () => Promise<T>) => { gpu.push("borrowed"); return { value: await fn() }; },
    cancel: (id: number) => ps.cancel(id),
  };
  const asked: Question[] = [];
  /** the options each ask was given (the row's model) */
  const askedOpts: unknown[] = [];
  const ai = {
    ask: async (job: string, q: Question, o?: unknown): Promise<Script> => {
      assert.equal(job, "script");
      checkBudget(store, job); // as the router does first
      asked.push(q);
      askedOpts.push(o);
      const hook = /Hook: (.*)/.exec(q.prompt)![1];
      const call = /CTA \(spoken call\): (.*)/.exec(q.prompt)![1];
      const url = /CTA link: (.*)/.exec(q.prompt)?.[1] ?? "";
      return {
        lines: [`${hook}, this plans your week.`, "One tap and it is done.", call],
        shots: [{ prompt: "a calendar filling in", sec: 4 }, { prompt: "a happy person", sec: 5 }],
        caption: `Plan your week ${url}`.trim(), title: "Plan your week", musicPrompt: "upbeat lo-fi",
      };
    },
  } as unknown as AiService;
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const audio: string[] = [];
  const worker = new CampaignWorker({
    store, productions, reviews, ai, now: () => clock.now, random,
    speech: async (text) => { audio.push(`speech:${text}`); return clips[0]; },
    music: async (prompt, sec) => { audio.push(`music:${prompt}:${sec}`); return clips[0]; },
    ...(opts.writeScript ? { writeScript: opts.writeScript } : {}),
    dir: tmp(),
  });
  const make = (count: number, post: MakeInstruction["post"], extra: Partial<MakeInstruction> = {}): MakeInstruction => ({
    kind: "make", count, style: "basic", hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, types: [], post,
    source: `make ${count}`, ...extra,
  });
  const postLine = (name: string, time: string | null): PostInstruction => ({ kind: "post", name, at: time, style: null, types: [], source: `post ${name}` });
  const campaign = (days: Partial<Record<Day, (MakeInstruction | PostInstruction)[]>>, name = "Weekday Growth") => {
    const id = cs.create({ name, text: "the text", accountSetId: null, defaultPostTimes: opts.defaults ?? ["09:00", "18:00"], dailyPostCap: opts.cap });
    cs.confirm(id, { version: 1, days: { ...emptyDays(), ...days }, rules: [] });
    return id;
  };
  /** Runs the worker until nothing it started is still going. */
  const tick = async () => { await worker.tick(); await worker.idle(); };
  let nextClip = 1;
  const finishProduction = (taskId: number) => {
    const t = cs.task(taskId)!;
    assert.ok(t.productionId, `task ${taskId} has no production (${t.state} ${t.error ?? ""})`);
    ps.setState(t.productionId, { state: "ready", outputPath: clips[nextClip++], durationSec: 4 });
  };
  const finishEdit = (taskId: number) => {
    const t = cs.task(taskId)!;
    assert.ok(t.editId, `task ${taskId} has no edit (${t.state} ${t.error ?? ""})`);
    const e = store.edit(t.editId)!;
    if (e.state !== "ready") store.updateEdit(e.id, { state: "ready", outputPath: e.sourcePath, durationSec: 4, progress: 1 });
  };
  /** The task's review is made ready and the user taps Approve. */
  const approve = async (taskId: number) => {
    const t = cs.task(taskId)!;
    assert.equal(t.state, "reviewing", t.error ?? "");
    await reviews.tick();
    const r = reviews.reviews.get(t.reviewId!)!;
    assert.equal(r.state, "pending", r.error ?? "");
    assert.equal(r.requestedVia, "campaign");
    const out = await reviews.approve(r.id, { via: "window" });
    assert.ok(out.ok, out.message);
    return reviews.reviews.get(r.id)!;
  };
  /** One make task from queued to waiting for its review. */
  const toReview = async (taskId: number) => {
    await tick();
    finishProduction(taskId);
    await tick();
    finishEdit(taskId);
    await tick();
    assert.equal(cs.task(taskId)!.state, "reviewing", cs.task(taskId)!.error ?? "");
  };
  return { store, cs, clock, reviews, ps, staged, gpu, asked, askedOpts, audio, worker, make, postLine, campaign, tick, finishProduction, finishEdit, approve, toReview, hooks, angles, cta };
}

const tasksOf = (cs: CampaignStore, id: number) => cs.db.prepare("SELECT id, date FROM campaign_tasks WHERE campaign_id = ? ORDER BY id").all(id) as { id: number; date: string }[];

test("materialize twice on the same day creates tasks once", () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(2, { at: "default" })] });
  assert.equal(s.worker.materialize(), 2);
  assert.equal(s.worker.materialize(), 0);
  s.clock.now += 6 * 3_600_000;
  assert.equal(s.worker.materialize(), 0);
  assert.equal(tasksOf(s.cs, id).length, 2);
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-17").map((t) => t.copy), [0, 1]);
});

test("app closed at midnight: start next morning creates today's tasks only, never yesterday's", () => {
  const s = setup();
  const id = s.campaign({ mon: [s.make(1, { at: "default" })], tue: [s.make(1, { at: "10:00" })] });
  // Never ran on Monday; it starts Tuesday morning.
  assert.equal(s.worker.materialize(), 1);
  const tasks = tasksOf(s.cs, id);
  assert.deepEqual(tasks.map((t) => t.date), ["2026-11-17"]);
  assert.equal(s.cs.tasksOn(id, "2026-11-16").length, 0, "Monday is never back-filled");
  // Just after midnight: Wednesday has nothing, and Tuesday isn't made again.
  s.clock.now = at(2026, 11, 18, 0, 1);
  assert.equal(s.worker.materialize(), 0);
});

test("DST spring-forward day still gets exactly one set of tasks", () => {
  const s = setup();
  const id = s.campaign({ sat: [s.make(1, { at: "default" })], sun: [s.make(2, { at: "02:30" })] });
  // 14 March 2027: clocks jump from 02:00 to 03:00 in New York.
  s.clock.now = at(2027, 3, 13, 8, 0); // before Saturday's 09:00 (a time already passed would be next week's)
  assert.equal(s.worker.materialize(), 1);
  s.clock.now = at(2027, 3, 14, 0, 30);
  assert.equal(s.worker.materialize(), 2);
  s.clock.now = at(2027, 3, 14, 1, 59);
  assert.equal(s.worker.materialize(), 0);
  s.clock.now = at(2027, 3, 14, 3, 1);
  assert.equal(s.worker.materialize(), 0);
  s.clock.now = at(2027, 3, 14, 23, 59);
  assert.equal(s.worker.materialize(), 0);
  assert.deepEqual(tasksOf(s.cs, id).map((t) => t.date), ["2027-03-13", "2027-03-14", "2027-03-14"]);
  // 02:30 doesn't exist that day: it lands at 03:30 daylight time, still on the 14th.
  const landed = new Date(localAt("2027-03-14", "02:30"));
  assert.deepEqual([landed.getDate(), landed.getHours(), landed.getMinutes()], [14, 3, 30]);
});

test("DST fall-back day (01:30 happens twice) still gets exactly one set of tasks", () => {
  const s = setup();
  const id = s.campaign({ sun: [s.make(2, { at: "01:30" })] });
  // 7 November 2027: clocks go back from 02:00 to 01:00 in New York.
  const first = at(2027, 11, 7, 1, 30);
  s.clock.now = at(2027, 11, 7, 0, 10);
  assert.equal(s.worker.materialize(), 2);
  for (const now of [first, first + 3_600_000, at(2027, 11, 7, 23, 59)]) {
    s.clock.now = now;
    assert.equal(new Date(now).getDate(), 7);
    assert.equal(s.worker.materialize(), 0);
  }
  assert.deepEqual(tasksOf(s.cs, id).map((t) => t.date), ["2027-11-07", "2027-11-07"]);
  s.clock.now = at(2027, 11, 8, 0, 0);
  assert.equal(s.worker.materialize(), 0, "Monday has nothing");
});

test("random never repeats an angle within one day's batch when the library has enough", () => {
  for (let run = 0; run < 5; run++) {
    const s = setup();
    const id = s.campaign({ tue: [s.make(2, { at: "default" }), s.make(1, null)] });
    for (let i = 0; i < run; i++) s.worker.random();
    s.worker.materialize();
    const tasks = s.cs.tasksOn(id, "2026-11-17");
    assert.equal(tasks.length, 3);
    const angles = tasks.map((t) => (t.choices.angle as { id: number }).id);
    assert.equal(new Set(angles).size, 3, `run ${run}: ${angles.join(",")}`);
    const hooks = tasks.map((t) => (t.choices.hook as { id: number }).id);
    assert.equal(new Set(hooks).size, 3, `run ${run}: hooks ${hooks.join(",")}`);
    for (const a of angles) assert.ok(s.angles.includes(a));
  }
});

test("make without post ends 'kept' with the WeekdayGrowth-Tue-1 name and no jobs", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, null)] });
  s.worker.materialize();
  const [task] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(task.id);
  // The script, the voiceover and the music came first; the audio waited for the GPU.
  assert.equal(s.asked.length, 1);
  assert.ok(s.audio.some((a) => a.startsWith("speech:")) && s.audio.some((a) => a.startsWith("music:")));
  assert.ok(s.gpu.length >= 1, "speech and music borrow the production GPU lane");
  assert.equal(s.staged.length, 1);
  assert.ok(s.staged[0].audio.voiceover && s.staged[0].audio.music, "the production gets the voiceover and music");
  const r = await s.approve(task.id);
  assert.equal(r.postId, null, "no post is made for a kept video");
  await s.tick();
  const done = s.cs.task(task.id)!;
  assert.equal(done.state, "kept", done.error ?? "");
  assert.equal(done.choices.libraryName, "WeekdayGrowth-Tue-1");
  assert.equal((s.store.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 0);
  assert.equal((s.store.db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n, 0);
});

test("post line finds a kept video by name and schedules it at the line's time", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, null), s.postLine("weekdaygrowth-tue-1", "20:00")] });
  s.worker.materialize();
  const [make, post] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  assert.equal(s.cs.task(post.id)!.state, "queued", "nothing by that name yet: it waits");
  await s.toReview(make.id);
  await s.approve(make.id);
  await s.tick();
  assert.equal(s.cs.task(make.id)!.state, "kept");
  await s.tick();
  const p = s.cs.task(post.id)!;
  assert.equal(p.state, "reviewing", p.error ?? "");
  assert.equal(p.editId, s.cs.task(make.id)!.editId, "same style: the kept edit itself");
  const r = await s.approve(post.id);
  assert.ok(r.postId);
  assert.equal(s.store.jobsForPost(r.postId).every((j) => j.nextRunAt === Number.MAX_SAFE_INTEGER), true, "held until the campaign places it");
  await s.tick();
  const done = s.cs.task(post.id)!;
  assert.equal(done.state, "scheduled", done.error ?? "");
  assert.equal(done.postId, r.postId);
  const when = at(2026, 11, 17, 20);
  assert.equal(s.store.post(r.postId)!.scheduledAt, when);
  assert.deepEqual(s.store.jobsForPost(r.postId).map((j) => j.nextRunAt), [when]);
  const labels = new AnalyticsStore(s.store).labels(r.postId)!;
  assert.equal(labels.source, "generated");
  assert.equal(labels.labelledBy, "campaign");
  assert.equal(labels.campaignId, id);
  assert.equal(labels.campaignTaskId, post.id);
  assert.equal(labels.ctaId, s.cta);
  assert.equal(labels.styleId, "basic");
});

test("a post line whose video never turns up is missed at the end of the day, with a notification", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.postLine("Nowhere", "20:00")] });
  s.worker.materialize();
  const [post] = s.cs.tasksOn(id, "2026-11-17");
  s.clock.now = at(2026, 11, 17, 23, 59);
  await s.tick();
  assert.equal(s.cs.task(post.id)!.state, "queued");
  s.clock.now = at(2026, 11, 18, 0, 0);
  await s.tick();
  assert.equal(s.cs.task(post.id)!.state, "missed");
  assert.ok(s.store.eventByKey(`campaign.missed:${post.id}`));
});

test("approval on a later day uses the next free default time; cap counts the posting day", async () => {
  const s = setup({ cap: 1 });
  const id = s.campaign({ tue: [s.make(3, { at: "default" })] });
  s.worker.materialize();
  const tasks = s.cs.tasksOn(id, "2026-11-17");
  for (const t of tasks) await s.toReview(t.id);
  // Approved the next day at 10:00: Wednesday's 09:00 has gone, 18:00 is free.
  s.clock.now = at(2026, 11, 18, 10);
  await s.approve(tasks[0].id);
  await s.tick();
  const first = s.cs.task(tasks[0].id)!;
  assert.equal(first.state, "scheduled", first.error ?? "");
  assert.equal(s.store.post(first.postId!)!.scheduledAt, at(2026, 11, 18, 18));
  // The cap is 1 a day: Wednesday is full, so the next goes at Thursday's first default time.
  await s.approve(tasks[1].id);
  await s.tick();
  const second = s.cs.task(tasks[1].id)!;
  assert.equal(s.store.post(second.postId!)!.scheduledAt, at(2026, 11, 19, 9));
  // Approved on Thursday after 09:00: Thursday is taken by the second, so Friday 09:00.
  s.clock.now = at(2026, 11, 19, 12);
  await s.approve(tasks[2].id);
  await s.tick();
  const third = s.cs.task(tasks[2].id)!;
  assert.equal(s.store.post(third.postId!)!.scheduledAt, at(2026, 11, 20, 9));
});

test("approved the same day after its time posts now", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "09:00" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  s.clock.now = at(2026, 11, 17, 15);
  await s.approve(t.id);
  await s.tick();
  const done = s.cs.task(t.id)!;
  assert.equal(done.state, "scheduled");
  assert.equal(s.store.post(done.postId!)!.scheduledAt, at(2026, 11, 17, 15));
});

test("kill switch stops scheduling but lets renders finish", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(2, { at: "default" })] });
  s.worker.materialize();
  const [a, b] = s.cs.tasksOn(id, "2026-11-17");
  // a is already scheduled before the switch.
  await s.toReview(a.id);
  await s.approve(a.id);
  await s.tick();
  assert.equal(s.cs.task(a.id)!.state, "scheduled");
  const aPost = s.cs.task(a.id)!.postId!;
  const aTime = s.store.jobsForPost(aPost)[0].nextRunAt;
  // b is rendering.
  assert.equal(s.cs.task(b.id)!.state, "rendering");
  const held = s.worker.stopAll();
  assert.equal(held, 1);
  assert.equal(s.store.jobsForPost(aPost)[0].nextRunAt, Number.MAX_SAFE_INTEGER, "a scheduled post is held");
  assert.equal(s.store.jobsForPost(aPost)[0].progress.heldFrom, aTime);
  // A task made while stopped waits; b's render finishes and goes on to review.
  const other = s.campaign({ tue: [s.make(1, { at: "default" })] }, "Other");
  assert.equal(s.worker.materialize(), 1);
  const [c] = s.cs.tasksOn(other, "2026-11-17");
  s.finishProduction(b.id);
  await s.tick();
  s.finishEdit(b.id);
  await s.tick();
  assert.equal(s.cs.task(b.id)!.state, "reviewing");
  assert.equal(s.cs.task(c.id)!.state, "queued", "nothing new starts while stopped");
  const r = await s.approve(b.id);
  await s.tick();
  assert.equal(s.cs.task(b.id)!.state, "reviewing", "approved, but it doesn't post while stopped");
  assert.ok(s.store.jobsForPost(r.postId!).every((j) => j.nextRunAt === Number.MAX_SAFE_INTEGER));
  // Resume: a goes back to its time, b is placed, c starts.
  s.worker.resumeAll();
  assert.equal(s.store.jobsForPost(aPost)[0].nextRunAt, aTime);
  assert.equal(s.store.jobsForPost(aPost)[0].progress.heldFrom, undefined);
  await s.tick();
  assert.equal(s.cs.task(b.id)!.state, "scheduled");
  assert.ok(s.store.jobsForPost(r.postId!).every((j) => j.nextRunAt < Number.MAX_SAFE_INTEGER));
  assert.notEqual(s.cs.task(c.id)!.state, "queued");
});

test("editing the text mid-render: in-flight tasks finish, no new tasks until confirmed", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "10:00" })], wed: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "rendering");
  const compiled = s.cs.campaign(id)!.compiled!;
  s.cs.setText(id, "something else entirely");
  assert.equal(s.worker.materialize(new Date(at(2026, 11, 18, 8))), 0, "not runnable: Wednesday would get nothing");
  // The new text moves Tuesday's video to 21:00 and is confirmed while the old task is still rendering.
  const changed = structuredClone(compiled);
  (changed.days.tue[0] as MakeInstruction).post = { at: "21:00" };
  s.cs.confirm(id, changed);
  assert.equal(s.worker.materialize(), 0, "Tuesday's line was already made");
  s.finishProduction(t.id);
  await s.tick();
  s.finishEdit(t.id);
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "reviewing");
  assert.deepEqual(s.cs.task(t.id)!.choices.instruction, compiled.days.tue[0]);
  await s.approve(t.id);
  await s.tick();
  const done = s.cs.task(t.id)!;
  assert.equal(done.state, "scheduled", "the in-flight task still posts");
  assert.equal(s.store.post(done.postId!)!.scheduledAt, at(2026, 11, 17, 10), "at the time it was made with, not the new one");
  s.clock.now = at(2026, 11, 18, 8);
  assert.equal(s.worker.materialize(), 1, "confirmed again: Wednesday's tasks are made");
});

test("one failed task doesn't stop the others; it fails with a notification", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(2, { at: "default" })] });
  s.worker.materialize();
  const [a, b] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  s.ps.setState(s.cs.task(a.id)!.productionId!, { state: "failed", error: "out of memory" });
  s.finishProduction(b.id);
  await s.tick();
  assert.equal(s.cs.task(a.id)!.state, "failed");
  assert.match(s.cs.task(a.id)!.error!, /out of memory/);
  assert.ok(s.store.eventByKey(`campaign.failed:${a.id}`));
  assert.equal(s.cs.task(b.id)!.state, "editing");
});

test("a failed task can be retried from the window, from the step that failed", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  const firstProduction = s.cs.task(t.id)!.productionId!;
  s.ps.setState(firstProduction, { state: "failed", error: "out of memory" });
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "failed");

  // The failed production is dropped, the script and audio are kept, and it renders again.
  assert.equal(s.worker.retryTask(t.id), null);
  const retried = s.cs.task(t.id)!;
  assert.equal(retried.state, "rendering", retried.error ?? "");
  assert.equal(retried.productionId, null);
  assert.equal(s.asked.length, 1, "the script isn't written again");
  await s.tick();
  assert.notEqual(s.cs.task(t.id)!.productionId, firstProduction);
  assert.ok(s.cs.task(t.id)!.choices.script, "the script is reused");
});

test("retrying a failed edit keeps the finished video and edits it again", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  s.finishProduction(t.id);
  await s.tick();
  const productionId = s.cs.task(t.id)!.productionId!;
  const editId = s.cs.task(t.id)!.editId!;
  s.store.updateEdit(editId, { state: "failed", error: "render broke" });
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "failed");

  assert.equal(s.worker.retryTask(t.id), null);
  const retried = s.cs.task(t.id)!;
  assert.equal(retried.state, "rendering", retried.error ?? "");
  assert.equal(retried.productionId, productionId, "the finished video is kept");
  assert.equal(retried.editId, null);
  await s.tick();
  assert.notEqual(s.cs.task(t.id)!.editId, editId);
});

test("only a failed task can be retried", () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  assert.match(s.worker.retryTask(t.id)!, /failed/);
  assert.equal(s.worker.retryTask(9999), "no such task");
});

test("a campaign's video can't be sent for review another way while its task is in flight", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  s.finishProduction(t.id);
  const productionId = s.cs.task(t.id)!.productionId!;
  await assert.rejects(
    s.reviews.request({ subject: { kind: "production", id: productionId }, accountIds: [1], caption: "x", title: "x", scheduledAt: null, tiktok: null, allowDuplicate: false, via: "agent" }),
    /campaign/,
  );
});

/** A keep video and the post line after it, from queued to the post line's placed post. */
async function keepThenPost(s: ReturnType<typeof setup>, campaignId: number, date: string) {
  s.worker.materialize();
  const [make, post] = s.cs.tasksOn(campaignId, date);
  await s.toReview(make.id);
  await s.approve(make.id);
  await s.tick();
  assert.equal(s.cs.task(make.id)!.state, "kept");
  await s.tick();
  const r = await s.approve(post.id);
  await s.tick();
  assert.equal(s.cs.task(post.id)!.state, "scheduled", s.cs.task(post.id)!.error ?? "");
  return { make: s.cs.task(make.id)!, post: s.cs.task(post.id)!, postId: r.postId! };
}

test("two weeks: each week's post line posts that week's kept video, and a used one is never taken again", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, null), s.postLine("WeekdayGrowth-Tue-1", "20:00")] });
  const one = await keepThenPost(s, id, "2026-11-17");
  assert.equal(one.post.choices.sourceTaskId, one.make.id);
  assert.equal(one.make.state, "posted", "the kept video is used once its post exists");
  assert.equal(one.make.postId, one.postId);
  s.clock.now = at(2026, 11, 24, 8);
  const two = await keepThenPost(s, id, "2026-11-24");
  assert.equal(two.make.choices.libraryName, "WeekdayGrowth-Tue-1");
  assert.equal(two.post.choices.sourceTaskId, two.make.id, "week 2 posts week 2's video");
  assert.notEqual(s.store.post(two.postId)!.sha256, s.store.post(one.postId)!.sha256);
});

test("two keep instructions on one day get distinct names", () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, null), s.make(1, { at: "default" }), s.make(2, null)] });
  s.worker.materialize();
  const names = s.cs.tasksOn(id, "2026-11-17").map((t) => t.choices.libraryName ?? null);
  assert.deepEqual(names, ["WeekdayGrowth-Tue-1", null, "WeekdayGrowth-Tue-2", "WeekdayGrowth-Tue-3"]);
});

test("two post lines with one name: the first takes the video, the second is missed", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, null), s.postLine("WeekdayGrowth-Tue-1", "20:00"), s.postLine("WeekdayGrowth-Tue-1", "21:00")] });
  const { make } = await keepThenPost(s, id, "2026-11-17");
  const second = s.cs.tasksOn(id, "2026-11-17")[2];
  assert.equal(s.cs.task(second.id)!.state, "queued");
  assert.equal(make.state, "posted");
  s.clock.now = at(2026, 11, 18, 0, 0);
  await s.tick();
  assert.equal(s.cs.task(second.id)!.state, "missed");
});

test("a kept or posted campaign video can't be sent for review by an agent", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, null), s.postLine("WeekdayGrowth-Tue-1", "20:00")] });
  const { make, post } = await keepThenPost(s, id, "2026-11-17");
  const ask = (subject: { kind: "production" | "edit"; id: number }) =>
    s.reviews.request({ subject, accountIds: [1], caption: "x", title: "x", scheduledAt: null, tiktok: null, allowDuplicate: true, via: "agent" });
  await assert.rejects(ask({ kind: "production", id: make.productionId! }), /campaign/);
  await assert.rejects(ask({ kind: "edit", id: make.editId! }), /campaign/);
  await assert.rejects(ask({ kind: "edit", id: post.editId! }), /campaign/);
});

const onDay = (s: ReturnType<typeof setup>, campaignId: number, day: string) =>
  s.cs.db.prepare("SELECT p.scheduled_at AS at FROM campaign_tasks t JOIN posts p ON p.id = t.post_id WHERE t.campaign_id = ?").all(campaignId)
    .map((r: any) => r.at as number).filter((ms) => new Date(ms).toDateString() === new Date(`${day}T12:00:00`).toDateString()).length;

test("killed Monday, resumed Wednesday: held posts are placed again under the cap", async () => {
  const s = setup({ cap: 1 });
  s.clock.now = at(2026, 11, 16, 7);
  const id = s.campaign({ mon: [s.make(2, { at: "default" })] });
  s.worker.materialize();
  const [a, b] = s.cs.tasksOn(id, "2026-11-16");
  for (const t of [a, b]) {
    await s.toReview(t.id);
    await s.approve(t.id);
    await s.tick();
  }
  assert.equal(s.store.post(s.cs.task(a.id)!.postId!)!.scheduledAt, at(2026, 11, 16, 9));
  assert.equal(s.store.post(s.cs.task(b.id)!.postId!)!.scheduledAt, at(2026, 11, 17, 9), "Monday is full: Tuesday 09:00");
  s.clock.now = at(2026, 11, 16, 8);
  s.worker.stopAll();
  s.clock.now = at(2026, 11, 18, 10);
  s.worker.resumeAll();
  await s.tick();
  assert.ok(onDay(s, id, "2026-11-18") <= 1, `Wednesday has ${onDay(s, id, "2026-11-18")} posts`);
  for (const t of [a, b]) {
    const postId = s.cs.task(t.id)!.postId!;
    const jobs = s.store.jobsForPost(postId);
    assert.equal(jobs[0].nextRunAt, s.store.post(postId)!.scheduledAt, "the post's time moves with its jobs");
    assert.ok(jobs[0].nextRunAt >= s.clock.now);
  }
  assert.deepEqual([a, b].map((t) => s.store.post(s.cs.task(t.id)!.postId!)!.scheduledAt), [at(2026, 11, 18, 18), at(2026, 11, 19, 9)]);
});

test("a post that can't be placed is cancelled, never left held", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  s.cs.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
  const r = await s.approve(t.id);
  assert.ok(s.store.post(r.postId!));
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "failed");
  assert.equal(s.store.post(r.postId!), undefined, "the held post is cancelled");
});

test("approving a review whose task already failed cancels the held post and says so", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  await s.reviews.tick();
  s.worker.fail(t.id, "something broke");
  const reviewId = s.cs.task(t.id)!.reviewId!;
  const out = await s.reviews.approve(reviewId, { via: "window" });
  const postId = s.reviews.reviews.get(reviewId)!.postId;
  assert.ok(out.ok && postId);
  await s.tick();
  assert.equal(s.store.post(postId), undefined);
  assert.ok(s.store.eventByKey(`campaign.failed:post:${postId}`));
});

test("while stopped, a job that fails into a retry stays held, and a held retry that tried is never deleted, and is failed (not stranded) once its task stops", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "default" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  await s.approve(t.id);
  await s.tick();
  const postId = s.cs.task(t.id)!.postId!;
  const [job] = s.store.jobsForPost(postId);
  s.store.db.prepare("UPDATE jobs SET state = 'running', attempts = 1 WHERE id = ?").run(job.id);
  s.worker.stopAll();
  assert.equal(s.store.job(job.id)!.nextRunAt, job.nextRunAt, "a running job isn't touched");
  s.store.finishJob(job.id, "retry", { error: "timeout", nextRunAt: Date.now() + 30_000 });
  assert.equal(s.store.job(job.id)!.nextRunAt, Number.MAX_SAFE_INTEGER, "it fell into a retry while stopped: held");
  // It tried once (it may have half-made a post on the platform): cancelling never deletes it.
  const { cancelled } = s.store.cancelPost(postId);
  assert.equal(cancelled, 0);
  assert.ok(s.store.post(postId));
  // Its task stops: the post isn't left held forever; the job is finished as failed, in the history, and the user told.
  s.cs.updateTask(t.id, { state: "failed", error: "stopped" });
  await s.tick();
  const stopped = s.store.job(job.id)!;
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.progress.heldFrom, undefined);
  assert.match(stopped.error ?? "", /already started on x/);
  assert.match(JSON.parse(s.store.eventByKey(`campaign.failed:post:${postId}`)!.body).summary, /check x for a leftover draft/);
});

test("two campaign posts never share a minute", async () => {
  const s = setup();
  const a = s.campaign({ tue: [s.make(1, { at: "09:00" })] }, "One");
  const b = s.campaign({ tue: [s.make(1, { at: "09:00" })] }, "Two");
  s.worker.materialize();
  const [ta] = s.cs.tasksOn(a, "2026-11-17");
  const [tb] = s.cs.tasksOn(b, "2026-11-17");
  for (const t of [ta, tb]) { await s.toReview(t.id); await s.approve(t.id); await s.tick(); }
  assert.deepEqual([ta, tb].map((t) => s.store.post(s.cs.task(t.id)!.postId!)!.scheduledAt), [at(2026, 11, 17, 9), at(2026, 11, 17, 9, 1)]);
});

test("random and best never pick a hook or angle another campaign's Autorun added; its own campaign can", () => {
  const s = setup();
  const a = s.campaign({ tue: [s.make(6, null, { hook: { pick: "random" }, angle: { pick: "best" } })] }, "A");
  const b = s.campaign({ tue: [s.make(6, null)] }, "B");
  const bHook = s.cs.addEntry({ kind: "hook", name: "b-only", text: "only for B", ownerCampaignId: b });
  const bAngle = s.cs.addEntry({ kind: "angle", name: "b-angle", text: "only for B", ownerCampaignId: b });
  s.worker.materialize();
  const pickedBy = (id: number, kind: "hook" | "angle") => s.cs.tasksOn(id, "2026-11-17").map((t) => (t.choices[kind] as { id: number }).id);
  assert.ok(!pickedBy(a, "hook").includes(bHook), pickedBy(a, "hook").join(","));
  assert.ok(!pickedBy(a, "angle").includes(bAngle), pickedBy(a, "angle").join(","));
  assert.ok(pickedBy(b, "hook").includes(bHook), "B's random picks use its own hook");
});

/** A campaign post scheduled on Tuesday whose one upload then failed for good (its task failed with it). */
async function failedCampaignJob(s: ReturnType<typeof setup>, campaignId: number) {
  s.worker.materialize();
  const [t] = s.cs.tasksOn(campaignId, "2026-11-17");
  await s.toReview(t.id);
  await s.approve(t.id);
  await s.tick();
  const postId = s.cs.task(t.id)!.postId!;
  const [job] = s.store.jobsForPost(postId);
  s.store.db.prepare("UPDATE jobs SET state = 'running', attempts = 1 WHERE id = ?").run(job.id);
  s.store.finishJob(job.id, "failed", { error: "the platform said no" });
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "failed", s.cs.task(t.id)!.error ?? "");
  return { t, postId, job };
}

test("retry_job on a campaign job while campaigns are stopped re-queues it held: it never goes out until resume", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "18:00" })] });
  const { t, job } = await failedCampaignJob(s, id);
  s.worker.stopAll();
  assert.equal(s.store.retryJob(job.id), null);
  const retried = s.store.job(job.id)!;
  assert.equal(retried.state, "queued");
  assert.equal(retried.nextRunAt, Number.MAX_SAFE_INTEGER, "held: the kill switch covers a retry too");
  assert.equal(s.store.claimNextJob(new Set()), undefined, "nothing for the runner to publish");
  await s.tick();
  assert.equal(s.store.job(job.id)!.nextRunAt, Number.MAX_SAFE_INTEGER, "still held while stopped");
  assert.equal(s.cs.task(t.id)!.state, "scheduled", "its task waits to place it again");
  s.worker.resumeAll();
  assert.equal(s.store.job(job.id)!.nextRunAt, at(2026, 11, 17, 18), "placed again at its own time");
});

test("a retried campaign job is placed again like an approval: its day's timing and the daily cap apply", async () => {
  const s = setup({ cap: 1, defaults: ["09:00"] });
  const id = s.campaign({ tue: [s.make(1, { at: "18:00" })], wed: [s.make(1, { at: "09:00" })] });
  const { t, job } = await failedCampaignJob(s, id);
  // Wednesday morning: Wednesday's own video already takes the day's one slot.
  s.clock.now = at(2026, 11, 18, 8);
  s.worker.materialize();
  const [w] = s.cs.tasksOn(id, "2026-11-18");
  await s.toReview(w.id);
  await s.approve(w.id);
  await s.tick();
  assert.equal(s.cs.task(w.id)!.state, "scheduled");
  assert.equal(s.store.retryJob(job.id), null);
  assert.equal(s.store.job(job.id)!.nextRunAt, Number.MAX_SAFE_INTEGER, "held until the worker places it");
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "scheduled", s.cs.task(t.id)!.error ?? "");
  assert.equal(s.store.job(job.id)!.nextRunAt, at(2026, 11, 19, 9), "not now: Wednesday is full, so Thursday's default time");
});

test("a campaign job whose post no campaign task owns can't be retried", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "18:00" })] });
  const { t, job } = await failedCampaignJob(s, id);
  s.store.db.prepare("DELETE FROM campaign_tasks WHERE id = ?").run(t.id);
  assert.match(s.store.retryJob(job.id) ?? "", /no campaign task/);
  assert.equal(s.store.job(job.id)!.state, "failed");
});

test("retrying a failed campaign video whose upload failed re-queues the upload and places it again", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "18:00" })] });
  const { t, job } = await failedCampaignJob(s, id);
  assert.equal(s.worker.retryTask(t.id), null);
  assert.equal(s.store.job(job.id)!.state, "queued", "the upload is queued again");
  assert.equal(s.store.job(job.id)!.nextRunAt, Number.MAX_SAFE_INTEGER, "held until the campaign worker places it");
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "scheduled", s.cs.task(t.id)!.error ?? "");
  assert.equal(s.store.job(job.id)!.nextRunAt, at(2026, 11, 17, 18), "placed again at its own time");
});

test("a campaign task (and a rule task) waits for tomorrow's AI budget instead of failing, says so once, and runs after midnight", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "18:00" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  const ruleTask = s.cs.addTask({ campaignId: id, date: "2026-11-17", dayIndex: 2, instructionIndex: 0, copy: 9, kind: "rule", choices: s.cs.task(t.id)!.choices })!;
  s.store.setPref("ai.budget.calls", 0);
  await s.tick();
  for (const task of [s.cs.task(t.id)!, s.cs.task(ruleTask)!]) {
    assert.equal(task.state, "queued", task.error ?? "");
    assert.equal(task.error, null, "not a failure");
    assert.match(String((task.choices as any).waiting), /tomorrow's AI budget/);
  }
  assert.equal(s.store.eventByKey(`campaign.failed:${t.id}`), undefined, "no failure notification");
  const ev = s.store.eventByKey(`campaign.waiting:${t.id}:2026-11-17`);
  assert.ok(ev, "the user is told it waits");
  assert.match(JSON.parse(ev.body).summary, /tries again after midnight/);
  // Still today: it isn't tried again.
  const asked = s.asked.length;
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "queued");
  assert.equal(s.asked.length, asked);
  // Tomorrow, with budget again: it's made, and placed later the way any late approval is.
  s.store.setPref("ai.budget.calls", 50);
  s.clock.now = at(2026, 11, 18, 8);
  await s.tick();
  const next = s.cs.task(t.id)!;
  assert.equal(next.state, "rendering", next.error ?? "");
  assert.equal((next.choices as any).waiting, undefined);
});

// ---- the campaign table ----

const tableRow = (s: ReturnType<typeof setup>, extra: Partial<Row> = {}): Row => ({
  id: 1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "named", id: s.cta }, style: "basic",
  type: null, time: "09:00", days: ["tue"], sec: 9, origin: "create", model: null, text: "", ...extra, // the stand-in AI's scripts run 9 seconds
});
const tableCampaign = (s: ReturnType<typeof setup>, rows: Row[], name = "Table") => {
  const id = s.cs.create({ name, text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 100 });
  s.cs.setRows(id, rows);
  return id;
};

test("table rows: a task is named by its row, so adding or removing rows mid-day never re-makes or skips one", () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { id: 1, quantity: 2 }), tableRow(s, { id: 2 })]);
  assert.equal(s.worker.materialize(), 3);
  // row 1 removed and a new row 3 put first: row 2 isn't made again, row 3 is made
  s.cs.setRows(id, [tableRow(s, { id: 3 }), tableRow(s, { id: 2 })]);
  assert.equal(s.worker.materialize(), 1);
  const tasks = s.cs.tasksOn(id, "2026-11-17");
  assert.deepEqual(tasks.map((t) => t.instructionIndex).sort(), [100_001, 100_001, 100_002, 100_003]);
  // a row with no days, or a Drive row with no file name, makes nothing
  s.cs.setRows(id, [tableRow(s, { id: 4, days: [] }), tableRow(s, { id: 5, origin: "drive", text: "" })]);
  assert.equal(s.worker.materialize(), 0);
});

test("a Create row's instructions and length go to the script writer", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { text: "Show the app on a phone", sec: 120 })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  assert.ok(t);
  assert.match(s.asked[0].prompt, /The owner's instructions for this video:\nShow the app on a phone/);
  assert.match(s.asked[0].prompt, /about 120 seconds/);
});

test("a Drive row's named hook, angle and CTA and its length label the post it makes", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { origin: "drive", text: "Gatekeeping", hook: { pick: "named", id: s.hooks[1] }, angle: { pick: "random" }, sec: 45 })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  const c = t.choices as any;
  assert.equal(t.kind, "post");
  assert.equal(c.hook.id, s.hooks[1]);
  assert.equal(c.angle, undefined, "random would only guess what a recorded video says");
  assert.equal(c.cta.id, s.cta);
  assert.equal(c.postTime, "09:00");
  assert.equal(c.instruction.sec, 45);
});

test("Stop Campaign holds only its own posts and starts nothing new for it; Start Campaign lets them go", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { quantity: 2, time: "18:00" })]);
  const other = tableCampaign(s, [tableRow(s, { time: "19:00" })], "Other");
  s.worker.materialize();
  const [a, b] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(a.id);
  await s.approve(a.id);
  await s.tick();
  assert.equal(s.cs.task(a.id)!.state, "scheduled");
  const aPost = s.cs.task(a.id)!.postId!;
  const aTime = s.store.jobsForPost(aPost)[0].nextRunAt;
  assert.equal(s.cs.task(b.id)!.state, "rendering");

  assert.equal(s.worker.stopCampaign(id), 1);
  assert.equal(s.cs.campaign(id)!.enabled, false);
  assert.equal(s.store.jobsForPost(aPost)[0].nextRunAt, Number.MAX_SAFE_INTEGER, "its scheduled post is held");
  // its render finishes and is reviewed, but an approval stays held; the other campaign goes on
  s.finishProduction(b.id);
  await s.tick();
  s.finishEdit(b.id);
  await s.tick();
  const r = await s.approve(b.id);
  await s.tick();
  assert.equal(s.cs.task(b.id)!.state, "reviewing", "approved, but it doesn't post while its campaign is stopped");
  assert.ok(s.store.jobsForPost(r.postId!).every((j) => j.nextRunAt === Number.MAX_SAFE_INTEGER));
  assert.equal(s.store.jobsForPost(aPost)[0].nextRunAt, Number.MAX_SAFE_INTEGER, "a tick doesn't release it");
  const [o] = s.cs.tasksOn(other, "2026-11-17");
  assert.notEqual(s.cs.task(o.id)!.state, "queued", "another campaign isn't stopped");
  // tomorrow's tasks aren't made while it's stopped
  s.clock.now = at(2026, 11, 18, 8);
  s.cs.setRows(id, [tableRow(s, { quantity: 2, time: "18:00", days: ["tue", "wed"] })]);
  s.worker.materialize();
  assert.equal(s.cs.tasksOn(id, "2026-11-18").length, 0);
  s.clock.now = TUE + 60_000;

  assert.equal(s.worker.startCampaign(id), 1);
  assert.equal(s.store.jobsForPost(aPost)[0].nextRunAt, aTime, "its held post goes back to its time");
  await s.worker.idle();
  await s.tick();
  assert.equal(s.cs.task(b.id)!.state, "scheduled");
});

// ---- agent films ----

const HOUR = 3_600_000;
const LOOK = { key: "lemo:ukiyo-e", name: "Ukiyo-e", description: "woodblock prints", needsImageGen: false, libraryVersion: "1.4.0" };
/** An agent's caption with the campaign CTA's link, as every agent caption must carry. */
const AGENT_CAPTION = "Woodblock week https://example.com/plan";
/** Claims a brief and returns the claim token. */
const claimed = (cs: CampaignStore, id: number, holder: string, now: number) => {
  const r = claimBrief(cs, id, holder, now);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.token;
};

/**
 * An Agent row on Tuesday at 18:00, 5 seconds long (clips[2] is 5 s), in the ukiyo-e look. `edit` gives its schedule
 * a FreePoster style too, as a schedule saved before Lemo films stopped being edited could have.
 */
function agentSetup(extra: Partial<Row> = {}, edit?: string) {
  const s = setup();
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  const id = tableCampaign(s, [tableRow(s, { origin: "agent", style: LOOK.key, time: "18:00", sec: 5, ...extra })]);
  if (edit) {
    const compiled = s.cs.campaign(id)!.compiled!;
    (compiled.days.tue[0] as MakeInstruction).style = edit;
    s.cs.confirm(id, compiled);
  }
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  /** The brief is posted (12:00), claimed and delivered with a clip. */
  const deliver = async (opts: { caption?: string; clip?: string } = {}) => {
    s.clock.now = at(2026, 11, 17, 12);
    await s.tick();
    assert.equal(s.cs.task(t.id)!.state, "awaiting_agent", s.cs.task(t.id)!.error ?? "");
    const token = claimed(s.cs, t.id, "agent-1", s.clock.now);
    const out = await submitBrief(s.store, s.cs, t.id, token, {
      videoPath: opts.clip ?? clips[2], manifest: { look: LOOK.key, libraryVersion: "1.4.0" },
      caption: opts.caption ?? AGENT_CAPTION,
    }, s.clock.now);
    assert.ok(out.ok, out.ok ? "" : out.error);
  };
  const events = (type: string) => s.store.feed(0, 100, [type]);
  return { ...s, id, task: t, deliver, events };
}

test("an agent row waits until six hours before its slot, then posts a brief", async () => {
  const s = agentSetup();
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "queued", "08:00 is too early for an 18:00 slot");
  assert.equal(s.events("brief.requested").length, 0);
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  const c = t.choices as any;
  assert.equal(c.brief.look, LOOK.key);
  assert.equal(c.brief.producer, "lemo-opuscar");
  assert.equal(c.brief.postAt, at(2026, 11, 17, 18));
  assert.equal(c.brief.deadline, at(2026, 11, 17, 17, 30));
  await s.tick();
  const ev = s.events("brief.requested");
  assert.equal(ev.length, 1, "told once");
  const body = JSON.parse(ev[0].body);
  assert.equal(body.campaign_task_id, t.id);
  assert.equal(body.look, LOOK.key);
  assert.equal(body.deadline, new Date(at(2026, 11, 17, 17, 30)).toISOString());
  assert.equal(body.post_at, new Date(at(2026, 11, 17, 18)).toISOString());
  assert.match(body.summary, new RegExp(`call claim_brief with task_id ${t.id}$`));
});

test("brief events say FreePoster handles them when the launcher is on", async () => {
  const off = agentSetup();
  off.clock.now = at(2026, 11, 17, 12);
  await off.tick();
  assert.equal(JSON.parse(off.events("brief.requested")[0].body).handled_by, undefined, "launcher off: an agent claims it");

  const s = agentSetup();
  s.store.setPref("agent.launch.enabled", true);
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  const req = JSON.parse(s.events("brief.requested")[0].body);
  assert.equal(req.handled_by, "freeposter");
  assert.match(req.summary, /FreePoster is starting Claude/);
  assert.doesNotMatch(req.summary, /call claim_brief/);
  claimed(s.cs, s.task.id, "claude-code", s.clock.now);
  s.clock.now += 121 * 60_000;
  await s.tick();
  const exp = JSON.parse(s.events("brief.expired")[0].body);
  assert.equal(exp.handled_by, "freeposter");
  assert.match(exp.summary, /FreePoster is starting Claude/);
});

/** The task's review is made ready and the user asks for a redo with a note. */
async function redoReview(s: ReturnType<typeof agentSetup>, note: string) {
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "reviewing", t.error ?? "");
  await s.reviews.tick();
  const out = await s.reviews.redo(t.reviewId!, { via: "window", reason: null, note });
  assert.ok(out.ok, out.message);
  return t.reviewId!;
}

test("Redo on an agent film opens a new brief round with the note", async () => {
  const s = agentSetup();
  await s.deliver();
  await s.tick();
  const reviewId = await redoReview(s, "make the waves slower");
  const ev = s.store.eventByKey(`review.redo:${reviewId}`)!;
  const body = JSON.parse(ev.body);
  assert.equal(body.handled_by, "freeposter", "no agent is asked to revise an edit");
  assert.match(body.summary, /FreePoster asked the agent for a new film/);
  s.clock.now = at(2026, 11, 17, 13);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  const c = t.choices as any;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  assert.equal(t.reviewId, null);
  assert.equal(t.editId, null);
  assert.equal(c.briefRound, 2);
  assert.equal(c.offers, 0);
  assert.equal(c.lease, undefined);
  assert.equal(c.delivery, undefined);
  assert.match(c.brief.instructions, /Redo: make the waves slower$/);
  assert.equal(c.brief.postAt, at(2026, 11, 17, 18));
  assert.equal(c.brief.deadline, at(2026, 11, 17, 17, 30));
  assert.ok(s.store.eventByKey(`brief.requested:${t.id}:2`), "the new round is announced");
  assert.deepEqual(openBriefs(s.cs, s.clock.now).map((x) => x.id), [t.id]);
});

test("a Redo on an agent film past its deadline misses the slot", async () => {
  const s = agentSetup();
  await s.deliver();
  await s.tick();
  await redoReview(s, "again");
  s.clock.now = at(2026, 11, 17, 17, 40);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "missed", t.error ?? "");
  assert.equal(s.events("brief.requested").length, 1, "no new brief past the deadline");
});

test("an agent film goes brief, claim, submit, Redo, a new round, claim, submit, approve, place, with its labels", async () => {
  const s = agentSetup();
  await s.deliver();
  await s.tick();
  await redoReview(s, "warmer colours");
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "awaiting_agent");
  const token = claimed(s.cs, s.task.id, "agent-2", s.clock.now);
  const out = await submitBrief(s.store, s.cs, s.task.id, token, { videoPath: clips[7], manifest: { look: LOOK.key, libraryVersion: "1.5.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await s.tick();
  const reviewing = s.cs.task(s.task.id)!;
  assert.equal(reviewing.state, "reviewing", reviewing.error ?? "");
  assert.equal(s.reviews.reviews.get(reviewing.reviewId!)!.sourcePath, clips[7], "the new film is reviewed");
  const r = await s.approve(s.task.id);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "scheduled", t.error ?? "");
  assert.equal(s.store.post(r.postId!)!.scheduledAt, at(2026, 11, 17, 18));
  const labels = new AnalyticsStore(s.store).labels(r.postId!)!;
  assert.equal(labels.producer, "lemo-opuscar");
  assert.equal(labels.look, LOOK.key);
  assert.equal(labels.lookVersion, "1.5.0");
});

test("Stop Campaign and the kill switch tell the launcher which campaigns stopped", () => {
  const s = agentSetup();
  const seen: (number | null)[] = [];
  s.worker.onStop = (id) => seen.push(id);
  s.worker.stopCampaign(s.id);
  s.worker.stopAll();
  assert.deepEqual(seen, [s.id, null]);
});

test("an agent row never runs the script writer", async () => {
  const s = agentSetup();
  await s.deliver();
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "reviewing", s.cs.task(s.task.id)!.error ?? "");
  await s.approve(s.task.id);
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "scheduled", s.cs.task(s.task.id)!.error ?? "");
  assert.deepEqual(s.asked, [], "no script was written");
  assert.deepEqual(s.staged, [], "no production was staged");
  assert.deepEqual(s.audio, [], "no WanGP voiceover or music");
});

test("a delivered film with no style goes straight to review as a file", async () => {
  const s = agentSetup();
  await s.deliver({ caption: "Woodblock week, plan it: example.com/plan" });
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "reviewing", t.error ?? "");
  assert.equal(t.editId, null);
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.subjectKind, "file");
  assert.equal(r.sourcePath, clips[2]);
  assert.equal(r.draft.caption, "Woodblock week, plan it: example.com/plan");
});

test("a delivered Lemo film is never edited, even with a style from before", async () => {
  // A schedule saved before Lemo films stopped being edited can still give an Agent row a FreePoster style.
  const s = agentSetup({}, "basic");
  assert.equal((s.cs.task(s.task.id)!.choices as any).style, "basic");
  const edits = () => (s.store.db.prepare("SELECT COUNT(*) AS n FROM edits").get() as { n: number }).n;
  await s.deliver();
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "reviewing", t.error ?? "");
  assert.equal(t.editId, null);
  assert.equal(edits(), 0, "no edit was started");
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.subjectKind, "file");
  assert.equal(r.sourcePath, clips[2]);
});

/** The script a stand-in script writer returns for a Create row with a Lemo style. */
const LEMO_SCRIPT: Script = {
  lines: ["Stop scrolling, the waves plan your week.", "Try it free today"],
  shots: [{ prompt: "a great wave over a calendar", sec: 5 }, { prompt: "a boat reaching the shore", sec: 4 }],
  caption: "Woodblock week https://example.com/plan", title: "Woodblock week", musicPrompt: "koto",
};

/**
 * A Create row on Tuesday at 18:00 in the ukiyo-e Lemo style, written by Claude Sonnet: FreePoster writes the script
 * (with a stand-in writer that records the model it was given), then an agent films it.
 */
function scriptedSetup(write: (model: string | undefined) => Promise<Script> = async () => LEMO_SCRIPT, now = TUE) {
  const models: (string | undefined)[] = [];
  const s = setup({ writeScript: async (_deps, _choice, _sec, _instructions, model) => { models.push(model); return write(model); } });
  s.clock.now = now;
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  const id = tableCampaign(s, [tableRow(s, { origin: "create", style: LOOK.key, model: "claude:claude-sonnet-5-5", time: "18:00", sec: 9 })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  assert.ok(t);
  assert.equal((t.choices as any).instruction.scripted, true);
  const events = (type: string) => s.store.feed(0, 100, [type]);
  return { ...s, id, task: t, models, events };
}

test("a Create row with a Lemo style writes a script with its model, then offers a brief carrying it", async () => {
  const s = scriptedSetup();
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  assert.deepEqual(s.models, ["claude:claude-sonnet-5-5"]);
  const brief = (t.choices as any).brief;
  assert.ok(brief.script.includes(LEMO_SCRIPT.lines[0]), brief.script);
  assert.equal(brief.script, [...LEMO_SCRIPT.lines, "", "Shots:", "- a great wave over a calendar (5s)", "- a boat reaching the shore (4s)"].join("\n"));
  assert.equal(brief.model, "claude:claude-sonnet-5-5");
  assert.equal(brief.look, LOOK.key);
  assert.deepEqual(s.audio, [], "no WanGP voiceover or music");
  assert.deepEqual(s.staged, [], "no production was staged");
  assert.equal(s.events("brief.requested").length, 1);
});

test("a Create row with a Lemo style is scripted and briefed at once, as a WanGP video starts at once", async () => {
  const s = scriptedSetup();
  await s.tick(); // 08:00, for an 18:00 slot: no lead time to wait for
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  const brief = (t.choices as any).brief;
  assert.equal(brief.postAt, at(2026, 11, 17, 18));
  assert.equal(brief.deadline, at(2026, 11, 18, 8), "wanted within a day, not by a review cutoff");
  await s.tick();
  assert.equal(s.models.length, 1, "the script was written once");
  assert.equal(s.events("brief.requested").length, 1, "the brief was offered once");
  assert.equal((t.choices as any).briefRound, 1);
});

test("a Create row with a Lemo style added minutes before its slot is made anyway, and posts once approved", async () => {
  const s = scriptedSetup(undefined, at(2026, 11, 17, 17, 50));
  await s.tick();
  let t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  assert.equal(s.events("campaign.missed").length, 0);
  // The film arrives after the slot has passed: it still goes to review, and posts when approved.
  s.clock.now = at(2026, 11, 17, 18, 40);
  const token = claimed(s.cs, t.id, "agent-1", s.clock.now);
  const out = await submitBrief(s.store, s.cs, t.id, token, { videoPath: clips[4], manifest: { look: LOOK.key, libraryVersion: "1.4.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await s.tick();
  await s.approve(t.id);
  await s.tick();
  t = s.cs.task(t.id)!;
  assert.equal(t.state, "scheduled", t.error ?? "");
  const post = s.store.post(t.postId!)!;
  assert.ok(post.scheduledAt! >= at(2026, 11, 17, 18, 40) && post.scheduledAt! < at(2026, 11, 17, 19), `posts now, at ${new Date(post.scheduledAt!).toString()}`);
});

test("a Redo on a Create row's Lemo film close to its slot asks for a new film, not a missed slot", async () => {
  const s = scriptedSetup();
  await s.tick();
  const token = claimed(s.cs, s.task.id, "agent-1", s.clock.now);
  const out = await submitBrief(s.store, s.cs, s.task.id, token, { videoPath: clips[4], manifest: { look: LOOK.key, libraryVersion: "1.4.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await s.tick();
  await redoReview(s as unknown as ReturnType<typeof agentSetup>, "again");
  s.clock.now = at(2026, 11, 17, 17, 50);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  assert.equal((t.choices as any).briefRound, 2);
  assert.equal(s.events("brief.requested").length, 2);
});

test("a line whose time has come or passed today isn't made today: it waits for next week", () => {
  for (const [time, made] of [["07:00", 0], ["08:00", 0], ["08:01", 1]] as const) {
    const s = setup();
    const id = tableCampaign(s, [tableRow(s, { time })]);
    assert.equal(s.worker.materialize(), made, `a ${time} slot at 08:00`);
    assert.equal(s.cs.tasksOn(id, "2026-11-17").length, made);
  }
  // A second before the slot's minute still counts as ahead.
  const s = setup();
  s.clock.now = at(2026, 11, 17, 8, 0) - 1_000;
  tableCampaign(s, [tableRow(s, { time: "08:00" })]);
  assert.equal(s.worker.materialize(), 1);
});

test("a Create row's model reaches the script writer", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { model: "chatgpt:gpt-5.5" })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  assert.deepEqual(s.askedOpts, [{ model: "chatgpt:gpt-5.5" }]);
  assert.equal(s.cs.task(t.id)!.state, "rendering", s.cs.task(t.id)!.error ?? "");
});

test("a chosen model that fails fails the task with its reason", async () => {
  const models: (string | undefined)[] = [];
  const s = setup({ writeScript: async (_deps, _choice, _sec, _instructions, model) => { models.push(model); throw new Error("ChatGPT isn't connected"); } });
  const id = tableCampaign(s, [tableRow(s, { model: "chatgpt:gpt-5.5" })]);
  s.worker.materialize();
  const [task] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  const t = s.cs.task(task.id)!;
  assert.deepEqual(models, ["chatgpt:gpt-5.5"]);
  assert.equal(t.state, "failed");
  assert.equal(t.error, "ChatGPT isn't connected");
  assert.deepEqual(s.asked, [], "no other provider was asked");
  assert.deepEqual(s.audio, []);
});

test("an approved agent film is labelled with producer, look and version", async () => {
  const s = agentSetup();
  await s.deliver();
  await s.tick();
  const r = await s.approve(s.task.id);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "scheduled", t.error ?? "");
  assert.equal(s.store.post(r.postId!)!.scheduledAt, at(2026, 11, 17, 18));
  const labels = new AnalyticsStore(s.store).labels(r.postId!)!;
  assert.equal(labels.producer, "lemo-opuscar");
  assert.equal(labels.look, LOOK.key);
  assert.equal(labels.lookVersion, "1.4.0");
  assert.equal(labels.source, "generated");
  assert.equal(labels.lengthSec, 5);
});

test("a WanGP video is labelled with its producer", async () => {
  const s = setup();
  const id = s.campaign({ tue: [s.make(1, { at: "18:00" })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  const r = await s.approve(t.id);
  await s.tick();
  const labels = new AnalyticsStore(s.store).labels(r.postId!)!;
  assert.equal(labels.producer, "freeposter-wangp");
  assert.equal(labels.look, null);
});

test("no delivery by the deadline skips the slot", async () => {
  const s = agentSetup();
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  assert.ok(claimBrief(s.cs, s.task.id, "agent-1", s.clock.now).ok);
  s.clock.now = at(2026, 11, 17, 17, 31);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "missed", t.error ?? "");
  assert.equal(t.reviewId, null);
  assert.equal(t.postId, null, "nothing was posted");
  const ev = s.store.eventByKey(`campaign.missed:${t.id}`);
  assert.ok(ev);
  assert.match(JSON.parse(ev.body).summary, /the agent didn.t deliver before .*; the slot was skipped/);
});

test("two expired leases fail the task", async () => {
  const s = agentSetup();
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  assert.ok(claimBrief(s.cs, s.task.id, "agent-1", s.clock.now).ok);
  s.clock.now += 121 * 60_000;
  await s.tick();
  let t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  assert.equal((t.choices as any).lease, undefined, "the lapsed lease is cleared");
  assert.ok(s.store.eventByKey(`brief.expired:${t.id}:1:1`));
  await s.tick();
  assert.equal(s.events("brief.expired").length, 1, "told once per offer");
  assert.ok(claimBrief(s.cs, s.task.id, "agent-2", s.clock.now).ok);
  s.clock.now += 121 * 60_000;
  assert.ok(s.clock.now < at(2026, 11, 17, 17, 30), "still before the deadline");
  await s.tick();
  t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "failed");
  assert.equal(t.error, "no agent delivered after 2 tries");
  assert.ok(s.store.eventByKey(`brief.expired:${t.id}:1:2`));
  assert.ok(s.store.eventByKey(`campaign.failed:${t.id}`));
});

test("a claim made after the tick's snapshot isn't wiped", async () => {
  const s = agentSetup();
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  claimed(s.cs, s.task.id, "agent-1", s.clock.now);
  s.clock.now += 121 * 60_000;
  // The tick read the task while agent-1's lease had run out; agent-2 claims it before the worker gets to it.
  const stale = s.cs.task(s.task.id)!;
  const token = claimed(s.cs, s.task.id, "agent-2", s.clock.now);
  await (s.worker as any).followBrief(stale);
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent", t.error ?? "");
  assert.equal((t.choices as any).lease?.token, token, "agent-2's claim stands");
  assert.equal(s.events("brief.expired").length, 0, "a live claim isn't told as expired");
});

test("a claimed brief survives a new worker instance", async () => {
  const s = agentSetup();
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  const token = claimed(s.cs, s.task.id, "agent-1", s.clock.now);
  // the app restarts mid-render: a fresh worker on the same database
  const worker = new CampaignWorker({ store: s.store, productions: s.worker.productions, reviews: s.reviews, ai: null, now: () => s.clock.now, dir: tmp() });
  s.clock.now += 30 * 60_000;
  await worker.tick(); await worker.idle();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent");
  assert.equal((t.choices as any).lease.holder, "agent-1", "still claimed");
  assert.equal(claimBrief(s.cs, t.id, "agent-2", s.clock.now).ok, false, "nobody else can take it");
  const out = await submitBrief(s.store, s.cs, t.id, token, { videoPath: clips[2], manifest: { look: LOOK.key, libraryVersion: "1.4.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await worker.tick(); await worker.idle();
  assert.equal(s.cs.task(t.id)!.state, "reviewing", s.cs.task(t.id)!.error ?? "");
});

test("a look hidden after the brief was made still delivers and labels", async () => {
  const s = agentSetup();
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "awaiting_agent");
  syncLooks(s.store, "lemo-opuscar", []); // the look leaves the catalogue
  await s.deliver();
  await s.tick();
  const r = await s.approve(s.task.id);
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "scheduled", s.cs.task(s.task.id)!.error ?? "");
  const labels = new AnalyticsStore(s.store).labels(r.postId!)!;
  assert.equal(labels.look, LOOK.key);
  assert.equal(labels.lookVersion, "1.4.0");
});

test("a row whose look left the catalogue makes no task and sends no failure", async () => {
  const s = setup();
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  syncLooks(s.store, "lemo-opuscar", []); // hidden
  const id = tableCampaign(s, [
    tableRow(s, { id: 1, origin: "agent", style: LOOK.key, time: "18:00", sec: 5 }),
    tableRow(s, { id: 2, origin: "agent", style: "lemo:never-synced", time: "19:00", sec: 5 }),
  ]);
  assert.equal(s.worker.materialize(), 0);
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-17"), []);
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-17"), []);
  assert.equal(s.store.feed(0, 100, ["campaign.failed"]).length, 0);
  // Back in the catalogue, the row runs again.
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  assert.equal(s.worker.materialize(), 1);
});

test("a look gone from the catalogue before its brief fails the task", async () => {
  const s = agentSetup();
  syncLooks(s.store, "lemo-opuscar", []);
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "failed");
  assert.equal(t.error, `the Lemo style ${LOOK.key} is no longer in Lemo-Opuscar`);
  assert.ok(s.store.eventByKey(`campaign.failed:${t.id}`));
  assert.equal(s.events("brief.requested").length, 0);
});

test("a stopped campaign posts no new brief", async () => {
  const s = agentSetup();
  s.worker.stopCampaign(s.id);
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "queued");
  assert.equal(s.events("brief.requested").length, 0);
  s.worker.startCampaign(s.id);
  await s.worker.idle();
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "awaiting_agent");
});

test("a kept agent film awaits the agent at once", async () => {
  const s = setup();
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  const id = s.campaign({ tue: [s.make(1, null, { style: null, look: LOOK.key, sec: 5 })] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  const c = s.cs.task(t.id)!.choices as any;
  assert.equal(s.cs.task(t.id)!.state, "awaiting_agent", s.cs.task(t.id)!.error ?? "");
  assert.equal(c.brief.postAt, null);
  assert.equal(c.brief.deadline, TUE + 24 * HOUR);
});

test("a retried agent task keeps a delivery still on disk, else asks an agent again", async () => {
  const s = agentSetup();
  const film = join(tmp(), "film.mp4");
  copyFileSync(clips[2], film);
  await s.deliver({ clip: film });
  s.worker.fail(s.task.id, "something broke");
  assert.equal(s.worker.retryTask(s.task.id), null);
  let t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "awaiting_agent");
  assert.equal((t.choices as any).delivery.path, film, "the film is kept");
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "reviewing", s.cs.task(t.id)!.error ?? "");

  s.worker.fail(t.id, "it broke again");
  rmSync(film);
  s.clock.now = at(2026, 11, 17, 13);
  assert.equal(s.worker.retryTask(t.id), null);
  t = s.cs.task(t.id)!;
  const c = t.choices as any;
  assert.equal(t.state, "awaiting_agent");
  assert.equal(c.delivery, undefined);
  assert.equal(c.lease, undefined);
  assert.equal(c.offers, 0);
  assert.equal(t.reviewId, null);
  assert.equal(c.brief.deadline, at(2026, 11, 17, 17, 30));
  assert.ok(claimBrief(s.cs, t.id, "agent-3", s.clock.now).ok, "an agent can take it again");
  assert.deepEqual(s.asked, []);
});

test("an agent's delivered film can't be sent for review another way", async () => {
  const s = agentSetup();
  await s.deliver();
  await assert.rejects(
    s.reviews.request({ subject: { kind: "file", path: clips[2] }, accountIds: [1], caption: "", title: "", scheduledAt: null, tiktok: null, allowDuplicate: false, via: "mcp", expireAtSchedule: false } as any),
    /campaign video/,
  );
});

test("a late retry's brief, with no slot left, isn't announced as a video to keep", async () => {
  const s = agentSetup();
  const film = join(tmp(), "late.mp4");
  copyFileSync(clips[2], film);
  await s.deliver({ clip: film });
  s.worker.fail(s.task.id, "something broke");
  rmSync(film);
  s.clock.now = at(2026, 11, 17, 17, 45); // past the slot's deadline: wanted within a day, placed like a later approval
  assert.equal(s.worker.retryTask(s.task.id), null);
  const c = s.cs.task(s.task.id)!.choices as any;
  assert.equal(c.brief.postAt, null);
  const summary = JSON.parse(s.store.eventByKey(`brief.requested:${s.task.id}:2`)!.body).summary;
  assert.doesNotMatch(summary, /a video to keep/);
  assert.match(summary, /posting at the next free time once approved/);
});

test("an agent's film with no style is reviewed under its look's name", async () => {
  const s = setup();
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  const plain = s.cs.addEntry({ kind: "cta", name: "follow", text: "Follow for more" });
  const id = tableCampaign(s, [tableRow(s, { origin: "agent", style: LOOK.key, time: "18:00", sec: 5, cta: { pick: "named", id: plain } })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  const token = claimed(s.cs, t.id, "agent-1", s.clock.now);
  // No caption: the review writes one, and is told what the video is.
  const out = await submitBrief(s.store, s.cs, t.id, token, { videoPath: clips[2], manifest: { look: LOOK.key, libraryVersion: "1.4.0" } }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await s.tick();
  const r = s.reviews.reviews.get(s.cs.task(t.id)!.reviewId!)!;
  assert.equal(r.draft.captionTopic, LOOK.name, "the look's name, not the bare file name");
});

test("a delivered film is recognised by its content, or its path written another way", async () => {
  const s = agentSetup();
  await s.deliver();
  const copy = join(tmp(), "copy.mp4");
  copyFileSync(clips[2], copy);
  assert.equal(s.worker.owns({ kind: "file", path: copy }), true, "the same film under another name");
  if (process.platform === "win32") assert.equal(s.worker.owns({ kind: "file", path: clips[2].toUpperCase() }), true);
  assert.equal(s.worker.owns({ kind: "file", path: join(clips[2], "..", ".", "clip2.mp4") }), true, "the same path, not normalized");
  assert.equal(s.worker.owns({ kind: "file", path: clips[3] }), false);
});

test("a post line posts a kept agent film as it was delivered, labelled with its look", async () => {
  const s = setup();
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  const id = s.campaign({ tue: [s.make(1, null, { style: null, look: LOOK.key, sec: 5 }), s.postLine("weekdaygrowth-tue-1", "20:00")] });
  s.worker.materialize();
  const [make, post] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  const token = claimed(s.cs, make.id, "agent-1", s.clock.now);
  const out = await submitBrief(s.store, s.cs, make.id, token, { videoPath: clips[2], manifest: { look: LOOK.key, libraryVersion: "1.4.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await s.tick();
  await s.approve(make.id);
  await s.tick();
  assert.equal(s.cs.task(make.id)!.state, "kept", s.cs.task(make.id)!.error ?? "");
  await s.tick();
  const p = s.cs.task(post.id)!;
  assert.equal(p.state, "reviewing", p.error ?? "");
  const r = await s.approve(post.id);
  assert.equal(s.reviews.reviews.get(r.id)!.sourcePath, clips[2]);
  await s.tick();
  assert.equal(s.cs.task(post.id)!.state, "scheduled", s.cs.task(post.id)!.error ?? "");
  const labels = new AnalyticsStore(s.store).labels(r.postId!)!;
  assert.equal(labels.look, LOOK.key);
  assert.equal(labels.producer, "lemo-opuscar");
  assert.deepEqual(s.asked, []);
});

/**
 * A kept agent film (its task's style `keptStyle`, as a schedule compiled before Lemo films stopped being edited
 * could give it), delivered and kept, then taken by a post line with `lineStyle`: it reaches review as delivered.
 */
async function postKeptLemo(keptStyle: string | null, lineStyle: string | null) {
  const s = setup();
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  const line = { ...s.postLine("weekdaygrowth-tue-1", "20:00"), style: lineStyle };
  const id = s.campaign({ tue: [s.make(1, null, { style: keptStyle, look: LOOK.key, sec: 5 }), line] });
  s.worker.materialize();
  const [make, post] = s.cs.tasksOn(id, "2026-11-17");
  assert.equal((make.choices as any).style, keptStyle);
  await s.tick();
  const token = claimed(s.cs, make.id, "agent-1", s.clock.now);
  const out = await submitBrief(s.store, s.cs, make.id, token, { videoPath: clips[2], manifest: { look: LOOK.key, libraryVersion: "1.4.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await s.tick();
  await s.approve(make.id);
  await s.tick();
  assert.equal(s.cs.task(make.id)!.state, "kept", s.cs.task(make.id)!.error ?? "");
  await s.tick();
  const p = s.cs.task(post.id)!;
  assert.equal(p.state, "reviewing", p.error ?? "");
  assert.equal(p.editId, null);
  assert.equal((s.store.db.prepare("SELECT COUNT(*) AS n FROM edits").get() as { n: number }).n, 0, "no edit was started");
  await s.reviews.tick();
  const r = s.reviews.reviews.get(p.reviewId!)!;
  assert.equal(r.subjectKind, "file");
  assert.equal(r.sourcePath, clips[2]);
}

test("a kept Lemo film from a schedule with a style from before is posted as delivered, not edited", async () => {
  await postKeptLemo("basic", null);
});

test("a post line with its own style posts a kept Lemo film as delivered, not edited", async () => {
  await postKeptLemo(null, "basic");
});

test("a retried brief is announced again and its expiries and failure are told", async () => {
  const s = setup();
  syncLooks(s.store, "lemo-opuscar", [LOOK]);
  const id = s.campaign({ tue: [s.make(1, null, { style: null, look: LOOK.key, sec: 5 })] });
  s.worker.materialize();
  const [task] = s.cs.tasksOn(id, "2026-11-17");
  /** Two claims that both run out: the task fails. */
  const twoLapses = async () => {
    for (const holder of ["agent-1", "agent-2"]) {
      assert.ok(claimBrief(s.cs, task.id, holder, s.clock.now).ok);
      s.clock.now += 121 * 60_000;
      await s.tick();
    }
    assert.equal(s.cs.task(task.id)!.state, "failed");
  };
  await s.tick();
  assert.ok(s.store.eventByKey(`brief.requested:${task.id}:1`));
  await twoLapses();
  assert.ok(s.store.eventByKey(`brief.expired:${task.id}:1:1`));
  assert.ok(s.store.eventByKey(`brief.expired:${task.id}:1:2`));
  assert.ok(s.store.eventByKey(`campaign.failed:${task.id}`));

  assert.equal(s.worker.retryTask(task.id), null);
  assert.equal((s.cs.task(task.id)!.choices as any).briefRound, 2);
  assert.ok(s.store.eventByKey(`brief.requested:${task.id}:2`), "the fresh brief is announced");
  await twoLapses();
  assert.ok(s.store.eventByKey(`brief.expired:${task.id}:2:1`));
  assert.ok(s.store.eventByKey(`brief.expired:${task.id}:2:2`));
  assert.ok(s.store.eventByKey(`campaign.failed:${task.id}:2`), "the second failure is told too");
  assert.equal(s.store.feed(0, 100, ["brief.expired"]).length, 4);
  assert.equal(s.store.feed(0, 100, ["brief.requested"]).length, 2);
  assert.equal(s.store.feed(0, 100, ["campaign.failed"]).length, 2);
});

test("a brief that would open after its deadline is missed, not announced", async () => {
  const s = agentSetup();
  s.clock.now = at(2026, 11, 17, 17, 30); // the app was off until the deadline
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "missed", t.error ?? "");
  assert.equal((t.choices as any).brief, undefined);
  assert.equal(s.events("brief.requested").length, 0);
  assert.ok(s.store.eventByKey(`campaign.missed:${t.id}`));

  // stopped through the slot: missed once it runs again, still never announced
  const o = agentSetup();
  o.worker.stopCampaign(o.id);
  o.clock.now = at(2026, 11, 17, 19);
  await o.tick();
  assert.equal(o.cs.task(o.task.id)!.state, "missed");
  assert.equal(o.events("brief.requested").length, 0);
});

test("at the deadline the slot is missed, not the lease expired", async () => {
  const s = agentSetup();
  s.clock.now = at(2026, 11, 17, 16);
  await s.tick();
  const lease = claimBrief(s.cs, s.task.id, "agent-1", s.clock.now);
  assert.ok(lease.ok);
  assert.equal(lease.leaseUntil, at(2026, 11, 17, 17, 30), "the lease ends at the deadline");
  s.clock.now = at(2026, 11, 17, 17, 30);
  await s.tick();
  const t = s.cs.task(s.task.id)!;
  assert.equal(t.state, "missed", t.error ?? "");
  assert.equal(s.events("brief.expired").length, 0);
});

test("a slot missed today is made again, fresh, when its row moves to a time still ahead", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "09:00" })]);
  s.worker.materialize();
  const [missed] = s.cs.tasksOn(id, "2026-11-17");
  s.cs.updateTask(missed.id, { state: "missed", error: "the agent didn't deliver before 8:30" });
  s.clock.now = at(2026, 11, 17, 10);
  // Moved to a time already passed: it waits for next week, and the missed slot stays as it was.
  s.cs.setRows(id, [tableRow(s, { time: "09:30" })]);
  assert.equal(s.worker.materialize(), 0);
  assert.equal(s.cs.task(missed.id)!.state, "missed");
  // Moved to a time still ahead: a new task for the row as it is now.
  s.cs.setRows(id, [tableRow(s, { time: "11:00", text: "new direction" })]);
  assert.equal(s.worker.materialize(), 1);
  const tasks = s.cs.tasksOn(id, "2026-11-17");
  const fresh = tasks.find((t) => t.id !== missed.id)!;
  assert.ok(fresh.id > missed.id, "a new id: events keyed by the old task's id never stand for the new one");
  assert.equal(fresh.state, "queued");
  assert.equal(fresh.copy, missed.copy, "it takes the row's slot");
  assert.equal((fresh.choices as any).postTime, "11:00");
  assert.equal((fresh.choices as any).instruction.instructions, "new direction");
  const old = s.cs.task(missed.id)!;
  assert.equal(old.state, "missed", "the missed slot stays in the day's history");
  assert.ok(old.copy < 0, "out of the row's slot");
  assert.equal(tasks.length, 2);
  assert.equal(s.worker.materialize(), 0, "made once");
});

test("a slot missed at its own time, or one that made a video, isn't made again", () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { id: 1, time: "11:00" }), tableRow(s, { id: 2, time: "12:00" })]);
  s.worker.materialize();
  const [a, b] = s.cs.tasksOn(id, "2026-11-17");
  s.cs.updateTask(a.id, { state: "missed" }); // missed with the row's time unchanged (an Agent row's deadline)
  s.cs.updateTask(b.id, { state: "posted", postId: 1 });
  s.clock.now = at(2026, 11, 17, 10);
  s.cs.setRows(id, [tableRow(s, { id: 1, time: "11:00" }), tableRow(s, { id: 2, time: "13:00" })]);
  assert.equal(s.worker.materialize(), 0);
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-17").map((t) => t.id), [a.id, b.id]);
});

test("a Create + Lemo row's task is made 48 hours ahead, not before", () => {
  const s = setup(); syncLooks(s.store, "lemo-opuscar", [LOOK]);
  s.clock.now = at(2026, 11, 17, 10); // Tue 10:00
  const id = tableCampaign(s, [
    tableRow(s, { id: 1, origin: "create", style: LOOK.key, model: "claude:claude-opus-5-5", days: ["thu"], time: "09:00" }), // 47 h
    tableRow(s, { id: 2, origin: "create", style: LOOK.key, model: "claude:claude-opus-5-5", days: ["thu"], time: "11:00" }), // 49 h
    tableRow(s, { id: 3, days: ["thu"], time: "09:00" }), // FreePoster style: made on the day
  ]);
  s.worker.materialize();
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-19").map((t) => t.instructionIndex), [ROW_INSTRUCTION_BASE + 1]);
  s.clock.now = at(2026, 11, 17, 11, 1);
  s.worker.materialize();
  assert.deepEqual(s.cs.tasksOn(id, "2026-11-19").map((t) => t.instructionIndex).sort(), [ROW_INSTRUCTION_BASE + 1, ROW_INSTRUCTION_BASE + 2]);
  assert.equal(s.worker.materialize(), 0, "made once");
});

test("an early Lemo task is scripted and its brief goes out at once", async () => {
  const s = scriptedSetup(undefined, at(2026, 11, 17, 10));
  const id = tableCampaign(s, [tableRow(s, { id: 9, origin: "create", style: LOOK.key, model: "claude:claude-sonnet-5-5", days: ["thu"], time: "09:00", sec: 9 })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-19");
  assert.ok(t);
  await s.tick();
  await s.tick();
  const done = s.cs.task(t.id)!;
  assert.equal(done.state, "awaiting_agent", done.error ?? "");
  assert.equal((done.choices as any).brief.postAt, at(2026, 11, 19, 9));
});

test("a Lemo film made early and approved before its day posts at its own time on its own day", async () => {
  const s = scriptedSetup(undefined, at(2026, 11, 17, 10));
  const id = tableCampaign(s, [tableRow(s, { id: 9, origin: "create", style: LOOK.key, model: "claude:claude-sonnet-5-5", days: ["thu"], time: "09:00", sec: 9 })]);
  s.worker.materialize();
  const [t0] = s.cs.tasksOn(id, "2026-11-19");
  assert.ok(t0);
  await s.tick();
  const token = claimed(s.cs, t0.id, "agent-1", s.clock.now);
  const out = await submitBrief(s.store, s.cs, t0.id, token, { videoPath: clips[4], manifest: { look: LOOK.key, libraryVersion: "1.4.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.ok(out.ok, out.ok ? "" : out.error);
  await s.tick();
  await s.approve(t0.id);
  await s.tick();
  const t = s.cs.task(t0.id)!;
  assert.equal(t.state, "scheduled", t.error ?? "");
  assert.equal(s.store.post(t.postId!)!.scheduledAt, at(2026, 11, 19, 9));
});

// ---- a changed row's videos are replaced ----

/** The campaign.remade events, newest last. */
const remadeEvents = (s: ReturnType<typeof setup>) => s.store.feed(0, 100, ["campaign.remade"]).map((e) => JSON.parse(e.body));

test("changing a row's hook retires its reviewing video and the next materialize remakes it", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "18:00", hook: { pick: "named", id: s.hooks[0] } })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  const reviewId = s.cs.task(t.id)!.reviewId!;
  const editId = s.cs.task(t.id)!.editId!;
  s.worker.campaigns.setRows(id, [tableRow(s, { time: "18:00", hook: { pick: "named", id: s.hooks[1] } })]);
  const old = s.cs.task(t.id)!;
  assert.equal(old.state, "replaced");
  assert.ok(old.copy < 0, "out of the row's slot");
  assert.equal(s.reviews.reviews.get(reviewId)!.state, "superseded");
  assert.equal(s.store.edit(editId)!.state, "superseded");
  const [ev] = remadeEvents(s);
  assert.ok(ev, "the user is told");
  assert.deepEqual(ev.rows, ["0000001"]);
  assert.equal(ev.retired, 1);
  assert.equal(ev.summary, 'Campaign "Table": 1 videos of row(s) 0000001 are being made again from the changed row');
  assert.equal(s.worker.materialize(), 1);
  const fresh = s.cs.tasksOn(id, "2026-11-17").find((x) => x.id !== t.id)!;
  assert.equal(fresh.copy, 0);
  assert.equal(fresh.state, "queued");
  assert.equal((fresh.choices as any).hook.id, s.hooks[1]);
  // A tick never brings the old one back.
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "replaced");
});

test("a time-only change still moves the video and doesn't retire it", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "18:00" })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick();
  const state = s.cs.task(t.id)!.state;
  s.worker.campaigns.setRows(id, [tableRow(s, { time: "19:00" })]);
  const after = s.cs.task(t.id)!;
  assert.equal(after.state, state);
  assert.equal(after.copy, 0);
  assert.equal((after.choices as any).postTime, "19:00");
  assert.equal(remadeEvents(s).length, 0);
});

test("an approved post that has started uploading is left alone", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "18:00" })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  await s.approve(t.id);
  await s.tick();
  const placed = s.cs.task(t.id)!;
  assert.equal(placed.state, "scheduled", placed.error ?? "");
  assert.ok(s.store.jobsForPost(placed.postId!).every((j) => j.progress.heldFrom === undefined), "released to go out");
  s.worker.campaigns.setRows(id, [tableRow(s, { time: "18:00", text: "a new direction" })]);
  assert.equal(s.cs.task(t.id)!.state, "scheduled");
  assert.equal(s.cs.task(t.id)!.copy, 0);
  assert.ok(s.store.post(placed.postId!), "its post stays");
  assert.equal(s.worker.materialize(), 0, "nothing is made again for its slot");
});

test("an approved post still held (its campaign stopped) is cancelled and made again", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "18:00" })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(t.id);
  await s.approve(t.id);
  await s.tick();
  const postId = s.cs.task(t.id)!.postId!;
  assert.equal(s.worker.stopCampaign(id), 1);
  s.worker.campaigns.setRows(id, [tableRow(s, { time: "18:00", text: "a new direction" })]);
  assert.equal(s.cs.task(t.id)!.state, "replaced");
  assert.equal(s.store.post(postId), undefined, "its held post is cancelled");
});

test("two saves in a row never leave two live tasks in one slot", async () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "18:00" })]);
  s.worker.materialize();
  await s.tick();
  s.worker.campaigns.setRows(id, [tableRow(s, { time: "18:00", text: "change A" })]);
  assert.equal(s.worker.materialize(), 1);
  await s.tick();
  s.worker.campaigns.setRows(id, [tableRow(s, { time: "18:00", text: "change B" })]);
  assert.equal(s.worker.materialize(), 1);
  await s.tick();
  const tasks = s.cs.tasksOn(id, "2026-11-17");
  const live = tasks.filter((x) => x.state !== "replaced");
  assert.equal(live.length, 1);
  assert.equal(live[0].copy, 0);
  assert.equal((live[0].choices as any).instruction.instructions, "change B");
  assert.equal(tasks.filter((x) => x.state === "replaced").length, 2);
  assert.ok(tasks.filter((x) => x.state === "replaced").every((x) => x.copy < 0));
});

test("retiring an awaiting_agent task aborts the launcher run and a late submit_brief is refused", async () => {
  const s = scriptedSetup();
  s.clock.now = at(2026, 11, 17, 12);
  await s.tick();
  assert.equal(s.cs.task(s.task.id)!.state, "awaiting_agent");
  const token = claimed(s.cs, s.task.id, "agent-1", s.clock.now);
  const retired: number[] = [];
  s.worker.onRetire = (taskId) => { retired.push(taskId); throw new Error("a broken launcher never stops the retirement"); };
  s.worker.campaigns.setRows(s.id, [tableRow(s, { origin: "create", style: LOOK.key, model: "claude:claude-sonnet-5-5", time: "18:00", sec: 9, text: "new direction" })]);
  assert.deepEqual(retired, [s.task.id]);
  assert.equal(s.cs.task(s.task.id)!.state, "replaced");
  const out = await submitBrief(s.store, s.cs, s.task.id, token, { videoPath: clips[4], manifest: { look: LOOK.key, libraryVersion: "1.4.0" }, caption: AGENT_CAPTION }, s.clock.now);
  assert.equal(out.ok, false);
  assert.match(out.ok ? "" : out.error, /no open brief/);
  assert.equal(openBriefs(s.cs, s.clock.now).some((t) => t.id === s.task.id), false);
});

test("lowering the quantity retires copy 1 and nothing is remade for it", () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "18:00", quantity: 2 })]);
  assert.equal(s.worker.materialize(), 2);
  const [a, b] = s.cs.tasksOn(id, "2026-11-17");
  assert.deepEqual([a.copy, b.copy], [0, 1]);
  s.worker.campaigns.setRows(id, [tableRow(s, { time: "18:00", quantity: 1 })]);
  assert.equal(s.cs.task(a.id)!.state, "queued");
  assert.equal(s.cs.task(b.id)!.state, "replaced");
  assert.equal(s.worker.materialize(), 0);
  const [ev] = remadeEvents(s);
  assert.match(ev.summary, /were removed/);
  assert.doesNotMatch(ev.summary, /made again/);
});

test("a row changed inside a caller's transaction retires its videos without opening one of its own", () => {
  const s = setup();
  const id = tableCampaign(s, [tableRow(s, { time: "18:00" })]);
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  s.store.db.exec("BEGIN");
  s.worker.campaigns.setRows(id, []);
  s.store.db.exec("COMMIT");
  assert.equal(s.cs.task(t.id)!.state, "replaced");
  assert.match(remadeEvents(s)[0].summary, /were removed/);
});
