import "./isolated-home.ts"; // first: keeps uploads out of the real data/ folder
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { config } from "../src/config.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
import { queueEvent } from "../src/notify.ts";
import { AnalyticsStore } from "../src/analytics/store.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { CampaignWorker } from "../src/campaigns/worker.ts";
import { ProductionStore } from "../src/produce/store.ts";
import { ReviewService } from "../src/review/service.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, json, mockFetch, newStore, tmp, verticalSilent } from "./helpers.ts";

const HOST = { host: `localhost:${config.port}` };

function setup(opts: { campaigns?: boolean } = {}) {
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
  const ps = new ProductionStore(store);
  const worker = opts.campaigns
    ? new CampaignWorker({ store, reviews, ai: null, productions: { productions: ps, createStaged: async () => { throw new Error("not in this test"); }, borrowGpu: async () => null } })
    : undefined;
  const app = buildServer(store, runner, publishers, {}, undefined, undefined, undefined, { service: reviews }, worker);
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
  return { dir, store, app, rpc, call, published, reviews, prepared, approve, worker };
}

test("MCP handshake and tool list", async () => {
  const { app, rpc } = setup();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "freeposter");
  assert.ok(init.body.result.capabilities.tools);
  assert.ok(init.body.result.capabilities.prompts);
  assert.match(init.body.result.serverInfo.version, /^\d+\.\d+\.\d+/);
  assert.doesNotMatch(init.body.result.instructions, /hermes/i, "the instructions suit any agent");
  // an unknown version gets the newest
  assert.equal((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-11-25");

  const note = await app.inject({ method: "POST", url: "/mcp", headers: HOST, payload: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(note.statusCode, 202);

  const names = (await rpc("tools/list")).body.result.tools.map((t: any) => t.name);
  assert.deepEqual(names.sort(), ["add_editing_style", "add_library_entry", "audit_reviews", "cancel_post", "cancel_production", "claim_brief", "create_edit", "describe_production_tools", "get_analytics", "get_campaign", "get_edit", "get_post", "get_production", "get_review", "get_tiktok_creator_info", "get_video_metrics", "give_up_brief", "list_accounts", "list_briefs", "list_campaigns", "list_editing_styles", "list_events", "list_library", "list_posts", "list_reviews", "publish_video", "renew_brief", "request_review", "reschedule_post", "retry_job", "revise_edit", "revise_production", "start_production", "stop_campaigns", "submit_brief", "sync_looks", "transcribe_media", "update_campaign", "wait_for_events"]);
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

test("prompts: check_freeposter and handle_redo, ready for agents that offer them", async () => {
  const { app, rpc } = setup();
  const list = (await rpc("prompts/list")).body.result.prompts;
  assert.deepEqual(list.map((p: any) => p.name).sort(), ["check_freeposter", "handle_redo"]);
  const check = (await rpc("prompts/get", { name: "check_freeposter" })).body.result;
  assert.match(check.messages[0].content.text, /list_events/);
  const redo = (await rpc("prompts/get", { name: "handle_redo", arguments: { review_id: "7" } })).body.result;
  assert.match(redo.messages[0].content.text, /review_id 7/);
  assert.equal((await rpc("prompts/get", { name: "handle_redo" })).body.error.code, -32602);
  assert.equal((await rpc("prompts/get", { name: "nope" })).body.error.code, -32602);
  await app.close();
});

test("list_events and wait_for_events: any agent follows what happens without a webhook", async () => {
  const { app, call, store } = setup();
  queueEvent(store, "edit.ready", "edit.ready:1", { edit_id: 1 }, "Edit 1 is ready.");
  const first = (await call("list_events")).structuredContent;
  assert.deepEqual(first.events.map((e: any) => [e.event_type, e.edit_id, e.summary]), [["edit.ready", 1, "Edit 1 is ready."]]);
  assert.equal((await call("list_events")).structuredContent.events.length, 0, "read once returned");
  assert.equal((await call("list_events", { since: 0 })).structuredContent.events.length, 1, "since re-reads");
  assert.equal((await call("list_events", { types: ["nope"] })).isError, true);

  // Nothing new: wait_for_events returns as soon as something happens.
  const started = Date.now();
  setTimeout(() => queueEvent(store, "post.done", "post.done:4", { post_id: 4 }, "Post 4 is done."), 50);
  const waited = (await call("wait_for_events", { since: first.next_since, timeout_sec: 10 })).structuredContent;
  assert.deepEqual(waited.events.map((e: any) => e.event_type), ["post.done"]);
  assert.ok(Date.now() - started < 5_000);
  // And with nothing at all, an empty list after the timeout.
  const none = (await call("wait_for_events", { since: waited.next_since, timeout_sec: 0 })).structuredContent;
  assert.deepEqual(none.events, []);
  assert.equal(none.next_since, waited.next_since);
  await app.close();
});

test("list_reviews filters by state; get_review on a redo marks it picked up", async () => {
  const { app, call, store, reviews } = setup();
  assert.deepEqual((await call("list_reviews", { needs_agent: true })).structuredContent.reviews, []);
  assert.equal((await call("list_reviews", { state: "nope" })).isError, true);
  const r = reviews.reviews.create({ subjectKind: "file", subjectId: null, revision: 1, sourcePath: "x.mp4", expiresAt: Date.now() + 3_600_000, requestedVia: "agent",
    draft: { accountIds: [], caption: "c", title: "", scheduledAt: null, tiktok: null, allowDuplicate: false, captionTopic: null } }).review;
  store.db.prepare("UPDATE reviews SET state = 'redo', decided_at = ? WHERE id = ?").run(Date.now(), r.id);
  queueEvent(store, "review.redo", `review.redo:${r.id}`, { review_id: r.id, handled_by: "agent" }, "redo it");
  assert.deepEqual((await call("list_reviews", { needs_agent: true })).structuredContent.reviews.map((x: any) => x.id), [r.id]);
  assert.deepEqual((await call("list_reviews", { state: "redo" })).structuredContent.reviews.map((x: any) => x.id), [r.id]);
  await call("get_review", { review_id: r.id });
  assert.ok(store.eventByKey(`review.redo:${r.id}`)!.readAt);
  assert.deepEqual((await call("list_reviews", { needs_agent: true })).structuredContent.reviews, [], "a file redo an agent read is in its hands");
  await app.close();
});

test("the event guide tells agents campaign videos go to review by themselves", async () => {
  const { EVENT_GUIDE } = await import("../src/mcp.ts");
  assert.match(EVENT_GUIDE, /campaign videos, with campaign_task_id/);
});


/** A confirmed campaign with one make line using its own CTA. */
function campaign(store: ReturnType<typeof newStore>) {
  const cs = new CampaignStore(store);
  const hook = cs.addEntry({ kind: "hook", name: "Stop Scrolling", text: "Stop scrolling" });
  const cta = cs.addEntry({ kind: "cta", name: "Free Guide", text: "Get the guide", url: "https://example.com/guide" });
  const id = cs.create({ name: "Weekday Growth", text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 100 });
  const row = (quantity = 1) => ({
    id: 1, quantity, hook: { pick: "named", id: hook }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, style: "basic",
    type: null, time: null, days: ["tue"], sec: 30, origin: "create", text: "",
  });
  cs.setRows(id, [row() as never]);
  return { cs, id, hook, cta, row };
}

test("Autorun tools: changes need Autorun and a reason, and are made in the MCP client's name", async () => {
  const { app, rpc, call, store } = setup({ campaigns: true });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
  const { cs, id, row } = campaign(store);
  const off = await call("update_campaign", { campaign_id: id, rows: [row(2)], reason: "fewer, better posts" });
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /Autorun is off/);
  cs.setAutorun(id, true);
  const noReason = await call("update_campaign", { campaign_id: id, rows: [row(2)] });
  assert.equal(noReason.isError, true);
  assert.match(noReason.content[0].text, /reason/);
  const cap = await call("update_campaign", { campaign_id: id, daily_post_cap: 5, reason: "more" });
  assert.equal(cap.isError, true, "the cap isn't the agent's");
  const bad = await call("update_campaign", { campaign_id: id, rows: [row(11)], reason: "more" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /quantity/);
  const ok = await call("update_campaign", { campaign_id: id, rows: [row(2)], reason: "fewer, better posts" });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.equal(cs.campaign(id)!.rows[0].quantity, 2);
  assert.equal(cs.changes(id)[0].agent, "codex");

  const cta = await call("add_library_entry", { campaign_id: id, kind: "cta", name: "Buy", text: "Buy now", reason: "sell" });
  assert.equal(cta.isError, true);
  const hook = await call("add_library_entry", { campaign_id: id, kind: "hook", name: "Nobody Tells", text: "Nobody tells you this", reason: "a new hook to test" });
  assert.ok(!hook.isError, hook.content[0].text);
  assert.ok(cs.entries("hook").some((e) => e.name === "Nobody Tells"));
  const linked = await call("add_library_entry", { campaign_id: id, kind: "hook", name: "Visit", text: "Go to evil dot xyz", reason: "traffic" });
  assert.equal(linked.isError, true, "an agent's hook can't carry a link");
  assert.match(linked.content[0].text, /link/);

  const list = (await call("list_campaigns")).structuredContent;
  assert.equal(list.campaigns[0].id, id);
  assert.equal(list.campaigns[0].autorun, true);
  const got = (await call("get_campaign", { campaign_id: id })).structuredContent;
  assert.equal(got.rows[0].quantity, 2);
  assert.equal(got.compiled.days.tue[0].count, 2);
  assert.equal(got.changes.length, 2);
  assert.equal(got.changes[0].reason, "fewer, better posts");
  const lib = (await call("list_library", { kind: "hook" })).structuredContent;
  assert.deepEqual(lib.entries.map((e: any) => e.name), ["Stop Scrolling", "Nobody Tells"]);
  assert.deepEqual(lib.entries.map((e: any) => e.owner_campaign_id), [null, id], "an agent's hook belongs to its campaign");

  const tools = (await rpc("tools/list")).body.result.tools;
  for (const name of ["get_analytics", "get_video_metrics", "list_campaigns", "get_campaign", "list_library"]) {
    assert.equal(tools.find((t: any) => t.name === name).annotations.readOnlyHint, true, name);
  }
  assert.ok(tools.find((t: any) => t.name === "update_campaign").inputSchema.required.includes("reason"));
  await app.close();
});

test("stop_campaigns turns the kill switch on; no tool turns it off", async () => {
  const { app, rpc, call, store } = setup({ campaigns: true });
  const cs = new CampaignStore(store);
  assert.equal(cs.killed(), false);
  const r = await call("stop_campaigns");
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(cs.killed(), true);
  const names = (await rpc("tools/list")).body.result.tools.map((t: any) => t.name);
  assert.ok(!names.some((n: string) => /resume|restart|start_campaign|unkill/.test(n)));
  await app.close();
});

test("get_analytics gives scores and label comparisons; get_video_metrics gives one post's snapshots", async () => {
  const { app, call, store } = setup();
  const a = new AnalyticsStore(store);
  const acct = store.upsertAccount(account("youtube", { expiresAt: null }));
  const posts: number[] = [];
  for (let i = 0; i < 4; i++) {
    const postId = store.createPost({ caption: "", title: "", sourcePath: "x.mp4", sha256: `sha-${i}`, tiktok: null }, [acct.id]);
    const job = store.jobsForPost(postId)[0];
    store.finishJob(job.id, "published", { resultUrl: "https://youtube.com/shorts/x" });
    store.db.prepare("UPDATE jobs SET published_at = ? WHERE id = ?").run(Date.now() - 4 * 86_400_000, job.id);
    a.addSnapshot({ jobId: job.id, platform: "youtube", externalId: `v${i}`, takenAt: Date.now(), ageSec: 259_200, reading: { views: 100 * (i + 1), viewsKind: "views", raw: { likes: i }, retention: null } });
    a.setLabels({ postId, source: i < 3 ? "generated" : "recorded", styleId: "basic", hookId: null, hookText: "hi", angleId: null, angleText: null, ctaId: null, ctaText: null, campaignId: null, campaignTaskId: null, types: [], labelledBy: "user" });
    posts.push(postId);
  }
  const all = (await call("get_analytics")).structuredContent;
  assert.equal(all.videos.length, 4);
  assert.ok(all.videos.every((v: any) => !("snapshots" in v)));
  assert.ok(all.videos.some((v: any) => typeof v.score["72h"] === "number"));
  assert.ok(Array.isArray(all.comparisons.source));
  assert.equal(all.comparisons.source.find((r: any) => r.key === "generated").n, 3);
  const recorded = (await call("get_analytics", { source: "recorded", days: 30, account_id: acct.id })).structuredContent;
  assert.deepEqual(recorded.videos.map((v: any) => v.post_id), [posts[3]]);
  const none = (await call("get_analytics", { days: 1 })).structuredContent;
  assert.equal(none.videos.length, 0);
  const m = (await call("get_video_metrics", { post_id: posts[1] })).structuredContent;
  assert.equal(m.labels.source, "generated");
  assert.equal(m.jobs[0].snapshots[0].views, 200);
  assert.equal((await call("get_video_metrics", { post_id: 9999 })).isError, true);
  await app.close();
});

test("retry_job (and the window's Retry) re-queue a failed campaign job held while campaigns are stopped", async () => {
  const { app, call, store, published } = setup({ campaigns: true });
  const cs = new CampaignStore(store);
  const acct = store.upsertAccount(account("x"));
  const now = Date.now();
  const review = Number(store.db.prepare(
    "INSERT INTO reviews (subject_kind, source_path, draft, state, expires_at, requested_via, created_at, updated_at) VALUES ('edit', 'v.mp4', '{}', 'approved', ?, 'campaign', ?, ?)",
  ).run(now + 86_400_000, now, now).lastInsertRowid);
  const postId = store.createPost({ caption: "c", title: "t", sourcePath: "v.mp4", sha256: "s", tiktok: null, scheduledAt: now + 3_600_000 }, [acct.id]);
  store.db.prepare("UPDATE posts SET review_id = ? WHERE id = ?").run(review, postId);
  const campaignId = cs.create({ name: "Growth", text: "", accountSetId: null, defaultPostTimes: ["09:00"] });
  cs.addTask({ campaignId, date: "2026-11-18", dayIndex: 0, instructionIndex: 0, kind: "make", state: "failed", reviewId: review, postId });
  const [job] = store.jobsForPost(postId);
  store.finishJob(job.id, "failed", { error: "no" });
  cs.setKilled(true);
  const r = await call("retry_job", { job_id: job.id });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(store.job(job.id)!.state, "queued");
  assert.equal(store.job(job.id)!.nextRunAt, Number.MAX_SAFE_INTEGER, "held: the kill switch covers retry_job");
  store.finishJob(job.id, "failed", { error: "no" });
  const res = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/retry`, headers: HOST });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.job(job.id)!.nextRunAt, Number.MAX_SAFE_INTEGER, "and the window's Retry");
  assert.deepEqual(published, []);
  await app.close();
});


/** A campaign task waiting on an agent's film, its brief due in an hour. */
function briefTask(cs: CampaignStore, sec: number | null = null) {
  const campaignId = cs.create({ name: "Films", text: "", accountSetId: null, defaultPostTimes: [] });
  const brief = {
    look: "lemo:impasto", producer: "lemo-opuscar", hook: "Stop scrolling", angle: "A calm one", cta: { text: "Get the guide", url: null },
    sec, instructions: "Keep it quiet", language: "en", needsImageGen: false, deadline: Date.now() + 3_600_000, postAt: null,
  };
  const taskId = cs.addTask({ campaignId, date: "2026-11-20", dayIndex: 0, instructionIndex: 0, kind: "make", state: "awaiting_agent", choices: { brief, offers: 0, briefRound: 1, instruction: { kind: "make", look: "lemo:impasto" } } as never })!;
  return { campaignId, taskId };
}

test("agent tools are listed", async () => {
  const { rpc } = setup();
  const tools = (await rpc("tools/list")).body.result.tools;
  for (const name of ["sync_looks", "list_briefs", "claim_brief", "renew_brief", "submit_brief", "give_up_brief"]) {
    const t = tools.find((x: any) => x.name === name);
    assert.ok(t, name);
    assert.equal(t.inputSchema.additionalProperties, false, `${name} is strict`);
    assert.ok(!("holder" in t.inputSchema.properties), "the agent never names the holder");
  }
  const { EVENT_GUIDE } = await import("../src/mcp.ts");
  assert.match(EVENT_GUIDE, /brief\.requested or brief\.expired: if handled_by is "freeposter", don't claim it/);
  assert.match(EVENT_GUIDE, /Otherwise call claim_brief/);
  for (const name of ["renew_brief", "submit_brief", "give_up_brief"]) {
    assert.ok(tools.find((x: any) => x.name === name).inputSchema.required.includes("claim_token"), `${name} needs the claim token`);
  }
});

test("claim_brief through MCP uses the client name as holder and returns a claim token", async () => {
  const { rpc, call, worker } = setup({ campaigns: true });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
  const { taskId } = briefTask(worker!.campaigns);
  const open = (await call("list_briefs")).structuredContent;
  assert.deepEqual(open.briefs.map((b: any) => [b.task_id, b.look]), [[taskId, "lemo:impasto"]]);
  const got = (await call("claim_brief", { task_id: taskId })).structuredContent;
  assert.equal(got.brief.look, "lemo:impasto");
  assert.match(got.brief.deadline, /^\d{4}-\d\d-\d\dT/);
  assert.match(got.lease_until, /^\d{4}-\d\d-\d\dT/);
  assert.match(got.next, /renew_brief/);
  assert.match(got.next, /give_up_brief/);
  assert.match(got.claim_token, /^[0-9a-f-]{36}$/);
  assert.match(got.next, /caption and title yourself/);
  assert.equal((worker!.campaigns.task(taskId)!.choices as any).lease.holder, "codex");
  // Another client under the same name doesn't get it, and can't renew it without the token.
  const twin = await call("claim_brief", { task_id: taskId });
  assert.equal(twin.isError, true);
  assert.match(twin.content[0].text, /claimed by codex until/);
  const noToken = await call("renew_brief", { task_id: taskId });
  assert.equal(noToken.isError, true);
  assert.match(noToken.content[0].text, /claimed under another claim; call claim_brief to get your own/);
  const mine = (await call("claim_brief", { task_id: taskId, claim_token: got.claim_token })).structuredContent;
  assert.equal(mine.claim_token, got.claim_token, "claiming with the token is idempotent");
  assert.equal((await call("renew_brief", { task_id: taskId, claim_token: got.claim_token })).isError, undefined);
  assert.equal((await call("list_briefs")).structuredContent.briefs.length, 0, "a leased brief isn't open");
});

test("submit_brief refuses an unknown task_id with a helpful error", async () => {
  const { call } = setup({ campaigns: true });
  const r = await call("submit_brief", { task_id: 999, video_path: "C:/nope.mp4", library_version: "1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /list_briefs/);
});

test("submit_brief delivers the file for the brief's own look", async () => {
  const { rpc, call, worker, dir } = setup({ campaigns: true });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
  const { taskId } = briefTask(worker!.campaigns);
  const { claim_token } = (await call("claim_brief", { task_id: taskId })).structuredContent;
  const video = verticalSilent(dir);
  const r = (await call("submit_brief", { task_id: taskId, claim_token, video_path: video, library_version: "3", look: "lemo:other" })).isError;
  assert.equal(r, true, "an unknown field is refused");
  const ok = (await call("submit_brief", { task_id: taskId, claim_token, video_path: video, library_version: "3", caption: "hi" })).structuredContent;
  assert.equal(ok.ok, true);
  assert.equal(ok.repeat, false);
  assert.match(ok.next, /request_review/);
  assert.deepEqual((worker!.campaigns.task(taskId)!.choices as any).delivery.manifest, { look: "lemo:impasto", libraryVersion: "3" });
});

test("sync_looks refuses an unknown field", async () => {
  const { call } = setup();
  const look = { key: "lemo:a", name: "A", description: "d", needs_image_gen: false };
  const r = await call("sync_looks", { producer: "lemo-opuscar", library_version: "1", looks: [look], extra: 1 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /extra/);
  const inner = await call("sync_looks", { producer: "lemo-opuscar", library_version: "1", looks: [{ ...look, colour: "red" }] });
  assert.equal(inner.isError, true);
  const bad = await call("sync_looks", { producer: "other", library_version: "1", looks: [look] });
  assert.equal(bad.isError, true);
  const ok = await call("sync_looks", { producer: "lemo-opuscar", library_version: "1", looks: [look] });
  assert.deepEqual(ok.structuredContent, { added: 1, updated: 0, hidden: 0 });
});

test("give_up_brief tells the user", async () => {
  for (const campaigns of [true, false]) {
    const { rpc, call, worker, store } = setup({ campaigns });
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } });
    const { taskId } = briefTask(worker?.campaigns ?? new CampaignStore(store));
    const { claim_token } = (await call("claim_brief", { task_id: taskId })).structuredContent;
    const r = await call("give_up_brief", { task_id: taskId, claim_token, reason: "no image generator" });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const events = (await call("list_events")).structuredContent.events.filter((e: any) => e.event_type === "campaign.failed");
    assert.equal(events.length, 1, `worker running: ${campaigns}`);
    assert.match(events[0].summary, /the agent gave up: no image generator/);
  }
});
