import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { probe, specProblems } from "../src/media.ts";
import { assemble } from "../src/produce/assemble.ts";
import { sfxLibrary } from "../src/produce/sfx.ts";
import type { ProductionSpec } from "../src/produce/spec.ts";
import { makeVideo, tmp } from "./helpers.ts";

let dir: string;
let a: string; // 2 s with sound
let b: string; // 2 s silent, landscape
let tone: string; // 5 s of sound
before(() => {
  dir = tmp();
  a = makeVideo(dir, "a.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  b = makeVideo(dir, "b.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  tone = makeVideo(dir, "tone.wav", ["-f", "lavfi", "-i", "sine=frequency=220", "-t", "5"]);
});

const spec = (over: Partial<ProductionSpec> = {}): ProductionSpec => ({
  version: 1, title: "", shots: [], transitions: { default: { type: "cut", sec: 0 } }, audio: { voiceover: null }, sfx: [], captions: { source: "none" }, post: null, ...over,
});
const outs = () => {
  const d = tmp();
  return { final: join(d, "final.mp4"), preview: join(d, "preview.mp4"), thumb: join(d, "thumb.jpg") };
};

test("two shots with a 0.5 s crossfade make one 3.5 s platform-ready video, a preview and a thumbnail", async () => {
  const o = outs();
  const s = spec({ shots: [{ id: "a", kind: "file", path: a, trim: null }, { id: "b", kind: "file", path: b, trim: null }], transitions: { default: { type: "cut", sec: 0 }, "a->b": { type: "crossfade", sec: 0.5 } } });
  const r = await assemble([{ path: a, durationSec: 2 }, { path: b, durationSec: 2 }], s, o, { sfxPath: () => "" });
  assert.ok(Math.abs(r.durationSec - 3.5) < 0.1, `got ${r.durationSec}`);
  const final = await probe(o.final);
  assert.deepEqual(specProblems(final), []);
  const preview = await probe(o.preview);
  assert.equal(`${preview.width}x${preview.height}`, "540x960");
  assert.ok(existsSync(o.thumb));
});

test("cuts join end to end, shots are trimmed to their length", async () => {
  const o = outs();
  const r = await assemble([{ path: a, durationSec: 1.5 }, { path: b, durationSec: 2 }], spec(), o, { sfxPath: () => "" });
  assert.ok(Math.abs(r.durationSec - 3.5) < 0.1, `got ${r.durationSec}`);
});

test("a voiceover longer than the video is cut to the video, and sfx cues mix in", async () => {
  const o = outs();
  const s = spec({ audio: { voiceover: tone }, sfx: [{ name: "whoosh", at_sec: 1, gain_db: -6 }] });
  const r = await assemble([{ path: b, durationSec: 2 }], s, o, { sfxPath: (n) => (n === "whoosh" ? tone : "") });
  assert.ok(Math.abs(r.durationSec - 2) < 0.1, `got ${r.durationSec}`);
  const final = await probe(o.final);
  assert.ok(final.hasAudio);
  assert.ok(Math.abs(final.durationSec - 2) < 0.15);
});

test("the SFX library lists sound files by their path without extension", () => {
  const lib = tmp();
  mkdirSync(join(lib, "hits"));
  writeFileSync(join(lib, "whoosh.wav"), "");
  writeFileSync(join(lib, "hits", "boom.mp3"), "");
  writeFileSync(join(lib, "notes.txt"), "");
  assert.deepEqual(sfxLibrary(lib).map((s) => s.name).sort(), ["hits/boom", "whoosh"]);
});
