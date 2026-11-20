import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { publishers } from "../src/platforms/index.ts";
import { config } from "../src/config.ts";
import { account, newStore, tmp } from "./helpers.ts";

const DAY = 86_400_000;

function setup() {
  const store = newStore();
  const analytics = new AnalyticsStore(store);
  const cs = new CampaignStore(store);
  const hook = cs.addEntry({ kind: "hook", name: "Stop Scrolling", text: "Stop scrolling if" });
  const angle = cs.addEntry({ kind: "angle", name: "Myth", text: "Myth-bust" });
  const cta = cs.addEntry({ kind: "cta", name: "Guide", text: "Get the guide", url: "https://example.com/g" });
  const type = cs.addType({ name: "Promo", color: "#ff0000" });
  const tt = store.upsertAccount(account("tiktok", { externalId: "tt-1", name: "@tt" }));
  const ig = store.upsertAccount(account("instagram", { externalId: "ig-1", name: "@ig" }));
  const posts: number[] = [];
  const published = Date.now() - 10 * DAY;
  for (let i = 0; i < 4; i++) {
    const postId = store.createPost({ caption: "", title: `Video ${i}`, sourcePath: "x.mp4", sha256: `sha-${i}`, tiktok: null }, [tt.id, ig.id]);
    posts.push(postId);
    for (const job of store.jobsForPost(postId)) {
      store.finishJob(job.id, "published", { resultUrl: "https://example.com/v" });
      store.db.prepare("UPDATE jobs SET published_at = ? WHERE id = ?").run(published + i * 1000, job.id);
      // only TikTok has data
      if (job.accountId === tt.id) {
        for (const [ageSec, views] of [[86_400, 100 * (i + 1)], [259_200, 300 * (i + 1)], [604_800, 500 * (i + 1)]] as const) {
          analytics.addSnapshot({ jobId: job.id, platform: "tiktok", externalId: "e", takenAt: published + ageSec * 1000, ageSec, reading: { views, viewsKind: "views", raw: { likes: 5 }, retention: ageSec === 86_400 ? [1, 0.5] : null } });
        }
      }
    }
    analytics.setLabels({ postId, source: i % 2 ? "generated" : "recorded", styleId: "basic", hookId: hook, hookText: null, angleId: angle, angleText: null,
      ctaId: cta, ctaText: null, campaignId: i === 0 ? 7 : null, campaignTaskId: null, types: [type], labelledBy: "transcript" });
  }
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  return { store, analytics, app, posts, hook, angle, cta, type, tt, ig };
}

test("GET /api/analytics returns videos, comparisons, permission notes and AI use", async () => {
  const { app, posts, hook, tt, store, analytics } = setup();
  // a poll that needs permission surfaces its account
  const job = store.jobsForPost(posts[0]).find((j) => j.accountId === tt.id)!;
  analytics.schedulePoll(job.id, Date.now());
  analytics.deferPoll(job.id, "needs permission", Date.now() + 1000);

  const res = await app.inject("/api/analytics");
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.videos.length, 4);
  const v = body.videos.find((x: any) => x.postId === posts[0]);
  assert.equal(v.title, "Video 0");
  assert.equal(v.source, "recorded");
  assert.equal(v.styleId, "basic");
  assert.deepEqual(v.hook, { id: hook, text: "Stop scrolling if", name: "Stop Scrolling" });
  assert.equal(v.campaignId, 7);
  assert.equal(v.types.length, 1);
  assert.ok(typeof v.publishedAt === "number");
  assert.ok("overall" in v.scores && "perPlatform" in v.scores && "provisional" in v.scores);
  assert.deepEqual(v.platforms.map((p: any) => [p.platform, p.hasData]).sort(), [["instagram", false], ["tiktok", true]]);
  for (const dim of ["hook", "angle", "cta", "style", "type", "source"]) assert.ok(Array.isArray(body.compare[dim]), dim);
  assert.equal(body.compare.hook[0].name, "Stop Scrolling");
  assert.deepEqual(body.needsPermission, [{ accountId: tt.id, name: "@tt", platform: "tiktok" }]);
  assert.ok(body.ai.budgeted && body.ai.all);
  assert.deepEqual(body.ai.max, { calls: 50, tokens: 200_000 }, "the ceiling the tab shows today's use against");
});

test("GET /api/analytics filters and validates", async () => {
  const { app, posts, ig } = setup();
  assert.equal((await app.inject("/api/analytics?source=generated")).json().videos.length, 2);
  assert.deepEqual((await app.inject("/api/analytics?campaign=7")).json().videos.map((x: any) => x.postId), [posts[0]]);
  assert.equal((await app.inject(`/api/analytics?account=${ig.id}`)).json().videos.length, 4);
  assert.equal((await app.inject("/api/analytics?account=999")).json().videos.length, 0);
  assert.equal((await app.inject("/api/analytics?days=3")).json().videos.length, 0);
  assert.equal((await app.inject("/api/analytics?days=30&age=7d")).statusCode, 200);

  for (const q of ["source=nope", "days=0", "days=abc", "age=1h", "account=x", "campaign=-1"]) {
    const res = await app.inject(`/api/analytics?${q}`);
    assert.equal(res.statusCode, 400, q);
    assert.ok(res.json().error, q);
  }
});

test("GET /api/analytics/videos/:postId gives labels, snapshots, retention and scores", async () => {
  const { app, posts } = setup();
  const res = await app.inject(`/api/analytics/videos/${posts[1]}`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.postId, posts[1]);
  assert.equal(body.labels.source, "generated");
  const tiktok = body.platforms.find((p: any) => p.platform === "tiktok");
  assert.deepEqual(tiktok.snapshots.map((s: any) => s.ageSec), [86_400, 259_200, 604_800]);
  assert.equal(tiktok.snapshots[0].views, 200);
  assert.equal(tiktok.snapshots[0].viewsKind, "views");
  assert.deepEqual(tiktok.snapshots[0].raw, { likes: 5 });
  assert.deepEqual(tiktok.retention, [1, 0.5]);
  assert.equal(body.platforms.find((p: any) => p.platform === "instagram").snapshots.length, 0);
  assert.ok("overall" in body.scores);

  assert.equal((await app.inject("/api/analytics/videos/9999")).statusCode, 404);
  assert.equal((await app.inject("/api/analytics/videos/abc")).statusCode, 400);
});

test("PUT /api/analytics/labels/:postId saves the user's edits and validates ids", async () => {
  const { app, posts, analytics, angle, cta, type, hook, store, tt } = setup();
  const put = (id: number, body: unknown) => app.inject({ method: "PUT", url: `/api/analytics/labels/${id}`, headers: { host: `localhost:${config.port}` }, payload: body as object });

  let res = await put(posts[0], { angleId: null, angleText: "Custom angle", styleId: "fancy", types: [], hookText: "typed hook", hookId: null });
  assert.equal(res.statusCode, 200, res.body);
  const l = analytics.labels(posts[0])!;
  assert.equal(l.labelledBy, "user");
  assert.equal(l.angleId, null);
  assert.equal(l.angleText, "Custom angle");
  assert.equal(l.hookId, null);
  assert.equal(l.hookText, "typed hook");
  assert.equal(l.styleId, "fancy");
  assert.deepEqual(l.types, []);
  assert.equal(l.ctaId, cta); // untouched
  assert.equal(l.campaignId, 7);
  assert.equal(res.json().labels.labelledBy, "user");

  res = await put(posts[0], { angleId: angle, types: [type] });
  assert.equal(res.statusCode, 200);
  assert.equal(analytics.labels(posts[0])!.angleId, angle);
  assert.equal(analytics.labels(posts[0])!.angleText, null);

  for (const bad of [{ hookId: 9999 }, { hookId: angle }, { styleId: "nope" }, { types: [9999] }, { source: "x" }, { ctaId: "a" }]) {
    res = await put(posts[0], bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.ok(res.json().error);
  }
  assert.equal((await put(9999, { styleId: "basic" })).statusCode, 404);

  // an id wins over text sent with it
  res = await put(posts[0], { hookId: hook, hookText: "ignored" });
  assert.equal(res.statusCode, 200);
  assert.equal(analytics.labels(posts[0])!.hookText, null);

  // a post with no labels yet needs its source
  const fresh = store.createPost({ caption: "", title: "New", sourcePath: "x.mp4", sha256: "sha-new", tiktok: null }, [tt.id]);
  assert.equal((await put(fresh, { styleId: "basic" })).statusCode, 400);
  assert.equal((await put(fresh, { styleId: "basic", source: "recorded" })).statusCode, 200);

  // another website can't relabel
  res = await app.inject({ method: "PUT", url: `/api/analytics/labels/${posts[0]}`, headers: { host: `localhost:${config.port}`, origin: "https://evil.example" }, payload: { styleId: "basic" } });
  assert.equal(res.statusCode, 403);
});

test("analytics compare accepts look and producer", async () => {
  const { app } = setup();
  const res = await app.inject("/api/analytics");
  assert.equal(res.statusCode, 200, res.body);
  for (const dim of ["look", "producer"]) assert.ok(Array.isArray(res.json().compare[dim]), dim);
});
