import "./isolated-home.ts"; // first: keeps uploads out of the real data/ folder
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { config } from "../src/config.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
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
  const app = buildServer(store, new Runner(store, publishers, dir), publishers);
  let id = 0;
  /** One JSON-RPC request to /mcp. */
  const rpc = async (method: string, params?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...HOST, ...headers }, payload: { jsonrpc: "2.0", id: ++id, method, params } });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).body.result;
  return { dir, store, app, rpc, call, published };
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
  assert.deepEqual(names.sort(), ["cancel_post", "get_post", "get_tiktok_creator_info", "list_accounts", "list_posts", "publish_video", "reschedule_post", "retry_job"]);
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

test("an agent lists accounts, publishes, follows the post, and is stopped from double posting", async () => {
  const { dir, store, app, call, published } = setup();
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
  assert.equal(store.pendingJobCount(), 0, "a dry run queues nothing");

  r = await call("publish_video", { video_path: video, account_ids: [x.id], caption: "ship it" });
  assert.equal(r.isError, undefined, r.content[0].text);
  const postId = r.structuredContent.id;
  for (let i = 0; i < 100 && store.jobsForPost(postId)[0].state !== "published"; i++) await new Promise((res) => setTimeout(res, 100));
  const got = (await call("get_post", { post_id: postId })).structuredContent;
  assert.equal(got.jobs[0].state, "published");
  assert.equal(got.jobs[0].url, "https://x.com/xuser/status/42");
  assert.deepEqual(published, ["ship it"]);
  assert.equal(existsSync(video), true, "the user's own file is left alone");

  r = await call("publish_video", { video_path: video, account_ids: [x.id], caption: "again" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /already published.*allow_duplicate/s);
  assert.equal((await call("list_posts")).structuredContent.posts.length, 1);
  await app.close();
});

test("an agent schedules, moves and cancels a post", async () => {
  const { dir, store, app, call } = setup();
  const x = store.upsertAccount(account("x"));
  const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
  let r = await call("publish_video", { video_path: verticalSilent(dir), account_ids: [x.id], caption: "later", schedule_at: at });
  assert.equal(r.structuredContent.scheduledAt, at);
  const postId = r.structuredContent.id;

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
