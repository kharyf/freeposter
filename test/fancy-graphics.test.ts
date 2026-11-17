import "./isolated-home.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderGraphics } from "../src/edit/fancy/graphics.ts";
import type { PlannedGraphic } from "../src/edit/fancy/plan.ts";
import { probe } from "../src/media.ts";
import { tmp } from "./helpers.ts";

interface Track { running: Record<string, number>; peak: Record<string, number>; calls: Record<string, number> }
const newTrack = (): Track => ({ running: {}, peak: {}, calls: {} });
type Mode = "ok" | "unhealthy" | "throw" | "flaky";
interface Stub { health(): Promise<{ ok: boolean; detail: string }>; render(shot: any, ctx: any): Promise<{ path: string; durationSec: number }>; version: number; kind: string; lane: string }

function stubs(modes: Partial<Record<"remotion" | "hyperframes" | "blender", Mode>> = {}, track?: Track) {
  const make = (name: "remotion" | "hyperframes" | "blender"): Stub => {
    let failed = false;
    return {
      kind: name, lane: "cpu", version: 1,
      health: async () => (modes[name] === "unhealthy" ? { ok: false, detail: "stub detail" } : { ok: true, detail: "" }),
      render: async (shot, ctx) => {
        if (track) {
          track.calls[name] = (track.calls[name] ?? 0) + 1;
          track.running[name] = (track.running[name] ?? 0) + 1;
          track.running.all = (track.running.all ?? 0) + 1;
          track.peak[name] = Math.max(track.peak[name] ?? 0, track.running[name]);
          track.peak.all = Math.max(track.peak.all ?? 0, track.running.all);
          await new Promise((r) => setTimeout(r, 20));
          track.running[name]--;
          track.running.all--;
        }
        if (modes[name] === "throw") throw new Error(`${name} blew up`);
        if (modes[name] === "flaky" && !failed) { failed = true; throw new Error("Webpack config change detected"); }
        const path = join(ctx.dir, "shot.mp4");
        writeFileSync(path, `${shot.kind} ${shot.id}`);
        return { path, durationSec: shot.duration_sec };
      },
    };
  };
  return { remotion: make("remotion"), hyperframes: make("hyperframes"), blender: make("blender") } as any;
}

const G = (template: string, params: Record<string, string | number | boolean>, phrase: string, start = 2, end = 3): PlannedGraphic => ({ start, end, template, params, phrase });
const signal = new AbortController().signal;

test("an unhealthy tool falls back along the chain and notes why", async () => {
  const r = await renderGraphics([G("gold-3d-word", { word: "Gold" }, "gold")], { dir: tmp(), adapters: stubs({ blender: "unhealthy" }), signal });
  assert.equal(r.clips[0].template, "kinetic-words");
  assert.deepEqual(r.notes, ["Blender isn't available (stub detail): 1 graphic made with HyperFrames instead"]);
});

test("a throwing render falls back; everything failing ends at keyword-card", async () => {
  const r = await renderGraphics([G("gold-3d-word", { word: "Gold" }, "gold rush")], {
    dir: tmp(), adapters: stubs({ blender: "throw", hyperframes: "throw" }), signal,
  });
  assert.equal(r.clips[0].template, "keyword-card");
  assert.equal(r.clips[0].durationSec, 1);
  assert.equal(Math.round((await probe(r.clips[0].path)).durationSec), 1);
  assert.deepEqual(r.notes, [
    "Blender couldn't render (blender blew up): 1 graphic made with a keyword card instead",
    "HyperFrames couldn't render (hyperframes blew up): 1 graphic made with a keyword card instead",
  ]);
});

test("Remotion is retried once with no note; a second failure falls back", async () => {
  const pq = G("pull-quote", { quote: "Ship it" }, "ship it");
  const flaky = await renderGraphics([pq], { dir: tmp(), adapters: stubs({ remotion: "flaky" }), signal });
  assert.equal(flaky.clips[0].template, "pull-quote");
  assert.deepEqual(flaky.notes, []);
  const track = newTrack();
  const dead = await renderGraphics([pq], { dir: tmp(), adapters: stubs({ remotion: "throw" }, track), signal });
  assert.equal(track.calls.remotion, 2);
  assert.equal(dead.clips[0].template, "kinetic-words");
  assert.match(dead.notes[0], /^Remotion couldn't render .*: 1 graphic made with HyperFrames instead$/);
});

test("fallback params that do not fit are repaired: text cut on a word, at most four words", async () => {
  const seen: any[] = [];
  const adapters = stubs({ remotion: "unhealthy" });
  const inner = adapters.hyperframes.render;
  adapters.hyperframes.render = async (shot: any, ctx: any) => { seen.push(shot); return inner(shot, ctx); };
  const phrase = "one two three four five six seven eight nine ten eleven twelve";
  const r = await renderGraphics([G("pull-quote", { quote: "q" }, phrase)], { dir: tmp(), adapters, signal });
  assert.equal(r.clips[0].template, "kinetic-words");
  assert.match(seen[0].html, /const P = {"words":"one two three four"};/);
  assert.match(seen[0].html, /one two three four/);
  assert.doesNotMatch(seen[0].html, /five/);
});

test("a long phrase is cut to 40 characters on a word for the keyword card", async () => {
  const phrase = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  const dir = tmp();
  const r = await renderGraphics([G("kinetic-words", { words: "a b" }, phrase)], { dir, adapters: stubs({ hyperframes: "unhealthy" }), signal });
  assert.equal(r.clips[0].template, "keyword-card");
  const ass = readFileSync(r.clips[0].path.replace(/\.mp4$/, ".ass"), "utf8");
  assert.match(ass.replaceAll("\\N", " "), /alpha beta gamma delta epsilon zeta eta\n/);
  assert.doesNotMatch(ass, /theta/);
});

test("renders are cached by template, params, duration, size and adapter version", async () => {
  const dir = tmp();
  const track = newTrack();
  const list = [G("pull-quote", { quote: "Ship it" }, "ship it")];
  const first = await renderGraphics(list, { dir, adapters: stubs({}, track), signal });
  const again = await renderGraphics(list, { dir, adapters: stubs({}, track), signal });
  assert.equal(track.calls.remotion, 1);
  assert.equal(again.clips[0].path, first.clips[0].path);
  await renderGraphics([G("pull-quote", { quote: "Ship it" }, "ship it", 2, 4)], { dir, adapters: stubs({}, track), signal });
  assert.equal(track.calls.remotion, 2);
  const bumped = stubs({}, track);
  bumped.remotion.version = 2;
  await renderGraphics(list, { dir, adapters: bumped, signal });
  assert.equal(track.calls.remotion, 3);
});

test("Blender renders one at a time, others up to two in parallel", async () => {
  const track = newTrack();
  const list = [
    ...[1, 2, 3].map((n) => G("gold-3d-word", { word: `Gold${n}` }, "gold")),
    ...[1, 2, 3, 4].map((n) => G("pull-quote", { quote: `Quote ${n}` }, "quote")),
  ];
  let last = 0;
  const r = await renderGraphics(list, { dir: tmp(), adapters: stubs({}, track), signal, onProgress: (f) => { last = f; } });
  assert.equal(r.clips.length, 7);
  assert.equal(track.peak.blender, 1);
  assert.equal(track.peak.remotion, 2);
  assert.equal(last, 1);
  assert.deepEqual(r.clips.map((c) => c.template), [...Array(3).fill("gold-3d-word"), ...Array(4).fill("pull-quote")]);
});

test("notes group graphics per tool", async () => {
  const r = await renderGraphics(
    [G("gold-3d-word", { word: "A" }, "a"), G("gold-3d-word", { word: "B" }, "b")],
    { dir: tmp(), adapters: stubs({ blender: "unhealthy" }), signal },
  );
  assert.deepEqual(r.notes, ["Blender isn't available (stub detail): 2 graphics made with HyperFrames instead"]);
});
