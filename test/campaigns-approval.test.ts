import "./isolated-home.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { AiService } from "../src/ai/router.ts";
import type { Script } from "../src/campaigns/script.ts";
import { DAYS, type CompiledCampaign, type Day, type MakeInstruction } from "../src/campaigns/spec.ts";
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
  const hooks: { beforePrepare?: () => void } = {};
  // The exact file is the edit's own output here (no re-encode): the same preparation path, minus ffmpeg's time.
  const reviews = new ReviewService(store, {
    publishers, runner: { tick() {} }, dir: tmp(),
    prepare: async (source) => {
      hooks.beforePrepare?.();
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
  const campaign = (days: Partial<Record<Day, MakeInstruction[]>>) => {
    const id = cs.create({ name: "Weekday Growth", text: "the text", accountSetId: null, defaultPostTimes: ["09:00", "18:00"] });
    cs.confirm(id, { version: 1, days: { ...emptyDays(), ...days }, rules: [] });
    return id;
  };
  const tick = async () => { await worker.tick(); await worker.idle(); };
  let nextClip = 1;
  /** One make task from queued to its review (the worker asks for it once the edit is ready). */
  const toReview = async (taskId: number) => {
    await tick();
    const t = cs.task(taskId)!;
    ps.setState(t.productionId!, { state: "ready", outputPath: clips[nextClip++], durationSec: 4 });
    await tick();
    const e = store.edit(cs.task(taskId)!.editId!)!;
    store.updateEdit(e.id, { state: "ready", outputPath: e.sourcePath, durationSec: 4, progress: 1 });
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
  return { store, cs, clock, reviews, worker, hooks, make, campaign, tick, toReview, oneVideo, publish };
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
