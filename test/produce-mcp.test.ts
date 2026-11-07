import "./isolated-home.ts";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { config } from "../src/config.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
import type { Adapters, ShotAdapter } from "../src/produce/adapters/index.ts";
import { ProductionWorker } from "../src/produce/worker.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, makeVideo, newStore, tmp } from "./helpers.ts";

const HOST = { host: `localhost:${config.port}` };
let clip: string;
before(() => { clip = makeVideo(tmp(), "clip.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]); });

function fakeAdapters(): Adapters {
  const make = (kind: any, lane: "gpu" | "cpu"): ShotAdapter<any> => ({
    kind, lane, version: 1, health: async () => ({ ok: true, detail: `fake ${kind}` }),
    async render(_shot, ctx) { const out = join(ctx.dir, "shot.mp4"); copyFileSync(clip, out); return { path: out, durationSec: 2 }; },
  });
  return { hyperframes: make("hyperframes", "cpu"), wan: make("wan", "gpu"), blender: make("blender", "gpu"), file: make("file", "cpu"), edit: make("edit", "cpu") } as Adapters;
}

function setup() {
  const store = newStore();
  const acct = store.upsertAccount(account("x"));
  const publishers = { ...real, x: { ...real.x, publish: async () => ({ url: "https://x.com/u/status/1" }) } } as Record<Platform, Publisher>;
  const producer = new ProductionWorker(store, { adapters: fakeAdapters(), dir: tmp() });
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers, {}, undefined, undefined, producer);
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: HOST, payload: { jsonrpc: "2.0", id: ++id, method, params } });
    return res.json();
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const ready = async (pid: number) => {
    for (let i = 0; i < 400; i++) {
      await producer.tick();
      const p = producer.productions.get(pid)!;
      if (p.state === "ready" && !producer.busy()) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("not ready");
  };
  return { store, acct, app, rpc, call, producer, ready };
}

const spec = { title: "Teaser", shots: [{ id: "a", kind: "wan", duration_sec: 2, prompt: "a phone" }, { id: "b", kind: "file", path: "" }] };
const withClip = () => ({ ...spec, shots: [spec.shots[0], { ...spec.shots[1], path: clip }] });

test("the six production tools are listed", async () => {
  const { rpc, app } = setup();
  const names = (await rpc("tools/list")).result.tools.map((t: any) => t.name);
  for (const n of ["describe_production_tools", "start_production", "get_production", "revise_production", "cancel_production", "approve_production"]) assert.ok(names.includes(n), n);
  assert.equal(names.length, 16);
  await app.close();
});

test("describe_production_tools reports each kind's health, templates and SFX", async () => {
  const { call, app } = setup();
  const r = (await call("describe_production_tools")).structuredContent;
  assert.deepEqual(r.shot_kinds.map((k: any) => k.kind).sort(), ["blender", "edit", "file", "hyperframes", "wan"]);
  assert.ok(r.shot_kinds.every((k: any) => k.ok));
  assert.ok(r.blender_templates["logo-spin"].params.text);
  assert.deepEqual(r.sfx, []);
  assert.equal(r.agent_approval, false);
  await app.close();
});

test("start_production dry_run checks the spec and creates nothing; errors list every problem", async () => {
  const { call, producer, app } = setup();
  const dry = await call("start_production", { spec: withClip(), dry_run: true });
  assert.equal(dry.structuredContent.ok, true);
  assert.equal(producer.productions.recent().length, 0);
  const bad = await call("start_production", { spec: { shots: [{ id: "x", kind: "wan", duration_sec: 99 }, { id: "y", kind: "nope" }] } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /prompt is required/);
  assert.match(bad.content[0].text, /kind must be one of/);
  await app.close();
});

test("a production runs to ready; get_production gives the preview link, which serves the video with Range", async () => {
  const { call, app, ready } = setup();
  const started = (await call("start_production", { spec: withClip() })).structuredContent;
  await ready(started.id);
  const p = (await call("get_production", { production_id: started.id })).structuredContent;
  assert.equal(p.state, "ready");
  assert.match(p.preview_url, new RegExp(`/api/productions/${started.id}/preview.mp4$`));
  assert.equal(p.shots.length, 2);
  const res = await app.inject({ method: "GET", url: `/api/productions/${started.id}/preview.mp4`, headers: { ...HOST, range: "bytes=0-99" } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.rawPayload.length, 100);
  const thumb = await app.inject({ method: "GET", url: `/api/productions/${started.id}/thumb.jpg`, headers: HOST });
  assert.equal(thumb.statusCode, 200);
  const rebound = await app.inject({ method: "GET", url: `/api/productions/${started.id}/thumb.jpg`, headers: { host: "evil.example" } });
  assert.equal(rebound.statusCode, 403);
  const list = (await call("get_production")).structuredContent;
  assert.equal(list.productions[0].id, started.id);
  await app.close();
});

test("approve_production is refused while agent approval is off, and posts when it is on", async () => {
  const { call, app, ready, acct, store } = setup();
  const started = (await call("start_production", { spec: withClip() })).structuredContent;
  await ready(started.id);
  const refused = await call("approve_production", { production_id: started.id, account_ids: [acct.id], caption: "hi" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /approve/i);
  config.produce.agentApproval = true;
  try {
    const ok = (await call("approve_production", { production_id: started.id, account_ids: [acct.id], caption: "hi" })).structuredContent;
    assert.ok(ok.post_id);
    assert.equal(store.jobsForPost(ok.post_id).length, 1);
    const p = (await call("get_production", { production_id: started.id })).structuredContent;
    assert.equal(p.state, "approved");
    assert.equal(p.post_id, ok.post_id);
    assert.equal((await call("cancel_production", { production_id: started.id })).isError, true);
  } finally {
    config.produce.agentApproval = false;
  }
  await app.close();
});

test("revise_production replaces shots by id and re-renders only those", async () => {
  const { call, app, ready, producer } = setup();
  const started = (await call("start_production", { spec: withClip() })).structuredContent;
  await ready(started.id);
  const r = (await call("revise_production", { production_id: started.id, shots: [{ id: "a", kind: "wan", duration_sec: 2, prompt: "a different phone" }] })).structuredContent;
  assert.equal(r.revision, 2);
  assert.deepEqual(r.changed, ["a"]);
  assert.equal((await ready(started.id)).revision, 2);
  assert.equal(producer.productions.get(started.id)!.spec.shots[0].kind === "wan" && (producer.productions.get(started.id)!.spec.shots[0] as any).prompt, "a different phone");
  await app.close();
});

test("cancel_production stops a production", async () => {
  const { call, app } = setup();
  const started = (await call("start_production", { spec: withClip() })).structuredContent;
  const r = (await call("cancel_production", { production_id: started.id })).structuredContent;
  assert.equal(r.state, "cancelled");
  await app.close();
});
