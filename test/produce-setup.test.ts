import "./isolated-home.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { signBody } from "../src/notify.ts";
import { publishers } from "../src/platforms/index.ts";
import type { Adapters, ShotAdapter } from "../src/produce/adapters/index.ts";
import { ProductionWorker } from "../src/produce/worker.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { newStore, tmp } from "./helpers.ts";

const HOST = { host: `localhost:${config.port}` };

function setup() {
  const store = newStore();
  const make = (kind: any, ok: boolean): ShotAdapter<any> => ({ kind, lane: "cpu", version: 1, health: async () => ({ ok, detail: `${kind} ${ok ? "ready" : "missing"}` }), render: async () => ({ path: "", durationSec: 0 }) });
  const adapters = { hyperframes: make("hyperframes", false), wan: make("wan", true), blender: make("blender", true), file: make("file", true), edit: make("edit", true) } as Adapters;
  const producer = new ProductionWorker(store, { adapters, dir: tmp() });
  return buildServer(store, new Runner(store, publishers, tmp()), publishers, {}, undefined, undefined, producer);
}

test("production settings are checked when saved", async () => {
  const app = setup();
  const put = (values: Record<string, string>) => app.inject({ method: "PUT", url: "/api/settings", headers: HOST, payload: { values } });
  const bad = await put({ AGENT_APPROVAL: "maybe", WANGP_TIMEOUT_MIN: "-3", NOTIFY_WEBHOOK_URL: "ftp://x" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /AGENT_APPROVAL must be on or off/);
  assert.match(bad.json().error, /WANGP_TIMEOUT_MIN must be a whole number/);
  assert.match(bad.json().error, /NOTIFY_WEBHOOK_URL must be an http/);
  const good = await put({ AGENT_APPROVAL: "on", CPU_LANE_CONCURRENCY: "3" });
  assert.equal(good.statusCode, 200);
  assert.equal(config.produce.agentApproval, true);
  assert.equal(config.produce.cpuLane, 3);
  await put({ AGENT_APPROVAL: "off", CPU_LANE_CONCURRENCY: "" });
  await app.close();
});

test("the health route reports each shot kind and the SFX library", async () => {
  const app = setup();
  const res = await app.inject({ method: "GET", url: "/api/produce/health", headers: HOST });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.kinds.find((k: any) => k.kind === "hyperframes"), { kind: "hyperframes", ok: false, detail: "hyperframes missing" });
  assert.ok(Array.isArray(body.sfx));
  assert.ok(body.templates.includes("logo-spin"));
  assert.equal(typeof body.sfxDir, "string");
  await app.close();
});

test("a test event is sent to the webhook, signed", async () => {
  const app = setup();
  const noHook = await app.inject({ method: "POST", url: "/api/notify/test", headers: HOST });
  assert.equal(noHook.statusCode, 400);
  const seen: { headers: any; body: string }[] = [];
  const hook = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { seen.push({ headers: req.headers, body }); res.end("{}"); });
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  const saved = { ...config.produce };
  config.produce.webhookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/webhooks/freeposter`;
  config.produce.webhookSecret = "s";
  try {
    const res = await app.inject({ method: "POST", url: "/api/notify/test", headers: HOST });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(seen[0].body).event_type, "test");
    assert.equal(seen[0].headers["x-webhook-signature-v2"], signBody(seen[0].body, "s", Number(seen[0].headers["x-webhook-timestamp"])));
  } finally {
    Object.assign(config.produce, saved);
    hook.close();
    await app.close();
  }
});
