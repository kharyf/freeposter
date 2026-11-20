import "./isolated-home.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { baseline, compareLabels, median, percentile, scoreVideos, shrinkRate, valueAtAge } from "../src/analytics/score.ts";
import type { Snapshot, VideoLabels } from "../src/analytics/types.ts";
import type { ScoredJob } from "../src/analytics/score.ts";

const DAY = 86_400;

test("valueAtAge interpolates log1p between points and never extrapolates", () => {
  const pts = [{ ageSec: DAY, value: 100 }, { ageSec: 3 * DAY, value: 300 }];
  const mid = valueAtAge(pts, 2 * DAY)!;
  assert.ok(Math.abs(mid - (Math.log1p(100) + Math.log1p(300)) / 2) < 1e-9);
  assert.equal(valueAtAge(pts, DAY), Math.log1p(100));
  assert.equal(valueAtAge(pts, 4 * DAY), null);
  assert.equal(valueAtAge(pts, DAY / 2), null);
});

test("percentile uses mid-rank for ties; empty baseline gives no score", () => {
  assert.equal(percentile(2, [1, 2, 2, 3]), 50);
  assert.equal(percentile(10, [1, 2, 3, 4]), 100);
  assert.ok(Number.isNaN(percentile(1, [])));
  assert.deepEqual(baseline([1, 2, 3]), { median: 2, n: 3 });
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("shrinkRate keeps a 40-view video near the prior", () => {
  const r = shrinkRate(20, 40, 0.02);
  assert.ok(r < 0.15 && r > 0.02, String(r));
  assert.ok(Math.abs(shrinkRate(0, 0, 0.05) - 0.05) < 1e-12);
});

function job(id: number, postId: number, accountId: number, publishedAt: number): ScoredJob {
  return { id, postId, accountId, platform: "youtube", publishedAt } as unknown as ScoredJob;
}
function snap(jobId: number, ageSec: number, views: number): Snapshot {
  return { id: jobId * 100 + ageSec, jobId, platform: "youtube", externalId: "x", takenAt: 0, ageSec,
    reading: { views, viewsKind: "views", raw: {}, retention: null } };
}
function label(postId: number, over: Partial<VideoLabels> = {}): VideoLabels {
  return { postId, source: "recorded", styleId: null, hookId: null, hookText: null, angleId: null, angleText: null,
    ctaId: null, ctaText: null, campaignId: null, campaignTaskId: null, types: [], labelledBy: "ai", ...over };
}

function world(count: number) {
  const jobs: ScoredJob[] = [];
  const snaps = new Map<number, Snapshot[]>();
  const labels: VideoLabels[] = [];
  for (let i = 1; i <= count; i++) {
    jobs.push(job(i, i, 1, i * 1000));
    snaps.set(i, [snap(i, DAY, i * 100), snap(i, 3 * DAY, i * 200)]);
    labels.push(label(i));
  }
  return { jobs, snaps, labels };
}

test("scoreVideos is provisional with 7 videos, final with 9", () => {
  const w7 = world(7);
  const s7 = scoreVideos({ labels: w7.labels, snapshotsByJob: w7.snaps, jobs: w7.jobs, now: 1e9 });
  const top7 = s7.find((s) => s.postId === 7)!;
  assert.equal(top7.provisional["24h"], true);
  assert.equal(top7.overall["24h"], 100);
  assert.equal(top7.overall["7d"], undefined);
  const w9 = world(9);
  const s9 = scoreVideos({ labels: w9.labels, snapshotsByJob: w9.snaps, jobs: w9.jobs, now: 1e9 });
  assert.equal(s9.find((s) => s.postId === 9)!.provisional["24h"], false);
});

test("compareLabels is deterministic, sorted, and flags small groups", () => {
  const scores = [1, 2, 3, 4, 5].map((postId) => ({ postId, perPlatform: {}, provisional: {}, overall: { "24h": postId * 10 } }));
  const labels = [
    label(1, { hookId: 1 }), label(2, { hookId: 1 }), label(3, { hookId: 1 }),
    label(4, { hookText: "hi" }), label(5, { hookText: "hi" }),
  ];
  const a = compareLabels(scores, labels, "hook", "24h");
  const b = compareLabels(scores, labels, "hook", "24h");
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((r) => r.key), ["hi", "1"]);
  assert.equal(a[0]!.enough, false);
  assert.equal(a[1]!.enough, true);
  assert.ok(a[1]!.lo <= a[1]!.median && a[1]!.median <= a[1]!.hi);
  const t = compareLabels(scores, [label(1, { types: [1, 2] }), label(2, { types: [2] })], "type", "24h");
  assert.equal(t.find((r) => r.key === "2")!.n, 2);
});

// ---- scoreVideos: baseline selection and aggregation ----

class Bed {
  jobs: ScoredJob[] = [];
  snaps = new Map<number, Snapshot[]>();
  private nextId = 1000;
  /** one video (post) with one job; views null = a snapshot that carries no views */
  add(postId: number, accountId: number, publishedAt: number | null, views: number | null, platform = "youtube"): number {
    const id = this.nextId++;
    this.jobs.push({ id, postId, accountId, platform, publishedAt } as unknown as ScoredJob);
    const s = snap(id, DAY, views as number);
    s.platform = platform as Snapshot["platform"];
    s.reading.views = views;
    this.snaps.set(id, [s]);
    return id;
  }
  score(postIds: number[], now = 1e9) {
    return scoreVideos({ labels: postIds.map((p) => label(p)), snapshotsByJob: this.snaps, jobs: this.jobs, now });
  }
}

test("the baseline is the 30 most recent videos, not the oldest and not all", () => {
  const bed = new Bed();
  // posts 1-5 are the oldest and tiny; posts 6-35 are the recent 30 with views 60..350
  for (let i = 1; i <= 35; i++) bed.add(i, 1, i * 1000, i <= 5 ? 1 : i * 10);
  bed.add(100, 1, 36_000, 200);
  const s = bed.score([100])[0]!;
  // recent 30: 14 values (60..190) below 200, one (post 20) equal -> 14.5 of 30
  assert.ok(Math.abs(s.overall["24h"]! - (100 * 14.5) / 30) < 1e-9, String(s.overall["24h"]));
  assert.equal(s.provisional["24h"], false);
});

test("the baseline skips the video itself, null publishedAt, future publishes and other accounts", () => {
  const bed = new Bed();
  for (let i = 1; i <= 8; i++) bed.add(i, 1, i * 1000, i * 100);
  bed.add(20, 1, null, 1_000_000); // never published
  bed.add(21, 1, 50_000, 1_000_000); // published after now
  bed.add(22, 2, 5000, 1_000_000); // another account
  bed.add(50, 1, 9000, 1000);
  const s = bed.score([50], 10_000)[0]!;
  // baseline is exactly posts 1-8 (100..800): the video beats all 8 -> 100, not provisional
  assert.equal(s.overall["24h"], 100);
  assert.equal(s.provisional["24h"], false);
});

test("null-views snapshots are skipped and make a video without a value provisional", () => {
  const bed = new Bed();
  for (let i = 1; i <= 8; i++) bed.add(i, 1, i * 1000, i === 3 ? null : i * 100);
  bed.add(50, 1, 9000, 1000);
  bed.add(51, 1, 9500, null);
  const [s50, s51] = bed.score([50, 51]);
  // the null baseline entry doesn't count: 7 values -> provisional, still 100
  assert.equal(s50!.overall["24h"], 100);
  assert.equal(s50!.provisional["24h"], true);
  // a video whose only snapshot has no views gets no score at all
  assert.equal(s51!.overall["24h"], undefined);
  assert.deepEqual(s51!.perPlatform, {});
});

test("a platform that hasn't reached the age makes the overall provisional", () => {
  const bed = new Bed();
  for (let i = 1; i <= 10; i++) bed.add(i, 1, i * 1000, i * 100);
  bed.add(50, 1, 20_000, 2000);
  bed.add(50, 2, 20_000, null, "tiktok");
  const s = bed.score([50])[0]!;
  assert.equal(s.overall["24h"], 100);
  assert.equal(s.provisional["24h"], true);
  assert.equal(s.perPlatform.tiktok, undefined);
});

test("overall is the median of per-platform percentiles (even count is the mean of the middle two)", () => {
  const bed = new Bed();
  for (let i = 1; i <= 10; i++) {
    bed.add(i, 1, i * 1000, i * 100); // youtube account 1
    bed.add(100 + i, 2, i * 1000, i * 100, "tiktok"); // tiktok account 2
    bed.add(200 + i, 3, i * 1000, i * 100, "facebook"); // facebook account 3
  }
  bed.add(50, 1, 20_000, 550); // youtube: 5 of 10 below -> 50
  bed.add(50, 2, 20_000, 2000, "tiktok"); // 100
  const two = bed.score([50])[0]!;
  assert.equal(two.perPlatform.youtube!["24h"], 50);
  assert.equal(two.perPlatform.tiktok!["24h"], 100);
  assert.equal(two.overall["24h"], 75);
  bed.add(50, 3, 20_000, 1, "facebook"); // 0
  const three = bed.score([50])[0]!;
  assert.equal(three.perPlatform.facebook!["24h"], 0);
  assert.equal(three.overall["24h"], 50);
});

test("two jobs of one post on one platform average, so perPlatform and overall agree", () => {
  const bed = new Bed();
  for (let i = 1; i <= 10; i++) {
    bed.add(i, 1, i * 1000, i * 100);
    bed.add(100 + i, 2, i * 1000, i * 100);
    bed.add(200 + i, 3, i * 1000, i * 100, "tiktok");
  }
  bed.add(50, 1, 20_000, 550); // youtube a: 50
  bed.add(50, 2, 20_000, 2000); // youtube b: 100
  bed.add(50, 3, 20_000, 1, "tiktok"); // 0
  const s = bed.score([50])[0]!;
  assert.equal(s.perPlatform.youtube!["24h"], 75);
  assert.equal(s.overall["24h"], 37.5); // median of [75, 0], not of [50, 100, 0]
});

test("publishedAt ties are broken by job id, newest id first", () => {
  const bed = new Bed();
  // 31 videos published at the same instant; the cap keeps the 30 highest job ids, dropping the lowest
  for (let i = 1; i <= 31; i++) bed.add(i, 1, 1000, i === 1 ? 1_000_000 : 10 * i);
  bed.add(100, 1, 2000, 5000);
  const s = bed.score([100])[0]!;
  assert.equal(s.overall["24h"], 100);
});

test("identical values give a zero-width interval", () => {
  const scores = [1, 2, 3, 4].map((postId) => ({ postId, perPlatform: {}, provisional: {}, overall: { "24h": 50 } }));
  const r = compareLabels(scores, [1, 2, 3, 4].map((p) => label(p, { styleId: "s" })), "style", "24h");
  assert.equal(r[0]!.lo, 50);
  assert.equal(r[0]!.hi, 50);
  assert.equal(r[0]!.median, 50);
});

test("compareLabels groups by look and producer", () => {
  const scores = [1, 2, 3, 4, 5].map((postId) => ({ postId, perPlatform: {}, provisional: {}, overall: { "24h": postId * 10 } }));
  const labels = [
    label(3, { look: "lemo:ukiyo-e", producer: "lemo-opuscar" }), label(4, { look: "lemo:ukiyo-e", producer: "lemo-opuscar" }),
    label(5, { look: "lemo:ukiyo-e", producer: "lemo-opuscar" }), label(2, { look: "lemo:watercolor-brush", producer: "lemo-opuscar" }),
    label(1, { look: null, producer: null }),
  ];
  const byLook = compareLabels(scores, labels, "look", "24h");
  assert.deepEqual(byLook.map((r) => r.key), ["lemo:ukiyo-e", "lemo:watercolor-brush"]);
  assert.equal(byLook[0]!.n, 3);
  assert.equal(byLook[0]!.enough, true);
  assert.deepEqual(compareLabels(scores, labels, "producer", "24h").map((r) => r.key), ["lemo-opuscar"]);
});
