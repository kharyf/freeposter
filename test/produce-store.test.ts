import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductionSpec } from "../src/produce/spec.ts";
import { ProductionStore, type ShotPlan } from "../src/produce/store.ts";
import { newStore } from "./helpers.ts";

const spec = (prompt = "a"): ProductionSpec => ({
  version: 1, title: "t", transitions: { default: { type: "cut", sec: 0 } }, audio: { voiceover: null }, sfx: [], captions: { source: "none" }, post: null,
  shots: [
    { id: "a", kind: "wan", duration_sec: 2, prompt, negative_prompt: "", image: null, seed: 1 },
    { id: "b", kind: "hyperframes", duration_sec: 2, html: "<html></html>", assets: [] },
  ],
});
const plan = (prompt = "a"): ShotPlan[] => [
  { shotId: "a", kind: "wan", lane: "gpu", inputKey: `wan-${prompt}` },
  { shotId: "b", kind: "hyperframes", lane: "cpu", inputKey: "hf-1" },
];

test("create makes one queued shot per shot, at revision 1", () => {
  const ps = new ProductionStore(newStore());
  const p = ps.create(spec(), plan());
  assert.equal(p.state, "queued");
  assert.equal(p.revision, 1);
  assert.deepEqual(ps.shots(p.id).map((s) => [s.shotId, s.state, s.lane, s.revision]), [["a", "queued", "gpu", 1], ["b", "queued", "cpu", 1]]);
  assert.equal(ps.get(p.id)!.spec.shots[0].id, "a");
});

test("claimShot takes the oldest queued shot of a lane and marks it running", () => {
  const ps = new ProductionStore(newStore());
  const p1 = ps.create(spec(), plan());
  ps.create(spec(), plan());
  const s = ps.claimShot("gpu")!;
  assert.equal(s.productionId, p1.id);
  assert.equal(s.state, "running");
  assert.equal(s.attempts, 1);
  assert.equal(ps.get(p1.id)!.state, "rendering");
  assert.equal(ps.claimShot("cpu")!.shotId, "b");
});

test("a shot waiting to retry is not claimed before its time", () => {
  const ps = new ProductionStore(newStore());
  ps.create(spec(), plan());
  const s = ps.claimShot("gpu")!;
  ps.finishShot(s.id, { state: "queued", nextTryAt: Date.now() + 60_000, error: "out of memory" });
  assert.equal(ps.claimShot("gpu"), undefined);
});

test("revise bumps the revision, re-queues changed shots and keeps finished unchanged ones", () => {
  const ps = new ProductionStore(newStore());
  const p = ps.create(spec(), plan());
  for (const lane of ["gpu", "cpu"] as const) {
    const s = ps.claimShot(lane)!;
    ps.finishShot(s.id, { state: "done", outputPath: `/out/${s.shotId}.mp4`, durationSec: 2 });
  }
  ps.setState(p.id, { state: "ready", outputPath: "/final.mp4" });
  const rev = ps.revise(p.id, spec("b"), plan("b"), ["a"]);
  assert.equal(rev, 2);
  const shots = ps.shots(p.id);
  assert.deepEqual(shots.map((s) => [s.shotId, s.state, s.revision, s.outputPath]), [["a", "queued", 2, null], ["b", "done", 2, "/out/b.mp4"]]);
  const after = ps.get(p.id)!;
  assert.equal(after.state, "queued");
  assert.equal(after.outputPath, null);
  assert.equal(after.spec.shots[0].kind === "wan" && after.spec.shots[0].prompt, "b");
});

test("restart requeues running shots and unfinished assembly", () => {
  const store = newStore();
  const ps = new ProductionStore(store);
  const p = ps.create(spec(), plan());
  ps.claimShot("gpu");
  ps.setState(p.id, { state: "assembling" });
  ps.requeueInterrupted();
  assert.ok(ps.shots(p.id).every((s) => s.state === "queued"));
  assert.equal(ps.get(p.id)!.state, "rendering");
});

test("cancel stops a production, but not once approved", () => {
  const ps = new ProductionStore(newStore());
  const a = ps.create(spec(), plan());
  assert.equal(ps.cancel(a.id), true);
  assert.equal(ps.get(a.id)!.state, "cancelled");
  assert.ok(ps.shots(a.id).every((s) => s.state === "cancelled"));
  assert.equal(ps.claimShot("gpu"), undefined);
  const b = ps.create(spec(), plan());
  ps.setState(b.id, { state: "ready" });
  ps.approve(b.id, 7);
  assert.equal(ps.get(b.id)!.state, "approved");
  assert.equal(ps.get(b.id)!.postId, 7);
  assert.equal(ps.cancel(b.id), false);
  assert.equal(ps.revise(b.id, spec(), plan(), []), null);
});

test("the shot cache remembers renders by input key", () => {
  const ps = new ProductionStore(newStore());
  assert.equal(ps.cached("k"), undefined);
  ps.putCache("k", "/cache/k.mp4", 3);
  assert.deepEqual(ps.cached("k"), { path: "/cache/k.mp4", durationSec: 3 });
});
