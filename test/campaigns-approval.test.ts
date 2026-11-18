import "./isolated-home.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { AiService } from "../src/ai/router.ts";
import type { Script } from "../src/campaigns/script.ts";
import { DAYS, type CompiledCampaign, type Day, type MakeInstruction, type PostInstruction } from "../src/campaigns/spec.ts";
import { CampaignStore, mayPostUnseen } from "../src/campaigns/store.ts";
import { CampaignWorker } from "../src/campaigns/worker.ts";
import { publishers } from "../src/platforms/index.ts";
import type { ProductionSpec } from "../src/produce/spec.ts";
import { ProductionStore } from "../src/produce/store.ts";
import { hashFile } from "../src/review/media.ts";
import { ReviewService } from "../src/review/service.ts";
import { account, makeVideo, newStore, tmp } from "./helpers.ts";

process.env.TZ = "America/New_York";

let clips: string[] = [];
before(() => {
  const dir = tmp();
  clips = [3, 4, 5, 6, 7, 3.5].map((sec, i) => makeVideo(dir, `clip${i}.mp4`, ["-f", "lavfi", "-i", `testsrc2=size=360x640:rate=24`, "-t", String(sec), "-c:v", "libx264", "-pix_fmt", "yuv420p"]));
});

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
/** Tuesday 17 November 2026, 08:00 local */
const TUE = at(2026, 11, 17, 8);
const emptyDays = () => Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"];

function setup() {
  const store = newStore();
  store.upsertAccount(account("x"));
  const cs = new CampaignStore(store);
  cs.addEntry({ kind: "hook", name: "h", text: "Stop scrolling" });
  cs.addEntry({ kind: "angle", name: "a", text: "Your week is a mess" });
  const cta = cs.addEntry({ kind: "cta", name: "try", text: "Try it free today", url: "https://example.com/plan" });
  const clock = { now: TUE };
  const hooks: { beforePrepare?: () => unknown } = {};
  // The exact file is the edit's own output here (no re-encode): the same preparation path, minus ffmpeg's time.
  const reviews = new ReviewService(store, {
    publishers, runner: { tick() {} }, dir: tmp(),
    prepare: async (source) => {
      await hooks.beforePrepare?.();
      return { masterPath: source, masterSha256: await hashFile(source), viewPath: source, durationSec: 4 };
    },
  });
  const ps = new ProductionStore(store);
  const productions = {
    productions: ps,
    createStaged: async (spec: ProductionSpec) => ps.create(spec, []),
    borrowGpu: async <T>(fn: () => Promise<T>) => ({ value: await fn() }),
  };
  const ai = {
    ask: async (): Promise<Script> => ({
      lines: ["Stop scrolling, this plans your week.", "Try it free today"],
      shots: [{ prompt: "a calendar", sec: 4 }, { prompt: "a happy person", sec: 5 }], caption: "Plan your week https://example.com/plan", title: "Plan your week", musicPrompt: "lo-fi",
    }),
  } as unknown as AiService;
  const worker = new CampaignWorker({
    store, productions, reviews, ai, now: () => clock.now, random: () => 0.5,
    speech: async () => clips[0], music: async () => clips[0], dir: tmp(),
  });
  const make = (types: number[], post: MakeInstruction["post"] = { at: "default" }): MakeInstruction => ({
    kind: "make", count: 1, style: "basic", hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, types, post,
    source: "make 1",
  });
  const postLine = (name: string, time: string, types: number[]): PostInstruction => ({ kind: "post", name, at: time, style: null, types, source: `post ${name}` });
  const campaign = (days: Partial<Record<Day, (MakeInstruction | PostInstruction)[]>>) => {
    const id = cs.create({ name: "Weekday Growth", text: "the text", accountSetId: null, defaultPostTimes: ["09:00", "18:00"] });
    cs.confirm(id, { version: 1, days: { ...emptyDays(), ...days }, rules: [] });
    return id;
  };
  const tick = async () => { await worker.tick(); await worker.idle(); };
  let nextClip = 1;
  /** One make task from queued to a ready edit (the worker asks for its review on its next tick). */
  const toEdited = async (taskId: number) => {
    await tick();
    const t = cs.task(taskId)!;
    ps.setState(t.productionId!, { state: "ready", outputPath: clips[nextClip++], durationSec: 4 });
    await tick();
    const e = store.edit(cs.task(taskId)!.editId!)!;
    store.updateEdit(e.id, { state: "ready", outputPath: e.sourcePath, durationSec: 4, progress: 1 });
  };
  /** One make task from queued to its review, prepared. */
  const toReview = async (taskId: number) => {
    await toEdited(taskId);
    await tick();
    await reviews.tick();
    return cs.task(taskId)!;
  };
  /** One task of a one-line Tuesday campaign, taken to its review. */
  const oneVideo = async (types: number[], post?: MakeInstruction["post"]) => {
    const id = campaign({ tue: [make(types, post)] });
    worker.materialize();
    const [t] = cs.tasksOn(id, "2026-11-17");
    return toReview(t.id);
  };
  const publish = (postId: number) => {
    const sha = store.post(postId)!.approvedSha256!;
    for (const j of store.jobsForPost(postId)) { store.recordUpload(j.id, sha); store.finishJob(j.id, "published", { resultUrl: "https://x.com/1" }); }
  };
  return { store, cs, clock, reviews, worker, hooks, make, postLine, campaign, tick, toEdited, toReview, oneVideo, publish };
}

const autoOf = (s: ReturnType<typeof setup>, reviewId: number) =>
  (s.store.db.prepare("SELECT auto FROM reviews WHERE id = ?").get(reviewId) as { auto: number }).auto;

test("mayPostUnseen: at least one type, and every one of them allows it", () => {
  const { cs } = setup();
  const promo = cs.addType({ name: "Promo", color: "#f00" });
  const tips = cs.addType({ name: "Tips", color: "#0f0" });
  assert.equal(mayPostUnseen(cs, []), false, "no types: waits");
  assert.equal(mayPostUnseen(cs, [promo]), false, "off by default");
  cs.setTypeAutoPost(promo, true);
  assert.equal(mayPostUnseen(cs, [promo]), true);
  assert.equal(mayPostUnseen(cs, [promo, tips]), false, "one allowed, one not: waits");
  cs.setTypeAutoPost(tips, true);
  assert.equal(mayPostUnseen(cs, [promo, tips]), true);
  assert.equal(mayPostUnseen(cs, [promo, 999]), false, "a type that doesn't exist (deleted) never allows it");
});

test("a campaign video with no types waits for approval", async () => {
  const s = setup();
  const t = await s.oneVideo([]);
  assert.equal(t.state, "reviewing");
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.state, "pending");
  assert.equal(autoOf(s, r.id), 0);
  assert.equal(r.postId, null);
});

test("one type allowed and one not: it waits for approval", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  const tips = s.cs.addType({ name: "Tips", color: "#0f0" });
  s.cs.setTypeAutoPost(promo, true);
  const t = await s.oneVideo([promo, tips]);
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.state, "pending");
  assert.equal(autoOf(s, r.id), 0);
});

test("every type allowed: it posts without approval, recorded as an auto review the audit passes and lists", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  const t = await s.oneVideo([promo]);
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.state, "approved");
  assert.equal(autoOf(s, r.id), 1);
  assert.equal(r.decidedVia, "type");
  assert.ok(r.decidedAt);
  assert.ok(r.postId);
  assert.equal(s.reviews.view(r).auto, true, "the history shows it posted unseen");
  // No Telegram card is sent for a review nobody has to decide.
  assert.equal(s.reviews.reviews.dueCards(Date.now() + 1e9).some((x) => x.id === r.id), false);
  // The worker places it as any approved campaign post: held until then, at its time.
  await s.tick();
  const placed = s.cs.task(t.id)!;
  assert.equal(placed.state, "scheduled", placed.error ?? "");
  assert.equal(placed.postId, r.postId);
  assert.equal(s.store.post(r.postId!)!.scheduledAt, at(2026, 11, 17, 9));
  assert.ok(s.store.jobsForPost(r.postId!).every((j) => j.progress.heldFrom === undefined), "released");
  s.publish(r.postId!);
  const audit = s.reviews.audit();
  assert.equal(audit.ok, true, JSON.stringify(audit.problems));
  assert.deepEqual(audit.auto, [{ review_id: r.id, post_id: r.postId }]);

  // Switching the type off later changes nothing already posted.
  s.cs.setTypeAutoPost(promo, false);
  await s.tick();
  await s.reviews.tick();
  const after = s.reviews.reviews.get(r.id)!;
  assert.equal(after.state, "approved");
  assert.equal(autoOf(s, r.id), 1);
  assert.ok(s.store.post(r.postId!));
  assert.equal(s.reviews.audit().ok, true);
  assert.deepEqual(s.reviews.audit().auto, [{ review_id: r.id, post_id: r.postId }]);
});

test("a type switched off while the video is being prepared: it waits for approval", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  s.hooks.beforePrepare = () => s.cs.setTypeAutoPost(promo, false);
  const t = await s.oneVideo([promo]);
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.state, "pending", r.error ?? "");
  assert.equal(autoOf(s, r.id), 0);
  assert.equal(r.postId, null);
  assert.equal(r.decidedVia, null);
});

test("a video made to keep, with allowed types, is kept without approval and nothing is posted", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  const t = await s.oneVideo([promo], null);
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.state, "approved");
  assert.equal(autoOf(s, r.id), 1);
  assert.equal(r.postId, null);
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "kept");
  assert.equal(s.store.db.prepare("SELECT COUNT(*) AS n FROM posts").get()!.n, 0);
});

test("autoApprove checks the types itself: a caller's word is never enough", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  const edit = s.store.createEdit(clips[5], await hashFile(clips[5]), { } as any);
  s.store.updateEdit(edit.id, { state: "ready", outputPath: clips[5], durationSec: 4, progress: 1 });
  const q = {
    subject: { kind: "edit" as const, id: edit.id }, accountIds: [s.store.accounts()[0].id], caption: "hi", title: "hi",
    scheduledAt: null, tiktok: null, allowDuplicate: false, via: "campaign" as const, expireAtSchedule: false,
  };
  await assert.rejects(s.reviews.autoApprove({ ...q, via: "agent" }, [promo]), /campaign/);
  const r = await s.reviews.autoApprove(q, [promo]); // Promo doesn't allow it
  await s.reviews.tick();
  const got = s.reviews.reviews.get(r.id)!;
  assert.equal(got.state, "pending");
  assert.equal(autoOf(s, r.id), 0);
});

test("cancelling a held post never deletes a job that has tried, or carries an upload checkpoint", () => {
  const s = setup();
  const x = s.store.accounts()[0].id;
  const held = () => s.store.createPost({ caption: "", title: "", sourcePath: clips[0], sha256: "s", tiktok: null, scheduledAt: null }, [x], { held: true });
  const job = (postId: number) => s.store.jobsForPost(postId)[0];
  // Never tried, nothing but its held time: cancelled.
  const fresh = held();
  assert.equal(s.store.cancelPost(fresh).cancelled, 1);
  assert.equal(s.store.post(fresh), undefined);
  // A held retry that already tried once: it may have half-made a post, so it's kept.
  const tried = held();
  s.store.db.prepare("UPDATE jobs SET state = 'retry', attempts = 1 WHERE id = ?").run(job(tried).id);
  assert.equal(s.store.cancelPost(tried).cancelled, 0);
  assert.ok(s.store.post(tried));
  // A held job with an upload checkpoint (an Instagram container): kept.
  const checkpoint = held();
  const p = job(checkpoint).progress;
  s.store.db.prepare("UPDATE jobs SET state = 'waiting_quota', progress = ? WHERE id = ?").run(JSON.stringify({ ...p, containerId: "c1", uploadStarted: true }), job(checkpoint).id);
  assert.equal(s.store.cancelPost(checkpoint).cancelled, 0);
  assert.ok(s.store.post(checkpoint));
  // A held queued job that's waited for quota, never sent anything: cancelled.
  const waited = held();
  s.store.db.prepare("UPDATE jobs SET state = 'waiting_quota' WHERE id = ?").run(job(waited).id);
  assert.equal(s.store.cancelPost(waited).cancelled, 1);
});

test("autoApprove doesn't wait for the file: the worker records the review at once and goes on", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const id = s.campaign({ tue: [s.make([promo])] });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.toEdited(t.id);
  s.hooks.beforePrepare = () => gate;
  const ticked = await Promise.race([s.tick().then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 1500))]);
  if (ticked !== "done") release(); // let the hung tick finish before failing
  assert.equal(ticked, "done", "the worker's tick waited for the file to be made");
  const waiting = s.cs.task(t.id)!;
  assert.equal(waiting.state, "reviewing");
  assert.ok(waiting.reviewId, "the review is recorded before its file is made");
  assert.equal(s.reviews.reviews.get(waiting.reviewId!)!.state, "preparing");
  await s.tick(); // a preparing review: the task waits
  assert.equal(s.cs.task(t.id)!.state, "reviewing");
  release();
  await s.reviews.tick();
  assert.equal(s.reviews.reviews.get(waiting.reviewId!)!.state, "approved");
  await s.tick();
  assert.equal(s.cs.task(t.id)!.state, "scheduled", s.cs.task(t.id)!.error ?? "");
});

test("a held post whose job already tried is failed, not stranded, when its task stops; the event says what happened", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  const t = await s.oneVideo([promo]);
  const postId = s.reviews.reviews.get(t.reviewId!)!.postId!;
  const [job] = s.store.jobsForPost(postId);
  assert.equal(typeof job.progress.heldFrom, "number", "held until placed");
  // It had tried once (say, released, then the kill switch): it may have half-made a post on X.
  s.store.db.prepare("UPDATE jobs SET state = 'retry', attempts = 1 WHERE id = ?").run(job.id);
  s.cs.updateTask(t.id, { state: "failed", error: "something broke" });
  await s.tick();
  const failed = s.store.job(job.id)!;
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /cancelled while held: it had already started on x; check there for a leftover draft/);
  assert.equal(failed.progress.heldFrom, undefined, "no longer held");
  assert.ok(s.store.post(postId), "kept in the history");
  const ev = JSON.parse(s.store.eventByKey(`campaign.failed:post:${postId}`)!.body);
  assert.doesNotMatch(ev.summary, /its post was cancelled and nothing was posted/);
  assert.match(ev.summary, /already started on x/);
  // Not picked up again.
  const count = () => (s.store.db.prepare("SELECT COUNT(*) AS n FROM notify_outbox").get() as { n: number }).n;
  const n = count();
  await s.tick();
  assert.equal(count(), n);
  assert.equal(s.store.job(job.id)!.state, "failed");
});

test("an auto video whose file can't be prepared fails like any review: the task fails and says so", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  s.hooks.beforePrepare = () => { throw new Error("ffmpeg broke"); };
  const t = await s.oneVideo([promo]);
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.state, "failed");
  assert.equal(autoOf(s, r.id), 0);
  assert.ok(s.store.eventByKey(`review.failed:${r.id}`));
  await s.tick();
  const after = s.cs.task(t.id)!;
  assert.equal(after.state, "failed");
  assert.match(after.error ?? "", /ffmpeg broke/);
  assert.ok(s.store.eventByKey(`campaign.failed:${t.id}`));
});

test("a kept video approved by its types whose keeping throws is told, and finished on the next tick", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  const approveEdit = s.store.approveEdit.bind(s.store);
  let broken = true;
  s.store.approveEdit = (id: number) => { if (broken) throw new Error("disk full"); approveEdit(id); };
  const t = await s.oneVideo([promo], null);
  const r = s.reviews.reviews.get(t.reviewId!)!;
  assert.equal(r.state, "approved");
  const told = JSON.parse(s.store.eventByKey(`review.failed:${r.id}`)!.body);
  assert.match(told.summary, /disk full/);
  assert.equal(s.store.eventByKey(`review.approved:${r.id}`), undefined);
  broken = false;
  await s.reviews.tick();
  assert.ok(s.store.eventByKey(`review.approved:${r.id}`), "kept on the next tick");
  assert.ok(s.store.edit(r.subjectId!)!.approvedAt);
});

test("a post line's own types decide: a kept video posts unseen when the line's types allow it", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  const id = s.campaign({ tue: [s.make([], null), s.postLine("WeekdayGrowth-Tue-1", "20:00", [promo])] });
  s.worker.materialize();
  const [made, line] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(made.id);
  const keepReview = s.reviews.reviews.get(s.cs.task(made.id)!.reviewId!)!;
  assert.equal(keepReview.state, "pending", "the kept video has no types: it waits");
  assert.ok((await s.reviews.approve(keepReview.id, { via: "window" })).ok);
  await s.tick(); // kept; the line takes it
  await s.tick(); // the line asks for its review
  await s.reviews.tick();
  const lt = s.cs.task(line.id)!;
  assert.ok(lt.reviewId, `${lt.state} ${lt.error ?? ""}`);
  const r = s.reviews.reviews.get(lt.reviewId!)!;
  assert.equal(r.state, "approved", r.error ?? "");
  assert.equal(autoOf(s, r.id), 1);
  await s.tick();
  assert.equal(s.cs.task(line.id)!.state, "scheduled", s.cs.task(line.id)!.error ?? "");
});

test("a kept video made with allowed types still waits when the post line has none", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  const id = s.campaign({ tue: [s.make([promo], null), s.postLine("WeekdayGrowth-Tue-1", "20:00", [])] });
  s.worker.materialize();
  const [made, line] = s.cs.tasksOn(id, "2026-11-17");
  await s.toReview(made.id);
  await s.tick();
  assert.equal(s.cs.task(made.id)!.state, "kept");
  await s.tick();
  await s.reviews.tick();
  const lt = s.cs.task(line.id)!;
  assert.ok(lt.reviewId, `${lt.state} ${lt.error ?? ""}`);
  const r = s.reviews.reviews.get(lt.reviewId!)!;
  assert.equal(r.state, "pending");
  assert.equal(autoOf(s, r.id), 0);
});

test("a held Drive file a post line names posts unseen when the line's types allow it", async () => {
  const s = setup();
  const promo = s.cs.addType({ name: "Promo", color: "#f00" });
  s.cs.setTypeAutoPost(promo, true);
  const id = s.campaign({ tue: [s.postLine("Launch", "20:00", [promo])] });
  s.store.upsertDriveFile("f1", {
    name: "Launch_RAW.mp4", state: "held", size: 1, sourcePath: clips[5], sha256: await hashFile(clips[5]), caption: "Launch day", title: "Launch",
    uploadedAt: TUE - 3_600_000, choice: { name: "Launch", styleId: null, setId: 1, raw: true, latest: TUE + 86_400_000 }, note: "held by campaign Weekday Growth",
  });
  s.worker.materialize();
  const [t] = s.cs.tasksOn(id, "2026-11-17");
  await s.tick(); // takes the file
  await s.tick(); // asks for its review
  await s.reviews.tick();
  const lt = s.cs.task(t.id)!;
  assert.ok(lt.reviewId, `${lt.state} ${lt.error ?? ""}`);
  const r = s.reviews.reviews.get(lt.reviewId!)!;
  assert.equal(r.subjectKind, "file");
  assert.equal(r.state, "approved", r.error ?? "");
  assert.equal(autoOf(s, r.id), 1);
  await s.tick();
  const placed = s.cs.task(t.id)!;
  assert.equal(placed.state, "scheduled", placed.error ?? "");
  assert.equal(s.store.driveFile("f1")!.postId, placed.postId);
});
