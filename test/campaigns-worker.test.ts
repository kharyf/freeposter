import "./isolated-home.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { AiService } from "../src/ai/router.ts";
import type { Question } from "../src/ai/providers.ts";
import { AnalyticsStore } from "../src/analytics/store.ts";
import type { Script } from "../src/campaigns/script.ts";
import { DAYS, type CompiledCampaign, type Day, type MakeInstruction, type PostInstruction } from "../src/campaigns/spec.ts";
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

function setup(opts: { cap?: number; defaults?: string[] } = {}) {
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
  };
  const asked: Question[] = [];
  const ai = {
    ask: async (job: string, q: Question): Promise<Script> => {
      assert.equal(job, "script");
      asked.push(q);
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
  return { store, cs, clock, reviews, ps, staged, gpu, asked, audio, worker, make, postLine, campaign, tick, finishProduction, finishEdit, approve, toReview, hooks, angles, cta };
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
  s.clock.now = at(2027, 3, 13, 23, 59);
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
