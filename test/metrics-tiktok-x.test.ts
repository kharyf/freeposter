import "./isolated-home.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Gone, NeedsPermission, PlanLimited, StillProcessing, type MetricsContext } from "../src/platforms/base.ts";
import { tiktokPublisher } from "../src/platforms/tiktok.ts";
import { x } from "../src/platforms/x.ts";
import { account, json, mockFetch } from "./helpers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/metrics/${name}.json`, import.meta.url), "utf8"));
const NOW = Date.now();
const TT_ID = "7300000000000000001";
const TWEET = "1850000000000000001";
const TT_URL = `https://www.tiktok.com/@u/video/${TT_ID}`;

const job = (platform: "tiktok" | "x", resultUrl: string | null, progress = {}) => ({
  id: 7, postId: 1, accountId: 1, platform, state: "published" as const, attempts: 1, nextRunAt: 0,
  progress, resultUrl, error: null, uploadedSha256: null, updatedAt: 0,
});
const tt = (resultUrl: string | null): MetricsContext => ({
  account: { id: 1, ...account("tiktok") }, job: job("tiktok", resultUrl), progress: {}, publishedAt: NOW,
});
const xc = (publishedAt = NOW): MetricsContext => ({
  account: { id: 1, ...account("x") }, job: job("x", `https://x.com/u/status/${TWEET}`, { tweetId: TWEET }),
  progress: { tweetId: TWEET }, publishedAt,
});

test("tiktok metrics map the video query and drive views from view_count", async () => {
  const m = mockFetch(() => json(fixture("tiktok-video-query")));
  try {
    const r = await tiktokPublisher.metrics!(tt(TT_URL));
    assert.equal(r.views, 4521);
    assert.equal(r.viewsKind, "views");
    assert.deepEqual(r.raw, { view_count: 4521, like_count: 310, comment_count: 42, share_count: 17 });
    const u = new URL(m.calls[0].url);
    assert.equal(`${u.origin}${u.pathname}`, "https://open.tiktokapis.com/v2/video/query/");
    assert.equal(u.searchParams.get("fields"), "id,view_count,like_count,comment_count,share_count");
    assert.equal(m.calls[0].method, "POST");
    assert.deepEqual(JSON.parse(m.calls[0].body as string), { filters: { video_ids: [TT_ID] } });
    assert.equal(m.calls[0].headers.authorization, "Bearer access-1");
  } finally {
    m.restore();
  }
});

test("tiktok without a post id yet is StillProcessing and makes no request", async () => {
  const m = mockFetch(() => json({}));
  try {
    await assert.rejects(tiktokPublisher.metrics!(tt("https://www.tiktok.com/@u")), StillProcessing);
    await assert.rejects(tiktokPublisher.metrics!(tt(null)), StillProcessing);
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("tiktok empty videos → Gone, scope_not_authorized → NeedsPermission", async () => {
  let m = mockFetch(() => json(fixture("tiktok-video-query-empty")));
  try {
    await assert.rejects(tiktokPublisher.metrics!(tt(TT_URL)), Gone);
  } finally {
    m.restore();
  }
  for (const status of [401, 200]) {
    m = mockFetch(() => json(fixture("tiktok-scope-not-authorized"), status));
    try {
      await assert.rejects(tiktokPublisher.metrics!(tt(TT_URL)), NeedsPermission);
    } finally {
      m.restore();
    }
  }
});

test("tiktok asks for video.list", () => {
  assert.deepEqual(tiktokPublisher.analyticsScopes, ["video.list"]);
  assert.match(new URL(tiktokPublisher.authorizeUrl("s", "v")).searchParams.get("scope")!, /(^|,)video\.list(,|$)/);
});

test("x uses the video view count when the media carries one", async () => {
  const m = mockFetch(() => json(fixture("x-tweet-video")));
  try {
    const r = await x.metrics!(xc());
    assert.equal(r.views, 6500);
    assert.equal(r.viewsKind, "views");
    assert.equal(r.raw.view_count, 6500);
    assert.equal(r.raw.impression_count, 9100);
    assert.equal(r.raw.like_count, 40);
    assert.equal(r.raw.url_link_clicks, 4);
    const u = new URL(m.calls[0].url);
    assert.equal(`${u.origin}${u.pathname}`, `https://api.x.com/2/tweets/${TWEET}`);
    assert.equal(u.searchParams.get("tweet.fields"), "public_metrics,non_public_metrics");
    assert.equal(u.searchParams.get("expansions"), "attachments.media_keys");
    assert.equal(u.searchParams.get("media.fields"), "public_metrics");
    assert.equal(m.calls[0].headers.authorization, "Bearer access-1");
  } finally {
    m.restore();
  }
});

test("x falls back to impression_count with viewsKind impressions", async () => {
  const m = mockFetch(() => json(fixture("x-tweet-impressions")));
  try {
    const r = await x.metrics!(xc());
    assert.equal(r.views, 9100);
    assert.equal(r.viewsKind, "impressions");
    assert.equal(r.raw.impression_count, 9100);
    assert.equal(r.raw.bookmark_count, 5);
  } finally {
    m.restore();
  }
});

test("x drops non_public_metrics once the post is over 30 days old", async () => {
  const m = mockFetch(() => json(fixture("x-tweet-public-only")));
  try {
    const r = await x.metrics!(xc(NOW - 31 * 86_400_000));
    assert.equal(new URL(m.calls[0].url).searchParams.get("tweet.fields"), "public_metrics");
    assert.equal(r.views, 9000);
  } finally {
    m.restore();
  }
});

test("x retries once without non_public_metrics when they are not authorized", async () => {
  const m = mockFetch((url) =>
    new URL(url).searchParams.get("tweet.fields")!.includes("non_public") ? json(fixture("x-not-authorized"), 403) : json(fixture("x-tweet-public-only")),
  );
  try {
    const r = await x.metrics!(xc());
    assert.equal(m.calls.length, 2);
    assert.equal(new URL(m.calls[1].url).searchParams.get("tweet.fields"), "public_metrics");
    assert.equal(r.views, 9000);
    assert.equal(r.viewsKind, "impressions");
  } finally {
    m.restore();
  }
});

test("x 429 and UsageCapExceeded → PlanLimited", async () => {
  for (const [body, status] of [[{ title: "Too Many Requests", status: 429 }, 429], [fixture("x-usage-cap"), 403], [fixture("x-usage-cap"), 200]] as const) {
    const m = mockFetch(() => json(body, status));
    try {
      await assert.rejects(x.metrics!(xc()), PlanLimited);
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  }
});

test("x 404 and resource-not-found → Gone", async () => {
  for (const [body, status] of [[{ title: "Not Found" }, 404], [fixture("x-not-found"), 200], [fixture("x-not-found"), 400]] as const) {
    const m = mockFetch(() => json(body, status));
    try {
      await assert.rejects(x.metrics!(xc()), Gone);
    } finally {
      m.restore();
    }
  }
});

test("x analytics scope is tweet.read", () => {
  assert.deepEqual(x.analyticsScopes, ["tweet.read"]);
});
