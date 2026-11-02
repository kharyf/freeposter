import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { probe, render, specProblems } from "../src/media.ts";
import { renderEdit } from "../src/edit/render.ts";
import { DEFAULT_EDIT, editKey, parseEditSettings, type EditSettings } from "../src/edit/settings.ts";
import { landscape60, makeVideo, sha256, tmp, verticalSilent } from "./helpers.ts";

const OFF: EditSettings = { tighten: false, captions: false, reframe: false, audio: false, punchIn: false };
const words = [{ text: "a", start: 0.2, end: 0.6 }, { text: "b", start: 4.0, end: 4.5 }];

test("tightened edit is shorter and passes render spec", async () => {
  const dir = tmp();
  const src = landscape60(dir, 6);
  const settings = { ...DEFAULT_EDIT, reframe: false };
  const progress: number[] = [];
  const out = await renderEdit(src, { words, language: null }, settings, join(dir, "edit.mp4"), (f) => progress.push(f));
  assert.ok(out.durationSec < 2, `edited ${out.durationSec}s`);
  assert.ok(existsSync(out.path));
  const r = await render(out.path, editKey(sha256(src), settings), dir);
  assert.deepEqual(specProblems(r.probe), []);
  assert.ok(progress.length > 0 && progress.every((f) => f >= 0 && f <= 1));
});

test("edit with everything off keeps duration", async () => {
  const dir = tmp();
  const out = await renderEdit(landscape60(dir, 6), { words, language: null }, OFF, join(dir, "edit.mp4"));
  assert.ok(Math.abs(out.durationSec - 6) < 0.2, `${out.durationSec}`);
  const p = await probe(out.path);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
});

test("silent source gets audio", async () => {
  const dir = tmp();
  const out = await renderEdit(verticalSilent(dir, 4), { words: [], language: null }, DEFAULT_EDIT, join(dir, "edit.mp4"));
  const r = await render(out.path, "silent-edit", dir);
  assert.equal(r.probe.hasAudio, true);
  assert.ok(Math.abs(out.durationSec - 4) < 0.2, "no words: nothing is cut");
});

test("captions burn into the picture", async () => {
  const dir = tmp();
  const src = verticalSilent(dir, 2);
  const capWords = [{ text: "HELLO", start: 0.1, end: 1.9 }];
  const withCaps = await renderEdit(src, { words: capWords, language: null }, { ...OFF, captions: true }, join(dir, "caps.mp4"));
  const without = await renderEdit(src, { words: capWords, language: null }, OFF, join(dir, "plain.mp4"));
  const frame = (p: string) => execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", p, "-frames:v", "1", "-vf", "crop=1080:300:0:1200", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  assert.notDeepEqual(frame(withCaps.path), frame(without.path));
});

test("editKey changes with settings and is stable", () => {
  const a = editKey("abc", { tighten: true, captions: true, reframe: true, audio: true, punchIn: true });
  const b = editKey("abc", { punchIn: true, audio: true, reframe: true, captions: true, tighten: true });
  assert.equal(a, b);
  assert.notEqual(a, editKey("abc", { ...DEFAULT_EDIT, punchIn: false }));
  assert.match(a, /^abc-[0-9a-f]{16}$/);
});

test("parseEditSettings fills defaults and rejects unknown keys", () => {
  assert.deepEqual(parseEditSettings(undefined), DEFAULT_EDIT);
  assert.deepEqual(parseEditSettings({ punchIn: false }), { ...DEFAULT_EDIT, punchIn: false });
  assert.throws(() => parseEditSettings({ music: true }), /music/);
  assert.throws(() => parseEditSettings({ tighten: "yes" }), /tighten/);
});

test("loudness near -14 LUFS", async () => {
  const dir = tmp();
  const out = await renderEdit(landscape60(dir, 6), { words: [], language: null }, { ...OFF, audio: true }, join(dir, "loud.mp4"));
  const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", out.path, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  const lufs = Number(stderr.match(/I:\s+(-?[\d.]+) LUFS/g)!.at(-1)!.match(/-?[\d.]+/)![0]);
  assert.ok(lufs > -16 && lufs < -12, `integrated loudness ${lufs}`);
});

const faceModel = join(import.meta.dirname, "..", "data", "models", "ultraface-rfb-320.onnx");
test("reframed edit fills the frame instead of letterboxing", { skip: !existsSync(faceModel) && "face model not downloaded" }, async () => {
  const dir = tmp();
  const src = makeVideo(dir, "face.mp4", [
    "-f", "lavfi", "-i", "color=c=gray:size=1920x1080:rate=30",
    "-loop", "1", "-i", join(import.meta.dirname, "fixtures", "face.jpg"),
    "-filter_complex", "[0:v][1:v]overlay=1400:300,format=yuv420p", "-t", "2", "-c:v", "libx264",
  ]);
  const out = await renderEdit(src, { words: [], language: null }, { ...OFF, reframe: true }, join(dir, "rf.mp4"));
  // A letterboxed 16:9 frame is black in its top 600 rows; the reframed one is not.
  const top = execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", out.path, "-frames:v", "1", "-vf", "crop=1080:100:0:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const mean = top.reduce((n, b) => n + b, 0) / top.length;
  assert.ok(mean > 40, `top strip mean brightness ${mean}`);
});
