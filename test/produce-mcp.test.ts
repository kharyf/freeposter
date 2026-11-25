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
  return { hyperframes: make("hyperframes", "cpu"), remotion: make("remotion", "cpu"), wan: make("wan", "gpu"), blender: make("blender", "gpu"), file: make("file", "cpu"), edit: make("edit", "cpu") } as Adapters;
}

function setup() {
  const store = newStore();
  const acct = store.upsertAccount(account("x"));
  const publishers = { ...real, x: { ...real.x, publish: async () => ({ url: "https://x.com/u/status/1" }) } } as Record<Platform, Publisher>;
  const heard: string[] = [];
  const speechFor = async (src: { sourcePath: string; sha256: string }) => {
    heard.push(src.sha256);
    return { words: [{ text: "Hello", start: 0.1234, end: 0.4 }, { text: "world.", start: 0.45, end: 0.9 }], language: null };
  };
  const producer = new ProductionWorker(store, { adapters: fakeAdapters(), dir: tmp(), speechFor });
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers, {}, undefined, undefined, producer);
  let id = 0;
  const rpc = async (method: string, params?: unknown, url = "/mcp") => {
    const res = await app.inject({ method: "POST", url, headers: HOST, payload: { jsonrpc: "2.0", id: ++id, method, params } });
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
  return { store, acct, app, rpc, call, producer, ready, heard };
}

const spec = { title: "Teaser", shots: [{ id: "a", kind: "wan", duration_sec: 2, prompt: "a phone" }, { id: "b", kind: "file", path: "" }] };
const withClip = () => ({ ...spec, shots: [spec.shots[0], { ...spec.shots[1], path: clip }] });

test("the six production tools are listed, and none approves", async () => {
  const { rpc, app } = setup();
  const names = (await rpc("tools/list", undefined, "/mcp?profile=full")).result.tools.map((t: any) => t.name);
  for (const n of ["describe_production_tools", "start_production", "get_production", "revise_production", "cancel_production", "transcribe_media"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("approve_production"));
  assert.equal(names.length, 41);
  await app.close();
});

test("describe_production_tools reports each kind's health, templates and SFX", async () => {
  const { call, app } = setup();
  const r = (await call("describe_production_tools")).structuredContent;
  assert.deepEqual(r.shot_kinds.map((k: any) => k.kind).sort(), ["blender", "edit", "file", "hyperframes", "remotion", "wan"]);
  assert.match(r.remotion_rules, /export.*React component.*staticFile/s);
  assert.equal(typeof r.whisper.ok, "boolean");
  assert.ok(r.shot_kinds.every((k: any) => k.ok));
  assert.ok(r.blender_templates["logo-spin"].params.text);
  assert.deepEqual(r.sfx, []);
  assert.match(r.review.how, /request_review/);
  assert.equal("agent_approval" in r, false);
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

test("a production posts only through a review the user approves", async () => {
  const { call, app, ready, acct, store } = setup();
  const started = (await call("start_production", { spec: withClip() })).structuredContent;
  await ready(started.id);
  // There's no approve tool any more; asking for a review posts nothing.
  const gone = await call("approve_production", { production_id: started.id, account_ids: [acct.id], caption: "hi" });
  assert.equal(gone, undefined, "unknown tool");
  const asked = (await call("request_review", { production_id: started.id, account_ids: [acct.id], caption: "hi" })).structuredContent;
  assert.equal(asked.subject.kind, "production");
  let r = asked;
  for (let i = 0; i < 200 && r.state === "preparing"; i++) {
    await new Promise((res) => setTimeout(res, 50));
    r = (await call("get_review", { review_id: asked.id })).structuredContent;
  }
  assert.equal(r.state, "pending", r.error);
  assert.equal(store.recentPosts().length, 0);
  const res = await app.inject({ method: "POST", url: `/api/reviews/${asked.id}/approve`, headers: HOST });
  assert.equal(res.statusCode, 200, res.body);
  const postId = res.json().review.post_id;
  assert.equal(store.jobsForPost(postId).length, 1);
  const p = (await call("get_production", { production_id: started.id })).structuredContent;
  assert.equal(p.state, "approved");
  assert.equal(p.post_id, postId);
  assert.equal((await call("cancel_production", { production_id: started.id })).isError, true);
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

test("transcribe_media returns Whisper's words with their timing, keyed by the file's content", async () => {
  const { call, app, heard } = setup();
  const r = await call("transcribe_media", { path: clip });
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.structuredContent.words, [{ text: "Hello", start: 0.123, end: 0.4 }, { text: "world.", start: 0.45, end: 0.9 }]);
  assert.equal(r.structuredContent.text, "Hello world.");
  assert.equal(r.structuredContent.duration_sec, 0.9);
  assert.match(heard[0], /^[0-9a-f]{64}$/);
  const missing = await call("transcribe_media", { path: join(tmp(), "nope.wav") });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /no file at/);
  await app.close();
});
