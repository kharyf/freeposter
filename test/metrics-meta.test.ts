import "./isolated-home.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Gone, NeedsPermission, type MetricsContext } from "../src/platforms/base.ts";
import { facebook } from "../src/platforms/facebook.ts";
import { instagram } from "../src/platforms/instagram.ts";
import { account, json, mockFetch } from "./helpers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/metrics/${name}.json`, import.meta.url), "utf8"));

const ctxFor = (platform: "instagram" | "facebook", progress: Record<string, any>): MetricsContext => ({
  account: { id: 1, ...account(platform) },
  job: {
    id: 7, postId: 1, accountId: 1, platform, state: "published", attempts: 1, nextRunAt: 0,
    progress, resultUrl: "https://example.com/x", error: null, uploadedSha256: null, updatedAt: 0,
  },
  progress,
  publishedAt: Date.UTC(2026, 10, 10, 15),
});
const ig = ctxFor("instagram", { mediaId: "media1" });
const fb = ctxFor("facebook", { videoId: "vid1" });

test("instagram metrics map insights and keep views in raw", async () => {
  const m = mockFetch(() => json(fixture("instagram-insights")));
  try {
    const r = await instagram.metrics!(ig);
    assert.equal(r.views, 1500);
    assert.equal(r.viewsKind, "views");
    assert.equal(r.retention, null);
    assert.equal(r.raw.views, 1500);
    assert.equal(r.raw.reach, 800);
    assert.equal(r.raw.saved, 20);
    assert.equal(r.raw.ig_reels_avg_watch_time, 4210.5);
    const u = new URL(m.calls[0].url);
    assert.match(u.pathname, /\/media1\/insights$/);
    assert.equal(u.searchParams.get("metric"), "reach,views,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time");
    assert.equal(m.calls[0].headers.authorization, "OAuth access-1");
  } finally {
    m.restore();
  }
});

test("facebook metrics map video insights to views", async () => {
  const m = mockFetch(() => json(fixture("facebook-insights")));
  try {
    const r = await facebook.metrics!(fb);
    assert.equal(r.views, 2300);
    assert.equal(r.viewsKind, "views");
    assert.equal(r.retention, null);
    assert.equal(r.raw.total_video_views, 2300);
    assert.equal(r.raw.total_video_avg_time_watched, 5100);
    assert.equal(r.raw.total_video_impressions_unique, 1900);
    assert.equal(r.raw.reactions, 52);
    assert.equal(r.raw.shares, 6);
    assert.equal(r.raw.comments, 9);
    assert.match(new URL(m.calls[0].url).pathname, /\/vid1\/video_insights$/);
  } finally {
    m.restore();
  }
});

test("facebook falls back to total_video_plays for views", async () => {
  const m = mockFetch(() => json(fixture("facebook-insights-plays")));
  try {
    const r = await facebook.metrics!(fb);
    assert.equal(r.views, 640);
    assert.equal(r.raw.total_video_plays, 640);
  } finally {
    m.restore();
  }
});

for (const [name, p, ctx] of [["instagram", instagram, ig], ["facebook", facebook, fb]] as const) {
  test(`${name} graph code 10 or 200 → NeedsPermission`, async () => {
    for (const f of ["meta-permission-10", "meta-permission-200"]) {
      const m = mockFetch(() => json(fixture(f), 400));
      try {
        await assert.rejects(p.metrics!(ctx), NeedsPermission);
      } finally {
        m.restore();
      }
    }
  });

  test(`${name} object that does not exist → Gone`, async () => {
    const m = mockFetch(() => json(fixture("meta-gone"), 400));
    try {
      await assert.rejects(p.metrics!(ctx), Gone);
    } finally {
      m.restore();
    }
  });

  test(`${name} without a published id → Gone`, async () => {
    await assert.rejects(p.metrics!(ctxFor(name, {})), Gone);
  });
}

test("analytics scopes are declared and requested at sign-in", () => {
  assert.deepEqual(instagram.analyticsScopes, ["instagram_manage_insights"]);
  assert.deepEqual(facebook.analyticsScopes, ["read_insights"]);
  assert.match(decodeURIComponent(instagram.authorizeUrl("s", "v")), /instagram_manage_insights/);
  assert.match(decodeURIComponent(facebook.authorizeUrl("s", "v")), /read_insights/);
});
