import "./isolated-home.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Gone, NeedsPermission, type MetricsContext } from "../src/platforms/base.ts";
import { youtube } from "../src/platforms/youtube.ts";
import { account, json, mockFetch } from "./helpers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/metrics/${name}.json`, import.meta.url), "utf8"));
const PUBLISHED = Date.UTC(2026, 10, 10, 15);

const ctx: MetricsContext = {
  account: { id: 1, ...account("youtube") },
  job: {
    id: 7, postId: 1, accountId: 1, platform: "youtube", state: "published", attempts: 1, nextRunAt: 0,
    progress: { videoId: "vid1" }, resultUrl: "https://www.youtube.com/shorts/vid1", error: null, uploadedSha256: null, updatedAt: 0,
  },
  progress: { videoId: "vid1" },
  publishedAt: PUBLISHED,
};

const isRetention = (url: string) => new URL(url).searchParams.get("dimensions") === "elapsedVideoTimeRatio";

test("youtube metrics map report columns and retention", async () => {
  const m = mockFetch((url) => {
    if (url.startsWith("https://youtubeanalytics.googleapis.com/v2/reports")) {
      return json(isRetention(url) ? fixture("youtube-retention") : fixture("youtube-report"));
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const r = await youtube.metrics!(ctx);
    assert.equal(r.views, 1234);
    assert.equal(r.viewsKind, "views");
    assert.equal(r.raw.averageViewPercentage, 61.2);
    assert.equal(r.raw.likes, 87);
    assert.equal(r.raw.subscribersGained, 5);
    assert.equal(r.raw.views, 1234);
    assert.equal(r.retention!.length, 100);
    // sorted by elapsedVideoTimeRatio even though the recorded rows are out of order
    const sorted = fixture("youtube-retention").rows.sort((a: number[], b: number[]) => a[0] - b[0]).map((row: number[]) => row[1]);
    assert.deepEqual(r.retention, sorted);

    const q = new URL(m.calls[0].url).searchParams;
    assert.equal(q.get("ids"), "channel==MINE");
    assert.equal(q.get("filters"), "video==vid1");
    assert.equal(q.get("startDate"), "2026-11-09");
    assert.equal(q.get("metrics"), "views,likes,comments,shares,subscribersGained,averageViewDuration,averageViewPercentage");
    assert.equal(m.calls[0].headers.authorization, "Bearer access-1");
    assert.equal(new URL(m.calls[1].url).searchParams.get("metrics"), "audienceWatchRatio");
  } finally {
    m.restore();
  }
});

test("youtube 403 insufficientPermissions → NeedsPermission", async () => {
  const m = mockFetch(() => json(fixture("youtube-insufficient-permissions"), 403));
  try {
    await assert.rejects(youtube.metrics!(ctx), NeedsPermission);
  } finally {
    m.restore();
  }
});

test("youtube video not found → Gone", async () => {
  const m = mockFetch((url) => {
    if (url.startsWith("https://youtubeanalytics.googleapis.com/")) return json(fixture("youtube-empty"));
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) return json({ items: [] });
    throw new Error(`unexpected ${url}`);
  });
  try {
    await assert.rejects(youtube.metrics!(ctx), Gone);
  } finally {
    m.restore();
  }
});

test("youtube with no rows yet but the video existing is a reading without views", async () => {
  const m = mockFetch((url) => {
    if (url.startsWith("https://youtubeanalytics.googleapis.com/")) return json(fixture("youtube-empty"));
    return json({ items: [{ id: "vid1" }] });
  });
  try {
    const r = await youtube.metrics!(ctx);
    assert.equal(r.views, null);
    assert.equal(r.retention, null);
  } finally {
    m.restore();
  }
});

test("youtube startDate is a day before the publish date so Pacific-time days are covered", async () => {
  const m = mockFetch(() => json(fixture("youtube-empty")));
  try {
    await youtube.metrics!({ ...ctx, publishedAt: Date.UTC(2026, 10, 10, 3) }).catch(() => {});
    assert.equal(new URL(m.calls[0].url).searchParams.get("startDate"), "2026-11-09");
  } finally {
    m.restore();
  }
});
