import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { indexText, opDoc } from "../src/api/routes.ts";
import { config } from "../src/config.ts";
import { mcpTools } from "../src/mcp.ts";
import { publishers } from "../src/platforms/index.ts";
import { ProductionWorker } from "../src/produce/worker.ts";
import { Runner } from "../src/runner.ts";
import { account, mcpFixture, tmp } from "./helpers.ts";

const HOST = { host: `localhost:${config.port}` };

/** Every op the real server has: the campaign and brief tools, and the production tools (which need a producer). */
function allTools() {
  const fx = mcpFixture({ campaigns: true });
  const producer = new ProductionWorker(fx.store, { adapters: {} as any, dir: tmp(), speechFor: async () => ({ words: [], language: null }) });
  const tools = mcpTools(fx.store, new Runner(fx.store, publishers, tmp()), publishers, fx.reviews, producer, () => ({}), fx.worker);
  return { ...fx, tools };
}

test("default MCP fits 4,000 chars of instructions + tools", async () => {
  const { rpc } = mcpFixture({ campaigns: true });
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } });
  const list = JSON.stringify((await rpc("tools/list")).body.result);
  const total = init.body.result.instructions.length + list.length;
  assert.ok(total <= 4000, `${total}`);
});

test("API index <= 5,500 chars; every op doc <= 4,000", () => {
  const { tools } = allTools();
  assert.ok(tools.some((t) => t.name === "start_production"), "production ops are covered");
  const index = indexText(tools);
  assert.ok(index.length <= 5500, `index is ${index.length}`);
  for (const t of tools) {
    const doc = opDoc(tools, t.name);
    assert.ok(doc.length <= 4000, `${t.name} doc is ${doc.length}`);
  }
});

test("the index spells no long enum", () => {
  const index = indexText(allTools().tools);
  assert.ok(!/production\.ready\|/.test(index), "event types are not listed in signatures");
  assert.match(opDoc(allTools().tools, "list_events"), /production\.ready\|/);
});

test("list_accounts with one account stays under 400 chars", async () => {
  const { store, app } = mcpFixture();
  store.upsertAccount(account("x"));
  const r = await app.inject({ method: "POST", url: "/agent/v1/list_accounts", headers: { ...HOST, "content-type": "application/json" }, payload: "{}" });
  assert.ok(r.body.length <= 400, `${r.body.length}: ${r.body}`);
});

test("list_accounts leaves out the caption limits and labels, and lists only platforms still to connect", async () => {
  const { store, call } = mcpFixture();
  store.upsertAccount(account("x"));
  const x = config.credentials.x, saved = { ...x };
  Object.assign(x, { id: "id", secret: "secret" }); // configured and connected: nothing left to do
  let r: any;
  try { r = (await call("list_accounts")).structuredContent; } finally { Object.assign(x, saved); }
  assert.equal(r.captionLimits, undefined);
  assert.ok(!r.platforms.some((p: any) => p.platform === "x"), "x is configured and has an account");
  for (const p of r.platforms) {
    assert.ok(p.platform && p.label === undefined);
    assert.ok(Object.keys(p).every((k) => ["platform", "configured", "connect_url"].includes(k)), JSON.stringify(p));
  }
});

test("the review result's next line is short", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const m = src.match(/next: "(user decides on the review[^"]*)"/);
  assert.ok(m && m[1].length <= 90, "short next");
});
