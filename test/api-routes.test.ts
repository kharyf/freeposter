import "./isolated-home.ts"; // first: keeps uploads out of the real data/ folder
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { GUIDES } from "../src/api/guides.ts";
import { account, mcpFixture, verticalSilent } from "./helpers.ts";

const HOST = { host: `localhost:${config.port}` };

function setup() {
  const fx = mcpFixture({ campaigns: true });
  const api = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    fx.app.inject({ method, url, headers: { ...HOST, ...headers }, payload: payload as any });
  return { ...fx, api };
}

test("index is one line per op and fits the budget", async () => {
  const { api } = setup();
  const r = await api("GET", "/agent/v1");
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers["content-type"]), /text\/plain/);
  assert.ok(r.body.includes("claim_brief task_id:int claim_token?:str"));
  const names = r.body.split("\n").slice(3).map((l) => l.split(" ")[0]);
  assert.ok(!names.some((n) => /approve|decide|accept/.test(n)), "no approve op");
  assert.equal(r.body.split("\n")[0], "FreePoster agent API. POST /agent/v1/<op> with JSON args → compact JSON.");
});

test("guides and op docs are plain text; unknown ones are 404", async () => {
  const { api } = setup();
  const g = await api("GET", "/agent/v1/guide/rules");
  assert.equal(g.statusCode, 200);
  assert.equal(g.body, GUIDES.rules);
  const missing = await api("GET", "/agent/v1/guide/nope");
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /rules events production campaigns limits/);
  const doc = await api("GET", "/agent/v1/get_post");
  assert.equal(doc.statusCode, 200);
  assert.ok(doc.body.startsWith("get_post post_id:int"));
  assert.equal((await api("GET", "/agent/v1/get_pots")).statusCode, 404);
  assert.equal((await api("GET", "/agent/v1/guide/constructor")).statusCode, 404);
});

test("empty body means no arguments", async () => {
  const { app } = setup();
  const r = await app.inject({ method: "POST", url: "/agent/v1/list_accounts", headers: HOST });
  assert.equal(r.statusCode, 200);
  assert.ok(Array.isArray(r.json().accounts));
  assert.ok(!r.body.includes("\n  "), "compact JSON");
  const j = await app.inject({ method: "POST", url: "/agent/v1/list_accounts", headers: { ...HOST, "content-type": "application/json" } });
  assert.equal(j.statusCode, 200);
});

test("empty JSON bodies are only forgiven under /agent/v1", async () => {
  const { app } = setup();
  const r = await app.inject({ method: "POST", url: "/mcp", headers: { ...HOST, "content-type": "application/json" } });
  assert.equal(r.statusCode, 400);
});

test("fields projects the result", async () => {
  const { api, store } = setup();
  const x = store.upsertAccount(account("x"));
  assert.deepEqual((await api("POST", "/agent/v1/list_accounts?fields=accounts.id,accounts.platform", {})).json(), { accounts: [{ id: x.id, platform: "x" }] });
});

test("errors are 400 / 404 / 422 with {error}", async () => {
  const { api } = setup();
  const typo = await api("POST", "/agent/v1/list_acounts", {});
  assert.equal(typo.statusCode, 404);
  assert.equal(typo.json().error.includes("did you mean list_accounts"), true);
  assert.equal((await api("POST", "/agent/v1/get_post", { post_id: "1" })).statusCode, 400);
  assert.equal((await api("POST", "/agent/v1/get_post", { post_id: 999 })).statusCode, 422);
  assert.equal((await api("POST", "/agent/v1/get_post", { post_id: 1, bogus: 1 })).statusCode, 400);
  assert.equal((await api("POST", "/agent/v1/get_post", '{"post_id":1,"constructor":1}', { "content-type": "application/json" })).statusCode, 400);
  assert.equal((await api("POST", "/agent/v1/get_post", "{nope", { "content-type": "application/json" })).statusCode, 400);
});

test("refuses other websites and non-JSON bodies", async () => {
  const { api, app } = setup();
  assert.equal((await api("POST", "/agent/v1/list_accounts", {}, { origin: "https://evil.example" })).statusCode, 403);
  assert.equal((await api("GET", "/agent/v1", undefined, { origin: "https://evil.example" })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/agent/v1/request_review", headers: { ...HOST, "content-type": "text/plain" }, payload: "{}" })).statusCode, 415);
});

test("the app password guards the API", async () => {
  const { api } = setup();
  const before = config.appPassword;
  config.appPassword = "pw";
  try {
    assert.equal((await api("POST", "/agent/v1/list_accounts", {})).statusCode, 401);
    const basic = `Basic ${Buffer.from("freeposter:pw").toString("base64")}`;
    assert.equal((await api("POST", "/agent/v1/list_accounts", {}, { authorization: basic })).statusCode, 200);
  } finally {
    config.appPassword = before;
  }
});

test("batch keeps going past a failure", async () => {
  const { api } = setup();
  const r = (await api("POST", "/agent/v1", [{ op: "list_accounts" }, { op: "get_post", args: { post_id: 999 } }, { op: "list_posts" }, { op: "wait_for_events" }])).json();
  assert.ok(r[0].ok);
  assert.equal(r[1].status, 422);
  assert.ok(r[2].ok);
  assert.match(r[3].error, /can't be batched/);
});

test("a batch must be a list of at most 20 objects", async () => {
  const { api } = setup();
  assert.equal((await api("POST", "/agent/v1", [{ op: "list_accounts" }, 5])).statusCode, 400);
  assert.equal((await api("POST", "/agent/v1", Array.from({ length: 21 }, () => ({ op: "list_accounts" })))).statusCode, 400);
  assert.equal((await api("POST", "/agent/v1", { op: "list_accounts" })).statusCode, 400);
});

test("a review requested through the API is the agent's, and still needs the user's tap", async () => {
  const { api, dir, store, published, prepared, approve } = setup();
  const x = store.upsertAccount(account("x"));
  const video = verticalSilent(dir);
  const asked = await api("POST", "/agent/v1/publish_video", { video_path: video, account_ids: [x.id], caption: "ship it" }, { "x-freeposter-agent": "tester" });
  assert.equal(asked.statusCode, 200, asked.body);
  const id = asked.json().id;
  const review = await prepared(id);
  assert.equal(review.state, "pending", review.error ?? "");
  assert.equal(review.requestedVia, "agent");
  assert.deepEqual(published, [], "asking posts nothing");
  const decided = await approve(id);
  assert.equal(decided.ok, true, decided.error);
  const postId = decided.review.post_id;
  for (let i = 0; i < 100 && store.jobsForPost(postId)[0].state !== "published"; i++) await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(published, ["ship it"]);
});
