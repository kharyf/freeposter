import "./isolated-home.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { AiService } from "../src/ai/router.ts";
import type { Question } from "../src/ai/providers.ts";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { AGES } from "../src/analytics/types.ts";
import { evaluateRules } from "../src/campaigns/rules.ts";
import type { Script } from "../src/campaigns/script.ts";
import { DAYS, type CompiledCampaign, type Day, type MakeInstruction, type Rule } from "../src/campaigns/spec.ts";
import { CampaignStore, type LibraryEntry } from "../src/campaigns/store.ts";
import { CampaignWorker, dayKey, pickValue, type PickContext } from "../src/campaigns/worker.ts";
import { publishers } from "../src/platforms/index.ts";
import type { ProductionSpec } from "../src/produce/spec.ts";
import { ProductionStore } from "../src/produce/store.ts";
import { ReviewService } from "../src/review/service.ts";
import { account, makeVideo, newStore, tmp } from "./helpers.ts";

process.env.TZ = "America/New_York";

let clips: string[] = [];
before(() => {
  const dir = tmp();
  clips = [3, 4, 5, 6].map((sec, i) => makeVideo(dir, `clip${i}.mp4`, ["-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24", "-t", String(sec), "-c:v", "libx264", "-pix_fmt", "yuv420p"]));
});

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
/** Tuesday 17 November 2026, 08:00 local */
const TUE = at(2026, 11, 17, 8);
const emptyDays = () => Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"];

const workingHook = (over: Partial<Rule["when"]> = {}, then: Rule["then"] = { kind: "make", count: 3, keep: ["hook"], vary: ["angle"], post: true }): Rule => ({
  when: { label: "hook", is: "working", thresholdPct: 25, minVideos: 3, age: "72h", scope: "campaign", ...over },
  then,
  source: "When analytics show that a hook on this campaign is working, create 3 variant videos that all use that hook.",
});

function setup(opts: { cap?: number; defaults?: string[] } = {}) {
  const store = newStore();
  const acct = store.upsertAccount(account("x"));
  const cs = new CampaignStore(store);
  const analytics = new AnalyticsStore(store);
  const hooks = ["Stop scrolling", "Nobody tells you this", "Here is the secret"].map((t, i) => cs.addEntry({ kind: "hook", name: `h${i}`, text: t }));
  const angles = ["Your week is a mess", "You never plan", "You waste mornings"].map((t, i) => cs.addEntry({ kind: "angle", name: `a${i}`, text: t }));
  const ctaA = cs.addEntry({ kind: "cta", name: "try", text: "Try it free today", url: "https://example.com/plan" });
  const ctaB = cs.addEntry({ kind: "cta", name: "join", text: "Join the list", url: "https://example.com/join" });
  const typeId = cs.addType({ name: "Tips", color: "#123456" });
  const clock = { now: TUE };
  const reviews = new ReviewService(store, { publishers, runner: { tick() {} }, dir: tmp() });
  const ps = new ProductionStore(store);
  const productions = {
    productions: ps,
    createStaged: async (spec: ProductionSpec) => ps.create(spec, []),
    borrowGpu: async <T>(fn: () => Promise<T>) => ({ value: await fn() }),
  };
  const ai = {
    ask: async (_job: string, q: Question): Promise<Script> => {
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
  const worker = new CampaignWorker({
    store, productions, reviews, ai, now: () => clock.now, random,
    speech: async () => clips[0], music: async () => clips[0], dir: tmp(),
  });
  const make = (extra: Partial<MakeInstruction> = {}): MakeInstruction => ({
    kind: "make", count: 1, style: "basic", hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "named", id: ctaA }, types: [],
    post: { at: "default" }, source: "make 1 Basic video", ...extra,
  });
  const campaign = (rules: Rule[], days: Partial<Record<Day, MakeInstruction[]>> = { sun: [make()] }, name = "Weekday Growth") => {
    const id = cs.create({ name, text: "the text", accountSetId: null, defaultPostTimes: opts.defaults ?? ["09:00", "18:00"], dailyPostCap: opts.cap });
    cs.confirm(id, { version: 1, days: { ...emptyDays(), ...days }, rules });
    return id;
  };

  let n = 0;
  /** A published video on the account with `views` at 72h, published a week or more before Tuesday. */
  const published = (views: number) => {
    n++;
    const postId = store.createPost({ caption: "", title: "", sourcePath: "x.mp4", sha256: `sha-${n}`, tiktok: null }, [acct.id]);
    const job = store.jobsForPost(postId)[0];
    store.finishJob(job.id, "published", { resultUrl: "https://example.com/v" });
    const pubAt = at(2026, 11, 1) + n * 60_000;
    store.db.prepare("UPDATE jobs SET published_at = ? WHERE id = ?").run(pubAt, job.id);
    analytics.addSnapshot({ jobId: job.id, platform: "x", externalId: `v${n}`, takenAt: pubAt + AGES["72h"] * 1000, ageSec: AGES["72h"],
      reading: { views, viewsKind: "views", raw: {}, retention: null } });
    return postId;
  };
  /** Twelve unlabelled videos: the account's baseline (100 to 1200 views at 72h). */
  const baseline = () => { for (let i = 1; i <= 12; i++) published(i * 100); };
  /** A campaign video: a posted task made by `ins` with these choices, and its labelled post. */
  const campaignVideo = (campaignId: number, views: number, choice: { hook: number; angle?: number; cta?: number; style?: string; types?: number[] }, ins: MakeInstruction = make(), date = "2026-11-10") => {
    const postId = published(views);
    const entry = (id: number | undefined) => (id === undefined ? undefined : cs.entry(id));
    const taskId = cs.addTask({
      campaignId, date, dayIndex: 2, instructionIndex: 0, copy: n, kind: "make", state: "posted", postId,
      choices: { instruction: ins, campaignName: "Weekday Growth", day: "Tue", style: choice.style ?? ins.style, types: choice.types ?? ins.types,
        hook: entry(choice.hook), angle: entry(choice.angle ?? angles[0]), cta: entry(choice.cta ?? ctaA), postTime: "09:00", accountSetId: null },
    })!;
    analytics.setLabels({ postId, source: "generated", styleId: choice.style ?? ins.style, hookId: choice.hook, hookText: null,
      angleId: choice.angle ?? angles[0], angleText: null, ctaId: choice.cta ?? ctaA, ctaText: null, campaignId, campaignTaskId: taskId,
      types: choice.types ?? ins.types, labelledBy: "campaign" });
    return taskId;
  };
  const evaluate = () => evaluateRules({ store, analytics, campaigns: cs, worker, now: clock.now });
  const ruleTasks = (id: number) => cs.tasksOn(id, dayKey(clock.now)).filter((t) => t.kind === "rule");
  const tick = async () => { await worker.tick(); await worker.idle(); };
  return { store, cs, analytics, worker, reviews, ps, clock, hooks, angles, ctaA, ctaB, typeId, make, campaign, published, baseline, campaignVideo, evaluate, ruleTasks, tick };
}

test("a working hook fires once: 3 tasks dated today keep the hook, and it never fires again for it", () => {
  const s = setup();
  const id = s.campaign([workingHook()]);
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 10_000, { hook: s.hooks[0] });
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 150, { hook: s.hooks[1] });

  const out = s.evaluate();
  assert.deepEqual(out.fired, [{ campaignId: id, ruleIndex: 0, key: `hook:${s.hooks[0]}` }]);
  const tasks = s.ruleTasks(id);
  assert.equal(tasks.length, 3);
  for (const t of tasks) {
    assert.equal(t.date, "2026-11-17");
    assert.equal(t.state, "queued", t.error ?? "");
    assert.ok(t.instructionIndex >= 1000, "rule tasks never collide with day instructions");
    assert.equal((t.choices.hook as LibraryEntry).id, s.hooks[0]);
    assert.equal((t.choices.instruction as MakeInstruction).source, workingHook().source);
  }
  assert.equal(new Set(tasks.map((t) => t.copy)).size, 3);
  assert.equal(new Set(tasks.map((t) => (t.choices.angle as LibraryEntry).id)).size, 3, "angles vary");
  const ev = s.store.eventByKey(`campaign.rule:${id}:0:hook:${s.hooks[0]}`);
  assert.ok(ev, "the firing is told");
  assert.match(JSON.parse(ev!.body).summary, /create 3 variant videos/);
  assert.match(JSON.parse(ev!.body).summary, /Stop scrolling/);

  // The next refresh: already fired for that hook, so nothing new.
  assert.deepEqual(s.evaluate().fired, []);
  s.clock.now += 86_400_000;
  assert.deepEqual(s.evaluate().fired, []);
  assert.equal(s.cs.db.prepare("SELECT COUNT(*) AS n FROM campaign_tasks WHERE kind = 'rule'").get()!.n, 3);
});

test("doesn't fire with only 2 videos, nor on provisional scores, nor for free-text hooks", () => {
  const s = setup();
  const id = s.campaign([workingHook()]);
  // Only 6 earlier videos: every score is provisional (fewer than 8 at 72h).
  for (let i = 1; i <= 3; i++) s.published(i * 100);
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 10_000, { hook: s.hooks[0] });
  assert.deepEqual(s.evaluate().fired, [], "provisional scores don't count");
  s.baseline();
  assert.deepEqual(s.evaluate().fired.map((f) => f.key), [`hook:${s.hooks[0]}`], "once final, the same videos count");

  const t = setup();
  const id2 = t.campaign([workingHook()]);
  t.baseline();
  for (let i = 0; i < 2; i++) t.campaignVideo(id2, 10_000, { hook: t.hooks[0] });
  // Free text from a recorded video (no library id) never matches.
  for (let i = 0; i < 3; i++) {
    const postId = t.published(10_000);
    t.analytics.setLabels({ postId, source: "recorded", styleId: null, hookId: null, hookText: "Hey you", angleId: null, angleText: null, ctaId: null,
      ctaText: null, campaignId: id2, campaignTaskId: null, types: [], labelledBy: "transcript" });
  }
  assert.deepEqual(t.evaluate().fired, []);
  assert.equal(t.ruleTasks(id2).length, 0);
});

test("stop_using takes a hook out of random picks; a named line using it still runs", () => {
  const s = setup();
  const rule = workingHook({ is: "not_working" }, { kind: "stop_using" });
  const id = s.campaign([rule], { tue: [s.make({ count: 4, post: { at: "default" } }), s.make({ hook: { pick: "named", id: s.hooks[1] } })] });
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 1, { hook: s.hooks[1] }, s.make(), "2026-11-03");
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 10_000, { hook: s.hooks[0] }, s.make(), "2026-11-03");

  assert.deepEqual(s.evaluate().fired, [{ campaignId: id, ruleIndex: 0, key: `hook:${s.hooks[1]}` }]);
  assert.deepEqual(s.cs.excluded(id), { hook: [s.hooks[1]], angle: [], cta: [] });
  assert.equal(s.ruleTasks(id).length, 0, "stop_using makes nothing");
  assert.ok(s.store.eventByKey(`campaign.rule:${id}:0:hook:${s.hooks[1]}`));

  s.worker.materialize();
  const today = s.cs.tasksOn(id, "2026-11-17");
  assert.equal(today.length, 5);
  const random = today.filter((t) => t.instructionIndex === 0).map((t) => (t.choices.hook as LibraryEntry).id);
  assert.ok(!random.includes(s.hooks[1]), `random picks skip the stopped hook: ${random.join(",")}`);
  const named = today.find((t) => t.instructionIndex === 1)!;
  assert.equal(named.state, "queued", named.error ?? "");
  assert.equal((named.choices.hook as LibraryEntry).id, s.hooks[1], "the named line keeps running");
});

test("pickValue: random and best skip excluded values; all excluded falls back to all, with a note", () => {
  const pool: LibraryEntry[] = [1, 2, 3].map((id) => ({ id, kind: "hook", name: `h${id}`, text: `t${id}`, keywords: [], url: null, createdAt: 0 }));
  const ctx = (excluded: number[]): PickContext => ({
    pool: () => pool, used: { hook: new Set(), angle: new Set(), cta: new Set() }, random: () => 0, best: () => [2, 3, 1],
    excluded: { hook: new Set(excluded), angle: new Set(), cta: new Set() }, notes: [],
  });
  assert.equal(pickValue("hook", { pick: "best" }, ctx([2]))!.id, 3);
  assert.equal(pickValue("hook", { pick: "random" }, ctx([1]))!.id, 2);
  assert.equal(pickValue("hook", { pick: "named", id: 1 }, ctx([1]))!.id, 1);
  const all = ctx([1, 2, 3]);
  assert.equal(pickValue("hook", { pick: "random" }, all)!.id, 1);
  assert.equal(all.notes!.length, 1);
  assert.match(all.notes![0], /stopped/);
  assert.equal(pickValue("hook", { pick: "same_as_rule" }, { ...ctx([]), fixed: { hook: 3 } })!.id, 3);
});

test("copied fields come from the newest matched video's instruction: its CTA, style and types", () => {
  const s = setup();
  // The campaign's first named CTA is A; the matched videos were made with B.
  const id = s.campaign([workingHook()]);
  s.baseline();
  const older = s.make({ cta: { pick: "named", id: s.ctaB }, style: "basic", types: [], post: { at: "07:00" } });
  const newer = s.make({ cta: { pick: "named", id: s.ctaB }, style: "basic", types: [s.typeId], post: { at: "10:30" } });
  s.campaignVideo(id, 10_000, { hook: s.hooks[0], cta: s.ctaB }, older, "2026-11-03");
  s.campaignVideo(id, 10_000, { hook: s.hooks[0], cta: s.ctaB }, older, "2026-11-04");
  s.campaignVideo(id, 10_000, { hook: s.hooks[0], cta: s.ctaB }, newer, "2026-11-05");

  assert.equal(s.evaluate().fired.length, 1);
  const tasks = s.ruleTasks(id);
  assert.equal(tasks.length, 3);
  for (const t of tasks) {
    assert.equal((t.choices.cta as LibraryEntry).id, s.ctaB, "the matched videos' CTA");
    assert.deepEqual(t.choices.types, [s.typeId]);
    assert.equal(t.choices.style, "basic");
    assert.equal(t.choices.postTime, "10:30");
  }

  // A matched video whose CTA was random: the campaign's first named CTA.
  const r = setup();
  const id2 = r.campaign([workingHook()]);
  r.baseline();
  for (let i = 0; i < 3; i++) r.campaignVideo(id2, 10_000, { hook: r.hooks[0], cta: r.ctaB }, r.make({ cta: { pick: "random" } }));
  r.evaluate();
  const made = r.ruleTasks(id2);
  assert.equal(made.length, 3);
  for (const t of made) assert.equal((t.choices.cta as LibraryEntry).id, r.ctaA);
});

test("a rule's posts keep the daily cap; killed, nothing is evaluated", async () => {
  const s = setup({ cap: 1, defaults: ["09:00", "18:00"] });
  const id = s.campaign([workingHook({}, { kind: "make", count: 2, keep: ["hook"], vary: ["angle"], post: true })]);
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 10_000, { hook: s.hooks[0] });

  s.cs.setKilled(true);
  assert.deepEqual(s.evaluate().fired, []);
  assert.equal(s.ruleTasks(id).length, 0);
  assert.equal(s.cs.db.prepare("SELECT COUNT(*) AS n FROM rule_firings").get()!.n, 0, "a killed run doesn't use up the firing");
  s.cs.setKilled(false);

  assert.equal(s.evaluate().fired.length, 1);
  const tasks = s.ruleTasks(id);
  assert.equal(tasks.length, 2);
  // Both go through the one make pipeline: script, audio, production, edit, review.
  await s.tick();
  let clip = 1;
  for (const t of tasks) s.ps.setState(s.cs.task(t.id)!.productionId!, { state: "ready", outputPath: clips[clip++], durationSec: 4 });
  await s.tick();
  for (const t of tasks) {
    const e = s.store.edit(s.cs.task(t.id)!.editId!)!;
    s.store.updateEdit(e.id, { state: "ready", outputPath: e.sourcePath, durationSec: 4, progress: 1 });
  }
  await s.tick();
  for (const t of tasks) {
    assert.equal(s.cs.task(t.id)!.state, "reviewing", s.cs.task(t.id)!.error ?? "");
    await s.reviews.tick();
    const out = await s.reviews.approve(s.cs.task(t.id)!.reviewId!, { via: "window" });
    assert.ok(out.ok, out.message);
  }
  await s.tick();
  const days = tasks.map((t) => {
    const task = s.cs.task(t.id)!;
    assert.equal(task.state, "scheduled", task.error ?? "");
    return dayKey(s.store.post(task.postId!)!.scheduledAt!);
  }).sort();
  assert.deepEqual(days, ["2026-11-17", "2026-11-18"], "the cap of 1 moves the second to tomorrow");
});

test("scope account counts every video on the campaign's accounts, but copies only this campaign's own line and CTA", () => {
  const s = setup();
  const otherLine = s.make({ style: "fancy", cta: { pick: "named", id: s.ctaB }, types: [s.typeId], post: { at: "07:00" } });
  const other = s.campaign([], { sun: [otherLine] }, "Other");
  const id = s.campaign([workingHook({ scope: "account" })]);
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(other, 10_000, { hook: s.hooks[2], cta: s.ctaB, style: "fancy", types: [s.typeId] }, otherLine);
  assert.deepEqual(s.evaluate().fired.map((f) => [f.campaignId, f.key]), [[id, `hook:${s.hooks[2]}`]]);
  const tasks = s.ruleTasks(id);
  assert.equal(tasks.length, 3);
  for (const t of tasks) {
    assert.equal((t.choices.hook as LibraryEntry).id, s.hooks[2], "the matched hook is pinned");
    assert.equal(t.choices.style, "basic", "this campaign's own line's style, not the other campaign's");
    assert.equal((t.choices.cta as LibraryEntry).id, s.ctaA, "this campaign's CTA, never the other campaign's");
    assert.deepEqual(t.choices.types, []);
  }
  assert.equal(s.ruleTasks(other).length, 0);
});

test("a campaign-scoped rule ignores another campaign's high-scoring videos", () => {
  const s = setup();
  const other = s.campaign([], { sun: [s.make()] }, "Other");
  const id = s.campaign([workingHook()]);
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(other, 10_000, { hook: s.hooks[2] });
  assert.deepEqual(s.evaluate().fired, []);
  assert.equal(s.ruleTasks(id).length, 0);
});

test("a copied CTA that can't be used falls back: the source task's CTA, then random; no CTA at all doesn't fire and says so once", () => {
  // The campaign's named CTA is gone; the source line's CTA was random, and its video got B.
  const s = setup();
  const id = s.campaign([workingHook()]);
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 10_000, { hook: s.hooks[0], cta: s.ctaB }, s.make({ cta: { pick: "random" } }));
  s.cs.deleteEntry(s.ctaA);
  assert.equal(s.evaluate().fired.length, 1);
  for (const t of s.ruleTasks(id)) {
    assert.equal(t.state, "queued", t.error ?? "");
    assert.equal((t.choices.cta as LibraryEntry).id, s.ctaB);
  }

  // B is gone too: a random library CTA.
  const r = setup();
  const id2 = r.campaign([workingHook()]);
  r.baseline();
  for (let i = 0; i < 3; i++) r.campaignVideo(id2, 10_000, { hook: r.hooks[0], cta: r.ctaB }, r.make({ cta: { pick: "random" } }));
  r.cs.deleteEntry(r.ctaA);
  r.cs.deleteEntry(r.ctaB);
  const ctaC = r.cs.addEntry({ kind: "cta", name: "c", text: "Follow for more", url: "https://example.com/c" });
  assert.equal(r.evaluate().fired.length, 1);
  for (const t of r.ruleTasks(id2)) {
    assert.equal(t.state, "queued", t.error ?? "");
    assert.equal((t.choices.cta as LibraryEntry).id, ctaC);
  }

  // No CTA in the library at all: nothing fires, nothing is spent, and the user is told once.
  const q = setup();
  const id3 = q.campaign([workingHook()]);
  q.baseline();
  for (let i = 0; i < 3; i++) q.campaignVideo(id3, 10_000, { hook: q.hooks[0] });
  q.cs.deleteEntry(q.ctaA);
  q.cs.deleteEntry(q.ctaB);
  assert.deepEqual(q.evaluate().fired, []);
  assert.deepEqual(q.evaluate().fired, []);
  assert.equal(q.ruleTasks(id3).length, 0);
  assert.equal(q.cs.db.prepare("SELECT COUNT(*) AS n FROM rule_firings").get()!.n, 0);
  const failed = q.store.outbox().filter((e) => e.event === "campaign.failed");
  assert.equal(failed.length, 1);
  assert.match(JSON.parse(failed[0].body).summary, /CTA/);
});

test("no source video and no make line: one failure event, nothing spent", () => {
  const s = setup();
  const other = s.campaign([], { sun: [s.make()] }, "Other");
  const id = s.campaign([workingHook({ scope: "account" })], {});
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(other, 10_000, { hook: s.hooks[2] });
  assert.deepEqual(s.evaluate().fired, []);
  assert.deepEqual(s.evaluate().fired, []);
  assert.equal(s.cs.db.prepare("SELECT COUNT(*) AS n FROM rule_firings").get()!.n, 0);
  const failed = s.store.outbox().filter((e) => e.event === "campaign.failed");
  assert.equal(failed.length, 1);
  assert.equal(JSON.parse(failed[0].body).campaign_id, id);
});

test("a firing whose tasks can't be made isn't spent: it fires on the next refresh", () => {
  const s = setup();
  const id = s.campaign([workingHook()]);
  s.baseline();
  for (let i = 0; i < 3; i++) s.campaignVideo(id, 10_000, { hook: s.hooks[0] });
  const real = s.worker.addRuleTasks.bind(s.worker);
  s.worker.addRuleTasks = (...args) => { real(...args); throw new Error("disk full"); };
  assert.deepEqual(s.evaluate().fired, []);
  assert.equal(s.cs.db.prepare("SELECT COUNT(*) AS n FROM rule_firings").get()!.n, 0);
  assert.equal(s.ruleTasks(id).length, 0, "the half-made tasks are rolled back");
  s.worker.addRuleTasks = real;
  assert.equal(s.evaluate().fired.length, 1);
  assert.equal(s.ruleTasks(id).length, 3);
});
