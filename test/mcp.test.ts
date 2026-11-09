import "./isolated-home.ts"; // first: keeps uploads out of the real data/ folder
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { config } from "../src/config.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
import { ReviewService } from "../src/review/service.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, json, mockFetch, newStore, tmp, verticalSilent } from "./helpers.ts";

const HOST = { host: `localhost:${config.port}` };

function setup() {
  const dir = tmp();
  const store = newStore();
  const published: string[] = [];
  const fakeX: Publisher = {
    ...real.x,
    async publish(ctx) {
      published.push(ctx.post.caption);
      return { url: "https://x.com/xuser/status/42" };
    },
  };
  const publishers = { ...real, x: fakeX } as Record<Platform, Publisher>;
  const runner = new Runner(store, publishers, dir);
  const reviews = new ReviewService(store, { publishers, runner, dir: tmp() });
  const app = buildServer(store, runner, publishers, {}, undefined, undefined, undefined, { service: reviews });
  let id = 0;
  /** One JSON-RPC request to /mcp. */
  const rpc = async (method: string, params?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...HOST, ...headers }, payload: { jsonrpc: "2.0", id: ++id, method, params } });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).body.result;
  /** Runs the review's preparation (the exact file, the checks) to the end. */
  const prepared = async (id: number) => {
    await reviews.tick();
    return reviews.reviews.get(id)!;
  };
  /** The user's Approve button in the window. */
  const approve = async (id: number) => (await app.inject({ method: "POST", url: `/api/reviews/${id}/approve`, headers: HOST })).json();
  return { dir, store, app, rpc, call, published, reviews, prepared, approve };
}

test("MCP handshake and tool list", async () => {
  const { app, rpc } = setup();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "freeposter");
  assert.ok(init.body.result.capabilities.tools);
  // an unknown version gets the newest
  assert.equal((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-11-25");

  const note = await app.inject({ method: "POST", url: "/mcp", headers: HOST, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(note.statusCode, 202);

  const names = (await rpc("tools/list")).body.result.tools.map((t: any) => t.name);
  assert.deepEqual(names.sort(), ["audit_reviews", "cancel_post", "cancel_production", "create_edit", "describe_production_tools", "get_edit", "get_post", "get_production", "get_review", "get_tiktok_creator_info", "list_accounts", "list_posts", "publish_video", "request_review", "reschedule_post", "retry_job", "revise_edit", "revise_production", "start_production"]);
  // Agents have no way to approve: only the user does, on a review (review.test.ts).
  assert.ok(!names.some((n: string) => /approve|decide|accept/.test(n)), "no approve tool");
  assert.equal((await rpc("nope")).body.error.code, -32601);
  assert.equal((await rpc("tools/call", { name: "nope" })).body.error.code, -32602);
  assert.equal((await app.inject({ method: "GET", url: "/mcp", headers: HOST })).statusCode, 405);
  await app.close();
});

test("MCP refuses other websites and rebound hosts", async () => {
  const { app, rpc } = setup();
  assert.equal((await rpc("ping", undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await rpc("ping", undefined, { host: "evil.example:4400" })).status, 403);
  assert.equal((await rpc("ping", undefined, { origin: `http://localhost:${config.port}` })).status, 200);
  assert.equal((await rpc("ping", undefined, { "mcp-protocol-version": "2020-01-01" })).status, 400);
  await app.close();
});

test("an agent asks to publish; nothing posts until the user approves, and then exactly the approved file goes", async () => {
  const { dir, store, app, call, published, prepared, approve } = setup();
  const x = store.upsertAccount(account("x"));
  const video = verticalSilent(dir);

  const listed = await call("list_accounts");
  assert.deepEqual(listed.structuredContent.accounts.map((a: any) => [a.id, a.platform]), [[x.id, "x"]]);
  assert.ok(!JSON.stringify(listed).includes("access-1"), "tokens never reach the agent");

  // problems come back as tool errors the model can read
  let r = await call("publish_video", { video_path: video, account_ids: [x.id], caption: "a".repeat(300) });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /X .*280/);
  assert.equal((await call("publish_video", { video_path: "relative.mp4", account_ids: [x.id] })).isError, true);
  assert.equal((await call("publish_video", { video_path: `${dir}/missing.mp4`, account_ids: [x.id] })).isError, true);

  r = await call("publish_video", { video_path: video, account_ids: [x.id], caption: "ship it", dry_run: true });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.structuredContent.dryRun, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM reviews").get()!.n, 0, "a dry run asks for nothing");

  r = await call("publish_video", { video_path: video, account_ids: [x.id], caption: "ship it" });
  assert.equal(r.isError, undefined, r.content[0].text);
  const reviewId = r.structuredContent.id;
  assert.equal(r.structuredContent.state, "preparing");
  assert.match(r.structuredContent.next, /don't ask them to say yes/i);
  const review = await prepared(reviewId);
  assert.equal(review.state, "pending", review.error ?? "");
  assert.equal((await call("list_posts")).structuredContent.posts.length, 0, "asking posts nothing");
  assert.equal(store.pendingJobCount(), 0);

  const decided = await approve(reviewId);
  assert.equal(decided.ok, true, decided.error);
  const postId = decided.review.post_id;
  for (let i = 0; i < 100 && store.jobsForPost(postId)[0].state !== "published"; i++) await new Promise((res) => setTimeout(res, 100));
  const got = (await call("get_post", { post_id: postId })).structuredContent;
  assert.equal(got.jobs[0].state, "published");
  assert.equal(got.jobs[0].url, "https://x.com/xuser/status/42");
  assert.deepEqual(published, ["ship it"]);
  assert.equal(store.jobsForPost(postId)[0].uploadedSha256, review.masterSha256, "the upload is the approved file");
  assert.equal(existsSync(video), true, "the user's own file is left alone");
  assert.equal((await call("audit_reviews")).structuredContent.ok, true);

  // The same file again: refused when the exact file is made (its hash is the one posted).
  r = await call("publish_video", { video_path: video, account_ids: [x.id], caption: "again" });
  const again = await prepared(r.structuredContent.id);
  assert.equal(again.state, "failed");
  assert.match(again.error!, /already published.*allow_duplicate/s);
  assert.equal((await call("list_posts")).structuredContent.posts.length, 1);
  await app.close();
});

test("an agent asks for a scheduled post; once approved it can be moved and cancelled", async () => {
  const { dir, store, app, call, prepared, approve } = setup();
  const x = store.upsertAccount(account("x"));
  const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
  let r = await call("publish_video", { video_path: verticalSilent(dir), account_ids: [x.id], caption: "later", schedule_at: at });
  assert.equal(r.structuredContent.schedule_at, at);
  // A scheduled post's review ends when it was due.
  assert.equal(r.structuredContent.expires_at, at);
  await prepared(r.structuredContent.id);
  const postId = (await approve(r.structuredContent.id)).review.post_id;
  assert.equal((await call("get_post", { post_id: postId })).structuredContent.scheduledAt, at);

  assert.equal((await call("reschedule_post", { post_id: postId, schedule_at: "2001-01-01T00:00:00Z" })).isError, true);
  const later = new Date(Date.now() + 5 * 3_600_000).toISOString();
  r = await call("reschedule_post", { post_id: postId, schedule_at: later });
  assert.equal(r.structuredContent.scheduledAt, later);

  r = await call("cancel_post", { post_id: postId });
  assert.equal(r.structuredContent.cancelled, 1);
  assert.equal(store.post(postId), undefined);
  assert.equal((await call("get_post", { post_id: postId })).isError, true);
  await app.close();
});

test("TikTok posts need a privacy level the account offers", async () => {
  const { dir, store, app, call } = setup();
  const tt = store.upsertAccount(account("tiktok"));
  const fetch = mockFetch((url) => {
    assert.match(url, /creator_info/);
    return json({ data: { creator_nickname: "tt", creator_username: "tt", privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 }, error: { code: "ok" } });
  });
  try {
    const info = (await call("get_tiktok_creator_info", { account_id: tt.id })).structuredContent;
    assert.deepEqual(info.privacy_level_options, ["SELF_ONLY", "PUBLIC_TO_EVERYONE"]);
    const video = verticalSilent(dir);
    let r = await call("publish_video", { video_path: video, account_ids: [tt.id], caption: "hi", dry_run: true });
    assert.match(r.content[0].text, /privacy_level/);
    r = await call("publish_video", { video_path: video, account_ids: [tt.id], caption: "hi", dry_run: true, tiktok: { privacy_level: "FRIENDS" } });
    assert.match(r.content[0].text, /SELF_ONLY, PUBLIC_TO_EVERYONE/);
    r = await call("publish_video", { video_path: video, account_ids: [tt.id], caption: "hi", dry_run: true, tiktok: { privacy_level: "SELF_ONLY" } });
    assert.equal(r.isError, undefined, r.content[0].text);
  } finally {
    fetch.restore();
  }
  await app.close();
});

test("an agent makes an edit but can't publish it until the user approves its review", async () => {
  const { dir, store, call, published, prepared, approve } = setup();
  const xAcct = store.upsertAccount(account("x"));
  const video = verticalSilent(dir);
  const made = await call("create_edit", { video_path: video, settings: { punchIn: false } });
  assert.ok(!made.isError, made.content?.[0]?.text);
  const editId = made.structuredContent.id;
  assert.equal(made.structuredContent.state, "queued");
  assert.match(made.structuredContent.next, /request_review/);

  // not ready yet: nothing to review
  assert.match((await call("request_review", { edit_id: editId, account_ids: [xAcct.id], caption: "edited" })).content[0].text, /only a ready edit/);

  // the worker finished it (stand-in): ready but not approved
  store.updateEdit(editId, { state: "ready", outputPath: video, durationSec: 4, progress: 1 });
  const got = await call("get_edit", { edit_id: editId });
  assert.equal(got.structuredContent.state, "ready");
  assert.equal(got.structuredContent.preview_path, video);

  // publish_video with the edit asks for a review; it doesn't post, and the agent's call doesn't approve the edit.
  const asked = await call("publish_video", { account_ids: [xAcct.id], caption: "edited", edit_id: editId });
  assert.ok(!asked.isError, asked.content?.[0]?.text);
  assert.equal((await prepared(asked.structuredContent.id)).state, "pending");
  assert.equal(store.edit(editId)!.approvedAt, null);
  assert.equal(store.recentPosts().length, 0);

  const ok = await approve(asked.structuredContent.id);
  const post = store.post(ok.review.post_id)!;
  assert.equal(post.origin, "review");
  assert.equal(post.editId, null, "it posts the approved file, not the edit's current output");
  assert.ok(store.edit(editId)!.approvedAt, "approving the review approves the edit");
  assert.deepEqual(published, []); // queued; the runner sends it
});

test("revise_edit replaces an edit after a redo; the old one can't be reviewed or revised again", async () => {
  const { dir, store, call } = setup();
  const x = store.upsertAccount(account("x"));
  const video = verticalSilent(dir);
  const editId = (await call("create_edit", { video_path: video })).structuredContent.id;
  store.updateEdit(editId, { state: "ready", outputPath: video, durationSec: 4, progress: 1 });

  const same = await call("revise_edit", { edit_id: editId, settings: { punchIn: true } });
  assert.match(same.content[0].text, /settings already/);
  const bad = await call("revise_edit", { edit_id: editId, settings: { drop: [{ start: 5, end: 2 }] } });
  assert.equal(bad.isError, true);

  const revised = (await call("revise_edit", { edit_id: editId, settings: { punchIn: false, drop: [{ start: 1, end: 1.5 }] } })).structuredContent;
  assert.equal(revised.parent_edit_id, editId);
  assert.equal(revised.state, "queued");
  assert.deepEqual(revised.settings.drop, [{ start: 1, end: 1.5 }]);
  assert.equal(revised.settings.captions, true, "settings not given stay as they were");
  assert.equal(store.edit(editId)!.state, "superseded");
  assert.match((await call("request_review", { edit_id: editId, account_ids: [x.id], caption: "old" })).content[0].text, /superseded/);
  assert.match((await call("revise_edit", { edit_id: editId, settings: { audio: false } })).content[0].text, /superseded/);
});
