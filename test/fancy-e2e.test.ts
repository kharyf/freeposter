// The whole Fancy edit, end to end: a talking clip goes in, a ready 1080x1920 edit with notes and a cover comes out.
// The AI and the graphics tools are stand-ins (each writes a real 1080x960 clip); planning, beats, the composite and
// the cover are the real ones.
import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { probe } from "../src/media.ts";
import { EditWorker } from "../src/edit/worker.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { makeVideo, newStore, sha256, tmp, verticalSilent } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const FANCY = { ...DEFAULT_EDIT, look: "fancy" as const };

/** speech.ogg (9 s) over face.jpg, padded with silence to a 12 s portrait clip. */
function talkingClip(dir: string) {
  return makeVideo(dir, "talking.mp4", [
    "-loop", "1", "-framerate", "30", "-i", join(FIXTURES, "face.jpg"),
    "-i", join(FIXTURES, "speech.ogg"),
    "-filter_complex", "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,format=yuv420p[v];[1:a]apad[a]",
    "-map", "[v]", "-map", "[a]", "-t", "12", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac",
  ]);
}

// What Whisper would hear: a line every few seconds across the 12 s.
const SCRIPT = [
  "Here is the one secret nobody tells you.",
  "Post every single day for ninety days.",
  "Your views grow three times faster.",
  "Start small and keep going every week.",
];
const WORDS = (() => {
  const out: { text: string; start: number; end: number }[] = [];
  let t = 0.2;
  for (const line of SCRIPT) {
    for (const text of line.split(" ")) {
      out.push({ text, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) });
      t += 0.36;
    }
    t += 0.25;
  }
  return out;
})();
const at = (text: string) => WORDS.find((w) => w.text.replace(/\W/g, "").toLowerCase() === text)!;

const GOOD_PLAN = {
  graphics: [
    { start: at("post").start, end: at("days").end, template: "kinetic-words", params: { words: "Post every day" } },
    { start: at("your").start, end: at("faster").end, template: "stat-counter", params: { value: 3, suffix: "x", label: "faster growth" } },
    { start: at("start").start, end: at("week").end, template: "pull-quote", params: { quote: "Start small" } },
  ],
  emphasis: [at("ninety").start, at("three").start],
  cover: { title: "The one secret", at: at("secret").start },
};

/** Graphics tools that each write a real opaque 1080x960 clip. */
function tools() {
  const make = (kind: string) => ({
    kind, lane: "cpu", version: 1,
    health: async () => ({ ok: true, detail: "" }),
    render: async (shot: any, ctx: any) => ({
      path: makeVideo(ctx.dir, "shot.mp4", ["-f", "lavfi", "-i", "color=c=0x14110F:size=1080x960:rate=30", "-t", String(shot.duration_sec), "-c:v", "libx264", "-pix_fmt", "yuv420p"]),
      durationSec: shot.duration_sec,
    }),
  });
  return { remotion: make("remotion"), hyperframes: make("hyperframes"), blender: make("blender") } as any;
}

/** Runs fn, returning the lines it logged with console.log. */
async function logged(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await fn(); } finally { console.log = original; }
  return lines;
}

test("end to end: a Fancy edit of a short talking clip", async () => {
  const clip = talkingClip(tmp());
  let asked = 0;
  const store = newStore();
  const worker = new EditWorker(store, {
    dir: tmp(), findLyrics: async () => [], transcribe: async () => ({ words: WORDS, language: "en" }),
    fancy: { ask: async () => { asked++; return GOOD_PLAN as any; }, adapters: tools(), faceTrack: async () => null },
  });
  const edit = store.createEdit(clip, sha256(clip), { ...FANCY, tighten: false });
  const lines = await logged(async () => { await worker.tick(); });
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.equal(asked, 1);
  const out = await probe(done.outputPath!);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1920);
  assert.ok(Math.abs(out.durationSec - 12) < 0.5, `edited ${out.durationSec}`);
  assert.ok(done.cover && existsSync(done.cover.path), "a cover");
  assert.equal(done.cover!.atSec, GOOD_PLAN.cover.at);
  assert.deepEqual(done.notes, [], "the plan was used as planned, every graphic rendered");
  assert.deepEqual(lines.filter((l) => /cadence:/.test(l)), [], "no cadence problems");
  assert.ok(lines.some((l) => /ready \(/.test(l)), lines.join("\n"));
});

test("end to end: a Fancy edit with no speech", async () => {
  const silent = verticalSilent(tmp(), 6);
  const store = newStore();
  const worker = new EditWorker(store, {
    dir: tmp(), findLyrics: async () => [], transcribe: async () => ({ words: [], language: null }),
    fancy: { ask: async () => { throw new Error("no AI provider is connected"); }, adapters: tools(), faceTrack: async () => null },
  });
  const edit = store.createEdit(silent, sha256(silent), FANCY);
  await logged(async () => { await worker.tick(); });
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.ok(existsSync(done.outputPath!));
  const out = await probe(done.outputPath!);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1920);
  assert.ok(done.notes.some((n) => /no AI|no speech/.test(n)), done.notes.join("; "));
});
