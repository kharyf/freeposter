import "./isolated-home.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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
  const adapters = { hyperframes: make("hyperframes", false), remotion: make("remotion", true), wan: make("wan", true), blender: make("blender", true), file: make("file", true), edit: make("edit", true) } as Adapters;
  const producer = new ProductionWorker(store, { adapters, dir: tmp() });
  return buildServer(store, new Runner(store, publishers, tmp()), publishers, {}, undefined, undefined, producer);
}

test("production settings are checked when saved", async () => {
  const app = setup();
  const put = (values: Record<string, string>) => app.inject({ method: "PUT", url: "/api/settings", headers: HOST, payload: { values } });
  const bad = await put({ AGENT_APPROVAL: "on", WANGP_TIMEOUT_MIN: "-3", NOTIFY_WEBHOOK_URL: "ftp://x" });
  assert.equal(bad.statusCode, 400);
  // Agents never approve any more: the setting is gone, so turning it on is refused.
  assert.match(bad.json().error, /AGENT_APPROVAL is not a setting/);
  assert.match(bad.json().error, /WANGP_TIMEOUT_MIN must be a whole number/);
  assert.match(bad.json().error, /NOTIFY_WEBHOOK_URL must be an http/);
  const good = await put({ CPU_LANE_CONCURRENCY: "3" });
  assert.equal(good.statusCode, 200);
  assert.equal(config.produce.cpuLane, 3);
  await put({ CPU_LANE_CONCURRENCY: "" });
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

test("the WanGP model pickers list the install's models, and the three model slots save like any setting", async () => {
  const app = setup();
  const wan = tmp();
  writeFileSync(join(wan, "wgp.py"), "");
  mkdirSync(join(wan, "defaults"));
  writeFileSync(join(wan, "defaults", "chatterbox.json"), JSON.stringify({ model: { name: "TTS Chatterbox", architecture: "chatterbox" } }));
  writeFileSync(join(wan, "defaults", "t2v.json"), JSON.stringify({ model: { name: "Wan", architecture: "t2v" } }));
  const put = (values: Record<string, string>) => app.inject({ method: "PUT", url: "/api/settings", headers: HOST, payload: { values } });
  try {
    assert.equal((await put({ WANGP_DIR: wan })).statusCode, 200);
    const res = await app.inject({ method: "GET", url: "/api/produce/wangp-models", headers: HOST });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { video: ["t2v"], speech: ["chatterbox"], audio: [], presenter: [] });
    const saved = await put({ WANGP_SPEECH_MODEL: "chatterbox", WANGP_AUDIO_MODEL: "ace_step_v1_5", WANGP_PRESENTER_MODEL: "infinitetalk" });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(config.produce.wangpSpeechModel, "chatterbox");
    assert.equal(config.produce.wangpAudioModel, "ace_step_v1_5");
    assert.equal(config.produce.wangpPresenterModel, "infinitetalk");
  } finally {
    await put({ WANGP_DIR: "", WANGP_SPEECH_MODEL: "", WANGP_AUDIO_MODEL: "", WANGP_PRESENTER_MODEL: "" });
    await app.close();
  }
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

test("the agent launcher's toggle and language save as prefs through the settings route", async () => {
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers, {});
  const put = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: HOST, payload });
  try {
    const view = (await app.inject({ method: "GET", url: "/api/settings", headers: HOST })).json();
    assert.deepEqual(view.prefs, { "agent.launch.enabled": false, "agent.language": "en", "agent.launch.status": null });
    const bad = await put({ values: {}, prefs: { "agent.launch.enabled": "yes", "agent.language": "not a language", "agent.launch.status": "idle", other: 1 } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /agent\.launch\.enabled must be true or false/);
    assert.match(bad.json().error, /agent\.language must be a language code/);
    assert.match(bad.json().error, /agent\.launch\.status is not a setting/);
    assert.match(bad.json().error, /other is not a setting/);
    assert.equal(store.pref("agent.launch.enabled"), undefined);
    store.setPref("agent.launch.status", "idle");
    const good = await put({ values: {}, prefs: { "agent.launch.enabled": true, "agent.language": "pt-BR" } });
    assert.equal(good.statusCode, 200, good.body);
    assert.equal(store.pref("agent.launch.enabled"), true);
    assert.equal(store.pref("agent.language"), "pt-BR");
    assert.deepEqual(good.json().prefs, { "agent.launch.enabled": true, "agent.language": "pt-BR", "agent.launch.status": "idle" });
    await put({ prefs: { "agent.language": "" } });
    assert.equal(store.pref("agent.language"), undefined);
  } finally {
    await app.close();
  }
});
