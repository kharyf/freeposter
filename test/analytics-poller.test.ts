import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { AuthError } from "../src/http.ts";
import { Runner } from "../src/runner.ts";
import type { Job } from "../src/types.ts";
import { MetricsPoller, externalIdOf, nextPollAt } from "../src/analytics/poller.ts";
import { AGES, type MetricReading } from "../src/analytics/types.ts";
import { Gone, NeedsPermission, PlanLimited, StillProcessing, type MetricsContext, type Publisher } from "../src/platforms/base.ts";
import type { Platform } from "../src/types.ts";
import { account, newStore, tmp } from "./helpers.ts";

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
  store.db.prepare("UPDATE jobs SET published_at = ?, progress = ? WHERE id = ?").run(T0, JSON.stringify({ videoId: "vid", mediaId: "vid", tweetId: "vid" }), job.id);
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

test("tokens are refreshed through the shared refresher, once even when refreshes overlap", async () => {
  const store = newStore();
  let refreshes = 0;
  const seen: string[] = [];
  const pub = {
    ...fake("x", async (ctx) => { seen.push(ctx.account.accessToken); return reading(1); }),
    refresh: async () => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 30));
      return { accessToken: "fresh", refreshToken: "r2", expiresAt: T0 + 100 * H, refreshExpiresAt: null };
    },
  } as Publisher;
  const publishers = { x: pub } as Record<Platform, Publisher>;
  const runner = new Runner(store, publishers, tmp());
  const poller = new MetricsPoller(store, publishers, { now: () => T0 + H, random: mid, freshAccount: (a, force) => runner.freshAccount(a, force) });
  const acct = store.upsertAccount(account("x", { expiresAt: Date.now() + 60_000 }));
  const postId = store.createPost({ caption: "", title: "", sourcePath: "x.mp4", sha256: "s", tiktok: null }, [acct.id]);
  const job = store.jobsForPost(postId)[0];
  store.finishJob(job.id, "published", {});
  store.db.prepare("UPDATE jobs SET published_at = ? WHERE id = ?").run(T0, job.id);
  poller.schedule(job.id);
  await Promise.all([runner.freshAccount(store.account(acct.id)!), poller.tick()]);
  assert.equal(refreshes, 1);
  assert.deepEqual(seen, ["fresh"]);
});

test("a rejected token is force-refreshed once and the read retried", async () => {
  const forced: (boolean | undefined)[] = [];
  let calls = 0;
  const store = newStore();
  const poller = new MetricsPoller(store, { x: fake("x", async () => { if (calls++ === 0) throw new AuthError("401"); return reading(5); }) } as Record<Platform, Publisher>,
    { now: () => T0 + H, random: mid, freshAccount: async (a, force) => { forced.push(force); return a; } });
  const analytics = new AnalyticsStore(store);
  const job = publishedJob(store, "x");
  poller.schedule(job);
  await poller.tick();
  assert.deepEqual(forced, [undefined, true]);
  assert.equal(analytics.snapshots(job).length, 1);
});

test("past the 30-day window every outcome ends the poll without a snapshot", async () => {
  for (const err of [new NeedsPermission("p"), new StillProcessing("s", 1000), new Gone("g"), null]) {
    let calls = 0;
    const t = setup({ x: fake("x", async () => { calls++; if (err) throw err; return reading(1); }) });
    const job = publishedJob(t.store, "x");
    t.poller.schedule(job);
    t.at(T0 + 40 * 24 * H);
    await t.poller.tick();
    assert.equal(t.analytics.pollFor(job)!.done, true, String(err?.constructor.name));
    assert.equal(calls, 0);
    assert.equal(t.analytics.snapshots(job).length, 0);
  }
});

test("StillProcessing clears a pending gone? so only two Gones in a row count", async () => {
  const modes: (Error | null)[] = [new Gone("g"), new StillProcessing("s", 1000), new Gone("g")];
  const t = setup({ x: fake("x", async () => { const m = modes.shift(); if (m) throw m; return reading(1); }) });
  const job = publishedJob(t.store, "x");
  t.poller.schedule(job);
  for (let i = 0; i < 3; i++) {
    t.at(T0 + H + i * 7 * H);
    await t.poller.tick();
  }
  const p = t.analytics.pollFor(job)!;
  assert.equal(p.done, false);
  assert.equal(p.lastError, "gone?");
});

test("stop() during a tick keeps the poller from running again", async () => {
  const t = setup({ x: fake("x", async () => { await new Promise((r) => setTimeout(r, 40)); return reading(1); }) });
  const job = publishedJob(t.store, "x");
  t.poller.schedule(job);
  t.at(T0 + H);
  let ticks = 0;
  const real = t.poller.tick.bind(t.poller);
  t.poller.tick = () => { ticks++; return real(); };
  t.poller.start(5);
  await new Promise((r) => setTimeout(r, 10));
  t.poller.stop();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(ticks, 1);
  assert.equal(t.poller.timer === undefined || t.poller.stopped, true);
});

test("the external id comes from where each publisher keeps it", () => {
  const job = (platform: Platform, progress: Record<string, unknown>, resultUrl: string | null = null) =>
    ({ id: 99, platform, progress, resultUrl }) as Job;
  assert.equal(externalIdOf(job("youtube", { videoId: "yt1", uploadUrl: "u" })), "yt1");
  assert.equal(externalIdOf(job("facebook", { videoId: "fb1" })), "fb1");
  assert.equal(externalIdOf(job("instagram", { containerId: "c", mediaId: "ig1" })), "ig1");
  assert.equal(externalIdOf(job("x", { mediaId: "m", tweetId: "tw1" })), "tw1");
  assert.equal(externalIdOf(job("tiktok", { publishId: "p" }, "https://www.tiktok.com/@u/video/7123")), "7123");
  assert.equal(externalIdOf(job("tiktok", {}, null)), "99");
});
