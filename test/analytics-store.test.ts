import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalyticsStore } from "../src/analytics/store.ts";
import type { MetricReading, VideoLabels } from "../src/analytics/types.ts";
import { newStore } from "./helpers.ts";

const reading = (views: number | null): MetricReading => ({ views, viewsKind: "views", raw: { likes: 3 }, retention: null });
const snap = (jobId: number, ageSec: number, views = 10) => ({ jobId, platform: "youtube" as const, externalId: "abc", takenAt: 1000 + ageSec, ageSec, reading: reading(views) });

test("snapshots are append-only and ordered by age", () => {
  const a = new AnalyticsStore(newStore());
  a.addSnapshot(snap(1, 86_400));
  a.addSnapshot(snap(1, 3_600));
  a.addSnapshot({ ...snap(1, 21_600), reading: { views: 5, viewsKind: "impressions", raw: {}, retention: [1, 0.5] } });
  a.addSnapshot(snap(2, 3_600));
  const s = a.snapshots(1);
  assert.deepEqual(s.map((x) => x.ageSec), [3_600, 21_600, 86_400]);
  assert.deepEqual(s[1].reading, { views: 5, viewsKind: "impressions", raw: {}, retention: [1, 0.5] });
  assert.equal(a.snapshots(2).length, 1);
});

test("duePolls returns only polls whose next time has passed and are not done", () => {
  const a = new AnalyticsStore(newStore());
  a.schedulePoll(1, 100);
  a.schedulePoll(2, 500);
  a.schedulePoll(3, 50);
  a.finishPoll(3, null);
  assert.deepEqual(a.duePolls(200, 10), [{ jobId: 1, attempts: 0 }]);
  a.notePollError(1, "boom", 900);
  assert.deepEqual(a.duePolls(200, 10), []);
  assert.deepEqual(a.duePolls(1000, 10).map((p) => [p.jobId, p.attempts]), [[2, 0], [1, 1]]);
  assert.equal(a.pollFor(1)?.lastError, "boom");
  a.schedulePoll(3, 0);
  assert.equal(a.pollFor(3)?.done, true, "a finished poll stays finished");
  assert.equal(a.duePolls(1000, 1).length, 1, "limit applies");
});

test("labels round-trip and setLabels replaces", () => {
  const a = new AnalyticsStore(newStore());
  const l: VideoLabels = { postId: 7, source: "generated", styleId: "s", hookId: 1, hookText: "h", angleId: null, angleText: null, ctaId: 2, ctaText: "c", campaignId: 3, campaignTaskId: 4, types: [1, 2], labelledBy: "campaign", lengthSec: 30, producer: null, look: null, lookVersion: null };
  a.setLabels(l);
  assert.deepEqual(a.labels(7), l);
  a.setLabels({ ...l, hookText: "fixed", labelledBy: "user", lengthSec: undefined });
  assert.equal(a.labels(7)?.hookText, "fixed");
  assert.equal(a.labels(7)?.lengthSec, 30, "a relabel that says no length keeps the campaign's");
  assert.equal(a.allLabels().length, 1);
  assert.equal(a.labels(8), undefined);
});

test("labels keep producer, look and look version", () => {
  const a = new AnalyticsStore(newStore());
  const base: VideoLabels = { postId: 11, source: "generated", styleId: null, hookId: null, hookText: null, angleId: null, angleText: null, ctaId: null, ctaText: null, campaignId: null, campaignTaskId: null, types: [], labelledBy: "campaign" };
  a.setLabels({ ...base, producer: "lemo-opuscar", look: "lemo:ukiyo-e", lookVersion: "abc123" });
  const got = a.labels(11)!;
  assert.deepEqual([got.producer, got.look, got.lookVersion], ["lemo-opuscar", "lemo:ukiyo-e", "abc123"]);
  a.setLabels({ ...base, postId: 12 });
  const bare = a.labels(12)!;
  assert.deepEqual([bare.producer, bare.look, bare.lookVersion], [null, null, null]);
});

test("an older video_labels table gains the look columns", () => {
  const s = newStore();
  s.db.exec("DROP TABLE IF EXISTS video_labels");
  s.db.exec(`CREATE TABLE video_labels (post_id INTEGER PRIMARY KEY, source TEXT NOT NULL, style_id TEXT, hook_id INTEGER, hook_text TEXT,
    angle_id INTEGER, angle_text TEXT, cta_id INTEGER, cta_text TEXT, campaign_id INTEGER, campaign_task_id INTEGER,
    types TEXT NOT NULL DEFAULT '[]', labelled_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  new AnalyticsStore(s);
  const names = (s.db.prepare("PRAGMA table_info(video_labels)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["producer", "look", "look_version"]) assert.ok(names.includes(c), c);
});
