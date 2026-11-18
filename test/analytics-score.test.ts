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
