import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CampaignStore } from "../src/campaigns/store.ts";
import { campaignVocabulary } from "../src/campaigns/autorun.ts";
import { parseRows } from "../src/campaigns/rows.ts";
import { config } from "../src/config.ts";
import { account, mcpFixture } from "./helpers.ts";

const HOST = { host: `localhost:${config.port}`, "content-type": "application/json" };

test("get_campaign's compacted rows go straight back into update_campaign", async () => {
  const { app, store } = mcpFixture({ campaigns: true });
  const cs = new CampaignStore(store);
  const hook = cs.addEntry({ kind: "hook", name: "Stop Scrolling", text: "Stop scrolling" });
  const cta = cs.addEntry({ kind: "cta", name: "Free Guide", text: "Get the guide", url: "https://example.com/guide" });
  const id = cs.create({ name: "Weekday Growth", text: "", accountSetId: null, defaultPostTimes: [], dailyPostCap: 100 });
  cs.setRows(id, [{
    id: 1, quantity: 1, hook: { pick: "named", id: hook }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, style: "basic",
    type: null, time: "09:00", days: ["tue"], sec: 30, origin: "create", model: null, text: "",
  } as never, {
    id: 2, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, style: null,
    type: null, time: "10:00", days: ["wed"], sec: null, origin: "agent", model: null, text: "",
  } as never]);
  cs.setAutorun(id, true);
  const post = (op: string, body: unknown) => app.inject({ method: "POST", url: `/agent/v1/${op}`, headers: HOST, payload: body as any });
  const got = await post("get_campaign", { campaign_id: id });
  assert.equal(got.statusCode, 200);
  const rows = got.json().rows;
  assert.equal("type" in rows[0], false, "compaction dropped the nulls");
  const back = await post("update_campaign", { campaign_id: id, reason: "round trip", rows });
  assert.equal(back.statusCode, 200, back.body);
});

test("parseRows reads missing type, sec, model, text and an Agent row's style as empty", () => {
  const { store } = mcpFixture({ campaigns: true });
  const vocab = campaignVocabulary(store, new CampaignStore(store));
  const r = parseRows([{ id: 1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, days: ["tue"], time: "09:00", origin: "agent" }], vocab);
  assert.ok(r.ok, r.ok ? "" : r.problems.join("; "));
  if (r.ok) assert.deepEqual([r.value[0].type, r.value[0].sec, r.value[0].model, r.value[0].text, r.value[0].style], [null, null, null, "", null]);
  const bad = parseRows([{ id: 1, quantity: 1, hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, days: ["tue"], time: "09:00", origin: "create" }], vocab);
  assert.equal(bad.ok, false, "a Create row still needs a style");
});

test("optional arguments may be null; required ones may not", async () => {
  const { call, app } = mcpFixture();
  const named = await call("list_posts", { limit: null });
  assert.ok(!named.isError, named.content?.[0]?.text);
  const fp = await call("fp", { op: "list_posts", args: { limit: null } });
  assert.ok(!fp.isError, fp.content?.[0]?.text);
  const api = await app.inject({ method: "POST", url: "/agent/v1/list_posts", headers: HOST, payload: { limit: null } });
  assert.equal(api.statusCode, 200, api.body);
  const req = await app.inject({ method: "POST", url: "/agent/v1/get_post", headers: HOST, payload: { post_id: null } });
  assert.equal(req.statusCode, 400);
  assert.match(req.body, /post_id is required/);
});

test("list_accounts lists a platform that is not configured even when it has an account", async () => {
  const { store, call } = mcpFixture();
  store.upsertAccount(account("x"));
  const x = config.credentials.x;
  const saved = { ...x };
  x.id = ""; x.secret = "";
  try {
    const r = (await call("list_accounts")).structuredContent;
    assert.ok(r.platforms.some((p: any) => p.platform === "x"), "x isn't configured, so it is still to set up");
  } finally { Object.assign(x, saved); }
});

test("request_review's index summary starts with the review", async () => {
  const { summary } = await import("../src/api/schema.ts");
  const fx = mcpFixture({ campaigns: true });
  const t = fx.toolsForTest().find((x) => x.name === "request_review")!;
  assert.match(summary(t.description), /^Sends a video to the user for review/);
});

test("fp declares args as an object, still parsing a JSON string", async () => {
  const { rpc } = mcpFixture();
  const list = (await rpc("tools/list")).body.result.tools;
  const fp = list.find((t: any) => t.name === "fp");
  assert.equal(fp.inputSchema.properties.args.type, "object");
  assert.equal(fp.inputSchema.properties.args.anyOf, undefined);
  assert.equal(fp.inputSchema.properties.calls.items.properties.args.anyOf, undefined);
  assert.equal(fp.inputSchema.properties.calls.items.properties.args.type, "object");
});
