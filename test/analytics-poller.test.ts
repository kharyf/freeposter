import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { MetricsPoller, nextPollAt } from "../src/analytics/poller.ts";
import { AGES, type MetricReading } from "../src/analytics/types.ts";
import { Gone, NeedsPermission, PlanLimited, StillProcessing, type MetricsContext, type Publisher } from "../src/platforms/base.ts";
import type { Platform } from "../src/types.ts";
import { account, newStore } from "./helpers.ts";

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 1);
const mid = () => 0.5; // no jitter
const reading = (views: number): MetricReading => ({ views, viewsKind: "views", raw: { views, likes: 3 }, retention: null });

function fake(platform: Platform, metrics: (ctx: MetricsContext) => Promise<MetricReading>): Publisher {
  return { platform, label: platform, analyticsScopes: [], minDurationSec: 1, maxDurationSec: () => 60, validate: () => null, authorizeUrl: () => "",
    exchangeCode: async () => [], refresh: async () => null, publish: async () => ({ url: "" }), metrics } as Publisher;
}

/** A published job (published at T0) for a fresh account of the platform. */
function publishedJob(store: ReturnType<typeof newStore>, platform: Platform, n = 1) {
  const acct = store.upsertAccount(account(platform, { externalId: `${platform}-${n}`, expiresAt: null }));
  const postId = store.createPost({ caption: "", title: "", sourcePath: "x.mp4", sha256: `sha-${platform}-${n}`, tiktok: null }, [acct.id]);
  const job = store.jobsForPost(postId)[0];
  store.finishJob(job.id, "published", { resultUrl: "https://example.com/v" });
  store.db.prepare("UPDATE jobs SET published_at = ?, progress = ? WHERE id = ?").run(T0, JSON.stringify({ videoId: "vid" }), job.id);
  return job.id;
}

function setup(publishers: Partial<Record<Platform, Publisher>>) {
  const store = newStore();
  let now = T0;
  const poller = new MetricsPoller(store, publishers as Record<Platform, Publisher>, { now: () => now, random: mid });
  const analytics = new AnalyticsStore(store);
  return { store, poller, analytics, at: (t: number) => (now = t) };
}

test("nextPollAt walks 1h→6h→24h→72h→7d→30d then null", () => {
  const ages = Object.values(AGES);
  let last: number | null = null;
  const seen: number[] = [];
  for (;;) {
    const t = nextPollAt(T0, last, mid);
    if (t === null) break;
    seen.push((t - T0) / 1000);
    last = (t - T0) / 1000;
  }
  assert.deepEqual(seen, ages);
  // jitter: ±10% of the gap since the previous age (6h: gap 5h)
  assert.equal(nextPollAt(T0, AGES["1h"], () => 0), T0 + AGES["6h"] * 1000 - 0.1 * (AGES["6h"] - AGES["1h"]) * 1000);
  assert.equal(nextPollAt(T0, AGES["1h"], () => 1), T0 + AGES["6h"] * 1000 + 0.1 * (AGES["6h"] - AGES["1h"]) * 1000);
  assert.equal(nextPollAt(T0, null, () => 0), T0 + 3_600_000 * 0.9);
});

test("a snapshot stores the age since publish and the raw reading", async () => {
  const t = setup({ x: fake("x", async () => reading(42)) });
  const job = publishedJob(t.store, "x");
  t.poller.schedule(job);
  assert.equal(t.analytics.pollFor(job)!.nextAt, T0 + H);
  const seen: number[][] = [];
  t.poller.onRefresh = (ids) => seen.push(ids);
  t.at(T0 + H + 5_000);
  await t.poller.tick();
  const [s] = t.analytics.snapshots(job);
  assert.equal(s.ageSec, 3_605);
  assert.equal(s.takenAt, T0 + H + 5_000);
  assert.equal(s.externalId, "vid");
  assert.equal(s.reading.views, 42);
  assert.deepEqual(s.reading.raw, { views: 42, likes: 3 });
  assert.deepEqual(seen, [[job]]);
  assert.equal(t.analytics.pollFor(job)!.nextAt, T0 + AGES["6h"] * 1000);
  // the 30-day snapshot ends polling
  t.at(T0 + AGES["30d"] * 1000);
  t.analytics.schedulePoll(job, 0);
  await t.poller.tick();
  assert.equal(t.analytics.pollFor(job)!.done, true);
});

test("Gone is confirmed once, then stops polling for good; a reading in between resets it", async () => {
  let mode: "gone" | "ok" = "gone";
  const t = setup({ x: fake("x", async () => { if (mode === "gone") throw new Gone("404"); return reading(1); }) });
  const job = publishedJob(t.store, "x");
  t.poller.schedule(job);
  t.at(T0 + H);
  await t.poller.tick();
  let p = t.analytics.pollFor(job)!;
  assert.equal(p.lastError, "gone?");
  assert.equal(p.done, false);
  assert.equal(p.nextAt, T0 + H + 6 * H);
  assert.equal(p.attempts, 0);
  // a reading in between resets the doubt
  mode = "ok";
  t.at(T0 + 7 * H);
  await t.poller.tick();
  p = t.analytics.pollFor(job)!;
  assert.equal(p.lastError, null);
  mode = "gone";
  t.at(p.nextAt);
  await t.poller.tick();
  assert.equal(t.analytics.pollFor(job)!.lastError, "gone?");
  assert.equal(t.analytics.pollFor(job)!.done, false);
  // two in a row end it
  t.at(t.analytics.pollFor(job)!.nextAt);
  await t.poller.tick();
  p = t.analytics.pollFor(job)!;
  assert.equal(p.done, true);
  assert.equal(p.lastError, "gone");
  t.poller.schedule(job);
  t.analytics.schedulePoll(job, 0);
  assert.deepEqual(t.analytics.duePolls(Infinity, 10), []);
});

test("NeedsPermission keeps earlier snapshots and resumes after sign-in", async () => {
  let allowed = true;
  const t = setup({ x: fake("x", async () => { if (!allowed) throw new NeedsPermission("scope"); return reading(10); }) });
  const job = publishedJob(t.store, "x");
  t.poller.schedule(job);
  t.at(T0 + H);
  await t.poller.tick();
  assert.equal(t.analytics.snapshots(job).length, 1);
  allowed = false;
  t.at(T0 + AGES["6h"] * 1000);
  await t.poller.tick();
  let p = t.analytics.pollFor(job)!;
  assert.equal(p.lastError, "needs permission");
  assert.equal(p.nextAt, T0 + AGES["6h"] * 1000 + 6 * H);
  assert.equal(t.analytics.snapshots(job).length, 1);
  // signed in again two days later: 24h is passed, so the next snapshot is the one due then and polling goes on at 72h
  allowed = true;
  t.at(p.nextAt + 40 * H);
  await t.poller.tick();
  // the 24h age was missed; the reading taken now (age ~ 52h) stands for 24h and 72h comes next
  p = t.analytics.pollFor(job)!;
  assert.equal(t.analytics.snapshots(job).length, 2);
  assert.equal(p.lastError, null);
  assert.equal(p.nextAt, T0 + AGES["72h"] * 1000);
});

test("StillProcessing retries after its delay without counting an attempt or an error", async () => {
  const t = setup({ x: fake("x", async () => { throw new StillProcessing("wait", 90_000); }) });
  const job = publishedJob(t.store, "x");
  t.poller.schedule(job);
  t.at(T0 + H);
  await t.poller.tick();
  const p = t.analytics.pollFor(job)!;
  assert.equal(p.nextAt, T0 + H + 90_000);
  assert.equal(p.attempts, 0);
  assert.equal(p.lastError, null);
});

test("PlanLimited records its reason and waits for the next age; other errors back off", async () => {
  let fail: Error = new PlanLimited("cap");
  const t = setup({ x: fake("x", async () => { throw fail; }) });
  const job = publishedJob(t.store, "x");
  t.poller.schedule(job);
  t.at(T0 + H);
  await t.poller.tick();
  let p = t.analytics.pollFor(job)!;
  assert.equal(p.lastError, "limited by plan");
  assert.equal(p.nextAt, T0 + AGES["6h"] * 1000);
  fail = new Error("boom");
  t.at(p.nextAt);
  await t.poller.tick();
  p = t.analytics.pollFor(job)!;
  assert.equal(p.lastError, "boom");
  assert.equal(p.attempts, 1);
  assert.equal(p.nextAt, T0 + AGES["6h"] * 1000 + 30_000);
});

test("one platform failing does not block another's poll in the same tick", async () => {
  const t = setup({
    x: fake("x", async () => { throw new Error("x is down"); }),
    youtube: fake("youtube", async () => reading(7)),
  });
  const bad = publishedJob(t.store, "x");
  const good = publishedJob(t.store, "youtube");
  t.poller.schedule(bad);
  t.poller.schedule(good);
  t.at(T0 + H);
  await t.poller.tick();
  assert.equal(t.analytics.pollFor(bad)!.lastError, "x is down");
  assert.equal(t.analytics.snapshots(good).length, 1);
});

test("polls of one account run one at a time; different accounts run side by side", async () => {
  const open = new Map<number, number>();
  let peakPerAccount = 0, total = 0, peakTotal = 0;
  const slow = (platform: Platform) => fake(platform, async (ctx) => {
    const n = (open.get(ctx.account.id) ?? 0) + 1;
    open.set(ctx.account.id, n);
    total++;
    peakPerAccount = Math.max(peakPerAccount, n);
    peakTotal = Math.max(peakTotal, total);
    await new Promise((r) => setTimeout(r, 20));
    open.set(ctx.account.id, n - 1);
    total--;
    return reading(1);
  });
  const t = setup({ x: slow("x"), youtube: slow("youtube") });
  // two jobs on the same x account
  const acct = t.store.upsertAccount(account("x", { expiresAt: null }));
  const jobs = [1, 2].map((n) => {
    const postId = t.store.createPost({ caption: "", title: "", sourcePath: "x.mp4", sha256: `s${n}`, tiktok: null }, [acct.id]);
    const j = t.store.jobsForPost(postId)[0];
    t.store.finishJob(j.id, "published", {});
    t.store.db.prepare("UPDATE jobs SET published_at = ? WHERE id = ?").run(T0, j.id);
    return j.id;
  });
  const other = publishedJob(t.store, "youtube");
  [...jobs, other].forEach((j) => t.poller.schedule(j));
  t.at(T0 + H);
  await t.poller.tick();
  assert.equal(t.analytics.snapshots(jobs[0]).length + t.analytics.snapshots(jobs[1]).length + t.analytics.snapshots(other).length, 3);
  assert.equal(peakPerAccount, 1);
  assert.equal(peakTotal, 2);
});

test("back-fill schedules published jobs that have no poll row", () => {
  const t = setup({ x: fake("x", async () => reading(1)) });
  const job = publishedJob(t.store, "x");
  assert.equal(t.analytics.pollFor(job), undefined);
  t.poller.backfill();
  assert.equal(t.analytics.pollFor(job)!.nextAt, T0 + H);
});
