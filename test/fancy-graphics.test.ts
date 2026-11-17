import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { pruneGraphicsCache, renderGraphics } from "../src/edit/fancy/graphics.ts";
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
  assert.equal(r.clips[0]!.template, "kinetic-words");
  assert.deepEqual(r.notes, ["Blender isn't available (stub detail): 1 graphic made with HyperFrames instead"]);
});

test("a throwing render falls back; everything failing ends at keyword-card", async () => {
  const r = await renderGraphics([G("gold-3d-word", { word: "Gold" }, "gold rush")], {
    dir: tmp(), adapters: stubs({ blender: "throw", hyperframes: "throw" }), signal,
  });
  assert.equal(r.clips[0]!.template, "keyword-card");
  assert.equal(r.clips[0]!.durationSec, 1);
  assert.equal(Math.round((await probe(r.clips[0]!.path)).durationSec), 1);
  assert.deepEqual(r.notes, [
    "Blender couldn't render (blender blew up): 1 graphic made with a keyword card instead",
    "HyperFrames couldn't render (hyperframes blew up): 1 graphic made with a keyword card instead",
  ]);
});

test("Remotion is retried once with no note; a second failure falls back", async () => {
  const pq = G("pull-quote", { quote: "Ship it" }, "ship it");
  const flaky = await renderGraphics([pq], { dir: tmp(), adapters: stubs({ remotion: "flaky" }), signal });
  assert.equal(flaky.clips[0]!.template, "pull-quote");
  assert.deepEqual(flaky.notes, []);
  const track = newTrack();
  const dead = await renderGraphics([pq], { dir: tmp(), adapters: stubs({ remotion: "throw" }, track), signal });
  assert.equal(track.calls.remotion, 2);
  assert.equal(dead.clips[0]!.template, "kinetic-words");
  assert.match(dead.notes[0], /^Remotion couldn't render .*: 1 graphic made with HyperFrames instead$/);
});

test("fallback params that do not fit are repaired: text cut on a word, at most four words", async () => {
  const seen: any[] = [];
  const adapters = stubs({ remotion: "unhealthy" });
  const inner = adapters.hyperframes.render;
  adapters.hyperframes.render = async (shot: any, ctx: any) => { seen.push(shot); return inner(shot, ctx); };
  const quote = "one two three four five six seven eight nine ten eleven twelve";
  const r = await renderGraphics([G("pull-quote", { quote }, "the spoken phrase")], { dir: tmp(), adapters, signal });
  assert.equal(r.clips[0]!.template, "kinetic-words");
  assert.match(seen[0].html, /const P = {"words":"one two three four"};/);
  assert.match(seen[0].html, /one two three four/);
  assert.doesNotMatch(seen[0].html, /five/);
});

test("a graphic with no text of its own falls back to its phrase, cut to 40 characters on a word for the keyword card", async () => {
  const phrase = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  const dir = tmp();
  const r = await renderGraphics([G("kinetic-words", {}, phrase)], { dir, adapters: stubs({ hyperframes: "unhealthy" }), signal });
  assert.equal(r.clips[0]!.template, "keyword-card");
  const ass = readFileSync(r.clips[0]!.path.replace(/\.mp4$/, ".ass"), "utf8");
  assert.match(ass.replaceAll("\\N", " "), /alpha beta gamma delta epsilon zeta eta\n/);
  assert.doesNotMatch(ass, /theta/);
});

test("a fallback keyword card shows the graphic's own words, not the transcript", async () => {
  const r = await renderGraphics([G("kinetic-words", { words: "Small steps compound" }, "and so what I mean is")], { dir: tmp(), adapters: stubs({ hyperframes: "unhealthy" }), signal });
  assert.equal(r.clips[0]!.template, "keyword-card");
  const ass = readFileSync(r.clips[0]!.path.replace(/\.mp4$/, ".ass"), "utf8").replaceAll("\\N", " ");
  assert.match(ass, /Small steps compound/);
  assert.doesNotMatch(ass, /what I mean/);
});

test("renders are cached by template, params, duration, size and adapter version", async () => {
  const dir = tmp();
  const track = newTrack();
  const list = [G("pull-quote", { quote: "Ship it" }, "ship it")];
  const first = await renderGraphics(list, { dir, adapters: stubs({}, track), signal });
  const again = await renderGraphics(list, { dir, adapters: stubs({}, track), signal });
  assert.equal(track.calls.remotion, 1);
  assert.equal(again.clips[0]!.path, first.clips[0]!.path);
  await renderGraphics([G("pull-quote", { quote: "Ship it" }, "ship it", 2, 4)], { dir, adapters: stubs({}, track), signal });
  assert.equal(track.calls.remotion, 2);
  const bumped = stubs({}, track);
  bumped.remotion.version = 2;
  await renderGraphics(list, { dir, adapters: bumped, signal });
  assert.equal(track.calls.remotion, 3);
});

test("Blender and HyperFrames each render one at a time, Remotion up to two in parallel", async () => {
  const track = newTrack();
  const list = [
    ...[1, 2, 3].map((n) => G("gold-3d-word", { word: `Gold${n}` }, "gold")),
    ...[1, 2, 3, 4].map((n) => G("pull-quote", { quote: `Quote ${n}` }, "quote")),
    ...[1, 2, 3].map((n) => G("kinetic-words", { words: `Word ${n}` }, "word")),
  ];
  let last = 0;
  const r = await renderGraphics(list, { dir: tmp(), adapters: stubs({}, track), signal, onProgress: (f) => { last = f; } });
  assert.equal(r.clips.length, 10);
  assert.equal(track.peak.blender, 1);
  assert.equal(track.peak.hyperframes, 1, "HyperFrames refuses a second render while one runs");
  assert.equal(track.peak.remotion, 2);
  assert.equal(last, 1);
  assert.deepEqual(r.clips.map((c) => c!.template), [...Array(3).fill("gold-3d-word"), ...Array(4).fill("pull-quote"), ...Array(3).fill("kinetic-words")]);
});

test("notes group graphics per tool", async () => {
  const r = await renderGraphics(
    [G("gold-3d-word", { word: "A" }, "a"), G("gold-3d-word", { word: "B" }, "b")],
    { dir: tmp(), adapters: stubs({ blender: "unhealthy" }), signal },
  );
  assert.deepEqual(r.notes, ["Blender isn't available (stub detail): 2 graphics made with HyperFrames instead"]);
});

test("identical graphics in one call share a single render and one valid file", async () => {
  const track = newTrack();
  const g = G("pull-quote", { quote: "Ship it" }, "ship it");
  const r = await renderGraphics([g, { ...g }], { dir: tmp(), adapters: stubs({}, track), signal });
  assert.equal(track.calls.remotion, 1);
  assert.equal(r.clips[0]!.path, r.clips[1]!.path);
  assert.ok(readFileSync(r.clips[0]!.path).length > 0);
});

test("a shot.mp4 without its .done marker (a killed render) is not reused", async () => {
  const dir = tmp();
  const track = newTrack();
  const list = [G("pull-quote", { quote: "Ship it" }, "ship it")];
  const first = await renderGraphics(list, { dir, adapters: stubs({}, track), signal });
  const folder = dirname(first.clips[0]!.path);
  rmSync(join(folder, ".done"));
  writeFileSync(first.clips[0]!.path, "half");
  await renderGraphics(list, { dir, adapters: stubs({}, track), signal });
  assert.equal(track.calls.remotion, 2);
  assert.notEqual(readFileSync(first.clips[0]!.path, "utf8"), "half");
  writeFileSync(first.clips[0]!.path, "");
  await renderGraphics(list, { dir, adapters: stubs({}, track), signal });
  assert.equal(track.calls.remotion, 3);
});

test("after a render only the clip and its marker stay: Blender's frames and the tools' project files go", async () => {
  const dir = tmp();
  const adapters = stubs();
  const inner = adapters.blender.render;
  adapters.blender.render = async (shot: any, ctx: any) => {
    mkdirSync(join(ctx.dir, "frames"), { recursive: true });
    writeFileSync(join(ctx.dir, "frames", "0001.png"), "frame");
    writeFileSync(join(ctx.dir, "params.json"), "{}");
    return inner(shot, ctx);
  };
  const r = await renderGraphics([G("gold-3d-word", { word: "Gold" }, "gold")], { dir, adapters, signal });
  assert.deepEqual(readdirSync(dirname(r.clips[0]!.path)).sort(), [".done", "shot.mp4"]);
});

test("a cached graphic's use is marked, and graphics unused for 14 days are pruned", async () => {
  const dir = tmp();
  const list = [G("pull-quote", { quote: "Ship it" }, "ship it")];
  const first = await renderGraphics(list, { dir, adapters: stubs(), signal });
  const folder = dirname(first.clips[0]!.path);
  const marker = join(folder, ".done");
  const longAgo = new Date(Date.now() - 20 * 86_400_000);
  utimesSync(marker, longAgo, longAgo);
  await renderGraphics(list, { dir, adapters: stubs(), signal });
  assert.ok(Date.now() - statSync(marker).mtimeMs < 60_000, "the cache hit touched .done");

  // An old finished graphic, an old unfinished one (no .done) and a fresh one.
  const old = join(dir, "old"), stale = join(dir, "stale");
  for (const d of [old, stale]) mkdirSync(d);
  writeFileSync(join(old, "shot.mp4"), "x");
  writeFileSync(join(old, ".done"), "");
  utimesSync(join(old, ".done"), longAgo, longAgo);
  utimesSync(stale, longAgo, longAgo);
  assert.equal(pruneGraphicsCache(dir), 2);
  assert.ok(!existsSync(old) && !existsSync(stale));
  assert.ok(existsSync(first.clips[0]!.path), "the graphic just used stays");
  assert.equal(pruneGraphicsCache(join(dir, "missing")), 0);
  // 15 days on, it too is pruned.
  assert.equal(pruneGraphicsCache(dir, Date.now() + 15 * 86_400_000), 1);
  assert.ok(!existsSync(folder));
});

test("a graphic not even the keyword card can make is left out with a note, not failing the rest", async () => {
  const ffmpeg = config.ffmpeg;
  (config as any).ffmpeg = join(tmp(), "no-ffmpeg-here.exe");
  try {
    const r = await renderGraphics(
      [G("pull-quote", { quote: "Ship it" }, "ship it"), G("kinetic-words", { words: "Go" }, "go")],
      { dir: tmp(), adapters: stubs({ hyperframes: "throw" }), signal },
    );
    assert.equal(r.clips[0]!.template, "pull-quote");
    assert.equal(r.clips[1], null);
    assert.ok(r.notes.includes("graphic 2 couldn't be made: its split plays full frame"), r.notes.join("; "));
    assert.ok(!r.notes.some((n) => /made with a keyword card/.test(n)), r.notes.join("; "));
  } finally {
    (config as any).ffmpeg = ffmpeg;
  }
});

test("a render waiting for its lane doesn't start once the edit is cancelled", async () => {
  const ctl = new AbortController();
  const track = newTrack();
  const adapters = stubs({}, track);
  const inner = adapters.blender.render;
  adapters.blender.render = async (shot: any, ctx: any) => {
    const out = await inner(shot, ctx);
    ctl.abort();
    return out;
  };
  const run = renderGraphics([G("gold-3d-word", { word: "One" }, "a"), G("gold-3d-word", { word: "Two" }, "b")], { dir: tmp(), adapters, signal: ctl.signal });
  await assert.rejects(run);
  assert.equal(track.calls.blender, 1, "the second Blender render, queued behind the first, never started");
});
