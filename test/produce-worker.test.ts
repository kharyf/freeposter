import "./isolated-home.ts";
import assert from "node:assert/strict";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { config } from "../src/config.ts";
import { Fatal, Retryable, type Adapters, type ShotAdapter } from "../src/produce/adapters/index.ts";
import { ProductionWorker } from "../src/produce/worker.ts";
import { makeVideo, newStore, tmp } from "./helpers.ts";

let clip: string;
before(() => { clip = makeVideo(tmp(), "clip.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]); });

type Behaviour = (shotId: string, signal: AbortSignal) => Promise<void> | void;

/** Adapters that copy a test clip, after doing whatever `behave` says; counts renders and concurrent GPU runs. */
function fakes(behave: Behaviour = () => {}) {
  const stats = { renders: [] as string[], gpuNow: 0, gpuMax: 0 };
  const make = (kind: any, lane: "gpu" | "cpu"): ShotAdapter<any> => ({
    kind, lane, version: 1,
    health: async () => ({ ok: true, detail: "fake" }),
    async render(shot, ctx) {
      stats.renders.push(shot.id);
      if (lane === "gpu") stats.gpuMax = Math.max(stats.gpuMax, ++stats.gpuNow);
      try {
        await behave(shot.id, ctx.signal);
        const out = join(ctx.dir, "shot.mp4");
        copyFileSync(clip, out);
        return { path: out, durationSec: Math.min(2, shot.duration_sec ?? 2) };
      } finally {
        if (lane === "gpu") stats.gpuNow--;
      }
    },
  });
  const adapters = { hyperframes: make("hyperframes", "cpu"), wan: make("wan", "gpu"), blender: make("blender", "gpu"), file: make("file", "cpu"), edit: make("edit", "cpu") } as Adapters;
  return { adapters, stats };
}

const html = `<html><body><div data-composition-id="main" data-width="1080" data-height="1920" data-duration="2"></div></body></html>`;
const rawSpec = (prompt = "a phone") => ({
  shots: [
    { id: "intro", kind: "hyperframes", duration_sec: 2, html },
    { id: "hero", kind: "wan", duration_sec: 2, prompt },
    { id: "logo", kind: "blender", duration_sec: 2, template: "logo-spin", params: { text: "Hi" } },
    { id: "take", kind: "file", path: clip },
  ],
});

/** Ticks until the production settles (or the deadline passes). */
async function settle(w: ProductionWorker, id: number, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    await w.tick();
    const p = w.productions.get(id)!;
    if (["ready", "failed", "cancelled"].includes(p.state) && !w.busy()) return p;
    if (Date.now() > end) throw new Error(`still ${p.state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("one shot of each kind renders, assembles and reports ready", async () => {
  const saved = config.produce.webhookUrl;
  config.produce.webhookUrl = "http://localhost:8644/webhooks/freeposter";
  try {
    const store = newStore();
    const { adapters } = fakes();
    const w = new ProductionWorker(store, { adapters, dir: tmp() });
    const p = await w.create(rawSpec());
    const done = await settle(w, p.id);
    assert.equal(done.state, "ready", done.error ?? "");
    assert.ok(existsSync(done.outputPath!) && existsSync(done.previewPath!) && existsSync(done.thumbPath!));
    assert.ok(Math.abs(done.durationSec! - 8) < 0.2, `got ${done.durationSec}`);
    const event = store.outbox().find((e) => e.event === "production.ready")!;
    assert.match(JSON.parse(event.body).preview_url, new RegExp(`/api/productions/${p.id}/preview.mp4$`));
  } finally {
    config.produce.webhookUrl = saved;
  }
});

test("inputs are copied into the production, so later changes to the original don't matter", async () => {
  const w = new ProductionWorker(newStore(), { adapters: fakes().adapters, dir: tmp() });
  const p = await w.create(rawSpec());
  const take = p.spec.shots.find((s) => s.id === "take")!;
  assert.ok(take.kind === "file" && take.path !== clip && existsSync(take.path));
});

test("a second production reuses cached renders", async () => {
  const store = newStore();
  const { adapters, stats } = fakes();
  const w = new ProductionWorker(store, { adapters, dir: tmp() });
  await settle(w, (await w.create(rawSpec())).id);
  const before = stats.renders.length;
  assert.equal((await settle(w, (await w.create(rawSpec())).id)).state, "ready");
  assert.equal(stats.renders.length, before, "nothing rendered twice");
});

test("the GPU lane never runs two shots at once", async () => {
  const { adapters, stats } = fakes(() => new Promise((r) => setTimeout(r, 100)));
  const w = new ProductionWorker(newStore(), { adapters, dir: tmp() });
  const raw = rawSpec();
  raw.shots.push({ id: "hero2", kind: "wan", duration_sec: 2, prompt: "another" } as any);
  await settle(w, (await w.create(raw)).id);
  assert.equal(stats.gpuMax, 1);
});

test("a retryable failure is retried, then gives up after three tries", async () => {
  let tries = 0;
  const { adapters } = fakes((id) => { if (id === "hero") { tries++; throw new Retryable("out of memory"); } });
  const w = new ProductionWorker(newStore(), { adapters, dir: tmp(), retryDelayMs: () => 0 });
  const done = await settle(w, (await w.create(rawSpec())).id);
  assert.equal(tries, 3);
  assert.equal(done.state, "failed");
  assert.match(done.error!, /hero: out of memory/);
});

test("a fatal failure fails the production at once, naming the shot", async () => {
  let tries = 0;
  const { adapters } = fakes((id) => { if (id === "intro") { tries++; throw new Fatal("missing_timeline_registry"); } });
  const w = new ProductionWorker(newStore(), { adapters, dir: tmp() });
  const done = await settle(w, (await w.create(rawSpec())).id);
  assert.equal(tries, 1);
  assert.equal(done.state, "failed");
  assert.match(done.error!, /intro: missing_timeline_registry/);
});

test("revise re-renders only the changed shot", async () => {
  const { adapters, stats } = fakes();
  const w = new ProductionWorker(newStore(), { adapters, dir: tmp() });
  const p = await w.create(rawSpec());
  await settle(w, p.id);
  stats.renders.length = 0;
  const r = await w.revise(p.id, rawSpec("a different phone"));
  assert.deepEqual(r.changed, ["hero"]);
  const done = await settle(w, p.id);
  assert.equal(done.state, "ready");
  assert.equal(done.revision, 2);
  assert.deepEqual(stats.renders, ["hero"]);
});

test("a result for a stale revision is ignored", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { adapters } = fakes((id) => (id === "hero" ? gate : undefined));
  const w = new ProductionWorker(newStore(), { adapters, dir: tmp() });
  const p = await w.create(rawSpec());
  await w.tick(); // hero starts and waits
  await w.revise(p.id, rawSpec("revised"));
  release();
  const done = await settle(w, p.id);
  assert.equal(done.revision, 2);
  assert.equal(done.state, "ready");
  const hero = w.productions.shots(p.id).find((s) => s.shotId === "hero")!;
  assert.equal(hero.revision, 2);
});

test("cancel stops the running tool", async () => {
  let aborted = false;
  const { adapters } = fakes((id, signal) => id === "hero" ? new Promise((_, fail) => signal.addEventListener("abort", () => { aborted = true; fail(new Error("cancelled")); })) : undefined);
  const w = new ProductionWorker(newStore(), { adapters, dir: tmp() });
  const p = await w.create(rawSpec());
  await w.tick();
  assert.equal(w.cancel(p.id), true);
  const done = await settle(w, p.id);
  assert.equal(done.state, "cancelled");
  assert.ok(aborted);
});

test("a restart picks up where it left off", async () => {
  const store = newStore();
  const dir = tmp();
  const first = new ProductionWorker(store, { adapters: fakes().adapters, dir });
  const p = await first.create(rawSpec());
  first.productions.claimShot("gpu"); // pretend this one was running when the app quit
  const second = new ProductionWorker(store, { adapters: fakes().adapters, dir });
  assert.equal((await settle(second, p.id)).state, "ready");
});
