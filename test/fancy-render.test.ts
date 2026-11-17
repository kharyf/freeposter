import "./isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planBeats, type Beat } from "../src/edit/fancy/beats.ts";
import { coverAss, coverLayout, makeCover } from "../src/edit/fancy/cover.ts";
import { renderKeywordCard } from "../src/edit/fancy/keyword-card.ts";
import { fancyFontDir } from "../src/edit/fancy/palette.ts";
import { beatCrops, beatGraph, beatSource, fancyFilterGraph, renderFancy, tileBeats } from "../src/edit/fancy/render.ts";
import { probe } from "../src/media.ts";
import { DEFAULT_EDIT, type EditSettings } from "../src/edit/settings.ts";
import { imageKind } from "../src/edit/styles.ts";
import { filterPath } from "../src/edit/transcribe.ts";
import { landscape60, makeVideo, tmp } from "./helpers.ts";

const FANCY: EditSettings = { ...DEFAULT_EDIT, look: "fancy" };

/** One RGB pixel of the frame at `t` seconds. */
function pixel(path: string, t: number, x: number, y: number): [number, number, number] {
  const out = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [out[0], out[1], out[2]];
}
const isRed = ([r, g, b]: number[]) => r > 180 && g < 70 && b < 70;
const isBlue = ([r, g, b]: number[]) => b > 180 && r < 70 && g < 70;

const beat = (start: number, end: number, layout: Beat["layout"], graphic: number | null, extra: Partial<Beat> = {}): Beat =>
  ({ start, end, layout, graphic, graphicOffset: 0, zoom: 1, pushPerSec: 0, snapAt: null, ...extra });

test("a Fancy render is 1080x1920 at 30 fps with the edited duration", async () => {
  const dir = tmp();
  const src = landscape60(dir, 6);
  const segments = [{ start: 0, end: 2.5 }, { start: 3, end: 6 }];
  const edited = 5.5;
  const clips = await Promise.all([0, 1].map(async (i) => ({
    ...(await renderKeywordCard(i ? "second card" : "first card", 2, join(dir, `card${i}.mp4`))), template: "keyword-card",
  })));
  const words = [{ text: "one", start: 0.2, end: 0.6 }, { text: "two", start: 1.7, end: 2.2 }, { text: "three", start: 4.0, end: 4.4 }];
  const beats = planBeats({
    durationSec: edited, words,
    graphics: [
      { start: 1.6, end: 3.6, template: "keyword-card", params: {}, phrase: "first card" },
      { start: 3.6, end: 5.5, template: "keyword-card", params: {}, phrase: "second card" },
    ],
    emphasis: [1.7], cutTimes: [2.5], punchIn: true,
  });
  assert.ok(beats.some((b) => b.layout !== "full"), "the plan has splits");
  const progress: number[] = [];
  const faces = [{ t: 0, cx: 1200, cy: 500, size: 300 }, { t: 6, cx: 900, cy: 520, size: 300 }];
  const out = await renderFancy(src, {
    segments, beats, clips, faces, captionWords: words, settings: FANCY, outPath: join(dir, "fancy.mp4"), onProgress: (f) => progress.push(f),
  });
  const p = await probe(out.path);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.ok(Math.abs(p.fps - 30) < 0.01, `${p.fps} fps`);
  assert.ok(Math.abs(p.durationSec - edited) < 0.1, `${p.durationSec}s, edited ${edited}s`);
  assert.ok(Math.abs(out.durationSec - p.durationSec) < 1e-6);
  assert.equal(p.hasAudio, true);
  assert.ok(progress.length > 0 && progress.every((f) => f >= 0 && f <= 1) && progress.at(-1) === 1);
});

test("picture and sound stay the edited length across many cuts", async () => {
  const dir = tmp();
  const src = landscape60(dir, 6);
  // Eight cuts, each 5 ms past a frame: joined naively, every segment's sound is padded out to a whole frame.
  const segments = Array.from({ length: 8 }, (_, i) => ({ start: i * 0.7, end: i * 0.7 + 0.505 }));
  const edited = 8 * 0.505;
  const out = await renderFancy(src, {
    // Sound cleanup off: after loudnorm the AAC encoder pads the tail a little, which is not drift.
    segments, beats: [beat(0, edited, "full", null)], clips: [], faces: null, captionWords: null, settings: { ...FANCY, audio: false }, outPath: join(dir, "cuts.mp4"),
  });
  const lens = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", out.path], { encoding: "utf8" })
    .trim().split(/\r?\n/).map((l) => l.split(","));
  const of = (kind: string) => Number(lens.find(([k]) => k === kind)![1]);
  assert.ok(Math.abs(of("video") - edited) < 1 / 30, `video ${of("video")}s, edited ${edited}s`);
  assert.ok(Math.abs(of("audio") - edited) < 0.03, `audio ${of("audio")}s, edited ${edited}s`);
});

test("split beats stack speaker and graphic in the beat's order", async () => {
  const dir = tmp();
  const src = makeVideo(dir, "blue.mp4", ["-f", "lavfi", "-i", "color=c=blue:size=1080x1920:rate=30", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  // 2 s of red: both split beats run past it, so the clip must hold its last frame.
  const red = makeVideo(dir, "red.mp4", ["-f", "lavfi", "-i", "color=c=red:size=1080x960:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const clips = [{ path: red, durationSec: 2, template: "keyword-card" }, { path: red, durationSec: 2, template: "keyword-card" }];
  const beats = [
    beat(0, 2, "full", null),
    beat(2, 4.5, "speakerBottom", 0, { graphicOffset: 0.5 }),
    beat(4.5, 6, "speakerTop", 1, { zoom: 1.12, pushPerSec: 0.025, snapAt: 5 }),
  ];
  const out = await renderFancy(src, {
    segments: [{ start: 0, end: 6 }], beats, clips, faces: null, captionWords: null, settings: FANCY, outPath: join(dir, "split.mp4"),
  });
  assert.ok(isBlue(pixel(out.path, 1, 540, 480)) && isBlue(pixel(out.path, 1, 540, 1440)), "full beat is all speaker");
  assert.ok(isRed(pixel(out.path, 4.2, 540, 480)), "speakerBottom: graphic on top (held past its end)");
  assert.ok(isBlue(pixel(out.path, 4.2, 540, 1440)), "speakerBottom: speaker below");
  assert.ok(isBlue(pixel(out.path, 5.5, 540, 480)), "speakerTop: speaker on top");
  assert.ok(isRed(pixel(out.path, 5.5, 540, 1440)), "speakerTop: graphic below");
  const [r, g, b] = pixel(out.path, 3, 540, 960);
  assert.ok(r > 180 && g > 140 && b < 90, `gold seam, got ${[r, g, b]}`);
});

test("a split beat whose graphic clip is missing renders full frame", async () => {
  const dir = tmp();
  const src = makeVideo(dir, "blue.mp4", ["-f", "lavfi", "-i", "color=c=blue:size=1080x1920:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const out = await renderFancy(src, {
    segments: [{ start: 0, end: 3 }], beats: [beat(0, 1, "full", null), beat(1, 3, "speakerBottom", 4)], clips: [], faces: null,
    captionWords: null, settings: FANCY, outPath: join(dir, "missing.mp4"),
  });
  assert.ok(isBlue(pixel(out.path, 2, 540, 480)) && isBlue(pixel(out.path, 2, 540, 960)), "no graphic, no seam");
  assert.ok(Math.abs(out.durationSec - 3) < 0.1);
});

test("the filter graph loads the Fancy fonts directory", () => {
  const ass = String.raw`C:\tmp\caps.ass`;
  const graph = fancyFilterGraph({ segments: [{ start: 0, end: 2 }], settings: FANCY, audioIn: "[1:a:0]", hasAudio: true, ass });
  assert.match(graph, /ass=filename=.*:fontsdir=/);
  assert.ok(graph.includes(`ass=filename=${filterPath(ass)}:fontsdir=${filterPath(fancyFontDir())}`));
  assert.doesNotMatch(fancyFilterGraph({ segments: [{ start: 0, end: 2 }], settings: FANCY, audioIn: "[1:a:0]", hasAudio: true, ass: null }), /ass=/);
});

test("a beat's graph reads only the source around it and keys its crop from a script", () => {
  const segments = [{ start: 0, end: 4 }, { start: 10, end: 20 }];
  // Edited 5-7 s is source 11-13 s.
  const from = beatSource(segments, { start: 5, end: 7 });
  assert.ok(from.seek <= 11 - 0.2 && from.seek >= 9, `seek ${from.seek}`);
  assert.ok(from.seek + from.duration >= 13.2 && from.seek + from.duration <= 15, `to ${from.seek + from.duration}`);
  assert.deepEqual(from.parts.map((p) => p.seg), [segments[1]]);
  const cmds = String.raw`C:\tmp\b0.cmd`;
  const graph = beatGraph({ start: 5, end: 7, layout: "speakerTop", crop: { x: 0, y: 0, w: 1620, h: 1440 }, cmds, graphic: { offset: 1, padSec: 0.5 } }, from, { width: 1620, height: 2880 });
  assert.ok(graph.includes(`sendcmd=f=${filterPath(cmds)},crop@c=`));
  assert.match(graph, /\[p\]\[q\]vstack/, "speakerTop puts the speaker first");
  assert.match(graph, /tpad=stop_mode=clone/);
});

test("a beat's crop pushes in smoothly and snaps 10% over 6 frames from snapAt", () => {
  const b = beat(1, 2, "full", null, { zoom: 1.18, pushPerSec: 0.025, snapAt: 1.5 });
  const crops = beatCrops(b, { segments: [{ start: 0, end: 3 }], faces: null, src: { width: 1620, height: 2880 } });
  assert.equal(crops.length, 30, "one crop per output frame");
  // Widths only ever shrink (the push), never jump back.
  for (let i = 1; i < crops.length; i++) assert.ok(crops[i].w <= crops[i - 1].w, `frame ${i}: ${crops[i - 1].w} -> ${crops[i].w}`);
  const at = (t: number) => crops[Math.round((t - 1) * 30)];
  const zoomOf = (c: { w: number }) => 1620 / c.w;
  assert.ok(Math.abs(zoomOf(crops[0]) - 1.18) < 0.005);
  // Just before the snap: zoom * push; six frames after: another 10% on top.
  const before = zoomOf(at(1.5));
  const after = zoomOf(at(1.5 + 6 / 30));
  assert.ok(Math.abs(after / before - 1.1 * (1 + 0.025 * 0.7) / (1 + 0.025 * 0.5)) < 0.01, `${before} -> ${after}`);
  // Aspect stays 9:16 and the crop stays centred without a face.
  for (const c of crops) {
    assert.ok(Math.abs(c.w / c.h - 9 / 16) < 0.003);
    assert.ok(Math.abs(c.x + c.w / 2 - 810) <= 1);
  }
});

test("crops follow the face through the cut (source timeline)", () => {
  // Edited 0-1 s is source 4-5 s: the face there is on the right.
  const faces = [{ t: 0, cx: 300, cy: 540, size: 200 }, { t: 3.5, cx: 300, cy: 540, size: 200 }, { t: 4, cx: 1600, cy: 540, size: 200 }, { t: 6, cx: 1600, cy: 540, size: 200 }];
  const crops = beatCrops(beat(0, 1, "full", null), { segments: [{ start: 4, end: 6 }], faces, src: { width: 1920, height: 1080 } });
  for (const c of crops) assert.ok(c.x <= 1600 && 1600 <= c.x + c.w, `face at 1600 outside ${c.x}..${c.x + c.w}`);
});

test("the cover is a 1080x1920 JPEG", async () => {
  const dir = tmp();
  const src = landscape60(dir, 4);
  const p = await makeCover(src, { at: 1, segments: [{ start: 0, end: 1 }, { start: 2, end: 4 }], faces: null, title: "Why nobody watches your videos", out: join(dir, "cover.jpg") });
  assert.equal(imageKind(readFileSync(p)), "jpg");
  const info = await probe(p).catch(() => null);
  const { width, height } = info ?? { width: 0, height: 0 };
  assert.equal(width, 1080);
  assert.equal(height, 1920);
  const plain = await makeCover(src, { at: 1, segments: [{ start: 0, end: 4 }], faces: null, title: "", out: join(dir, "plain.jpg") });
  assert.equal(imageKind(readFileSync(plain)), "jpg");
  // The ink gradient darkens the top; the title (yellow) shows there only when there is one.
  const top = (f: string) => execFileSync("ffmpeg", ["-v", "error", "-i", f, "-vf", "crop=1080:300:0:180", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const yellowish = (buf: Buffer) => { let n = 0; for (let i = 0; i < buf.length; i += 3) if (buf[i] > 200 && buf[i + 1] > 170 && buf[i + 2] < 110) n++; return n; };
  assert.ok(yellowish(top(p)) > 2000, "title drawn");
  assert.ok(yellowish(top(plain)) < yellowish(top(p)) / 4, "no title when blank");
});

test("the beats must tile the edit: tiny slips are joined, the last beat ends at the edit's end, gaps and overlaps throw", () => {
  const ok = tileBeats([beat(0.01, 1, "full", null), beat(1.005, 2, "full", null), beat(2, 2.9, "full", null)], 3);
  assert.deepEqual(ok.map((b) => [b.start, b.end]), [[0, 1], [1, 2], [2, 3]]);
  assert.throws(() => tileBeats([beat(0, 1, "full", null), beat(1.2, 3, "full", null)], 3), /gap between 1\.000 s and 1\.200 s/);
  assert.throws(() => tileBeats([beat(0, 1.5, "full", null), beat(1.2, 3, "full", null)], 3), /overlap between 1\.200 s and 1\.500 s/);
  assert.throws(() => tileBeats([beat(0.5, 3, "full", null)], 3), /start at 0\.500 s/);
  assert.throws(() => tileBeats([beat(0, 3, "full", null), beat(3, 4, "full", null)], 3), /past the end/);
  assert.equal(tileBeats([], 2).length, 1);
});

test("the join is frame-exact: every frame of the edit, and the split starts on its frame", async () => {
  const dir = tmp();
  const src = makeVideo(dir, "blue.mp4", ["-f", "lavfi", "-i", "color=c=blue:size=1080x1920:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const red = makeVideo(dir, "red.mp4", ["-f", "lavfi", "-i", "color=c=red:size=1080x960:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const out = await renderFancy(src, {
    segments: [{ start: 0, end: 4 }], beats: [beat(0, 2, "full", null), beat(2, 4, "speakerBottom", 0)],
    clips: [{ path: red, durationSec: 2, template: "keyword-card" }], faces: null, captionWords: null, settings: FANCY, outPath: join(dir, "exact.mp4"),
  });
  const frames = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out.path], { encoding: "utf8" }).trim());
  assert.equal(frames, Math.round(4 * 30));
  const top = (n: number) => {
    const px = execFileSync("ffmpeg", ["-v", "error", "-i", out.path, "-vf", `select='eq(n,${n})',crop=2:2:540:480`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    return [px[0], px[1], px[2]];
  };
  assert.ok(isBlue(top(59)), "frame 59 is still full frame");
  assert.ok(isRed(top(60)), "frame 60 (2.0 s) is the first split frame");
});

test("cancelling stops the render and leaves no files behind", async () => {
  const dir = tmp();
  const src = landscape60(dir, 6);
  const ctl = new AbortController();
  const outPath = join(dir, "cancel.mp4");
  const run = renderFancy(src, {
    segments: [{ start: 0, end: 6 }], beats: [0, 1, 2, 3, 4, 5].map((s) => beat(s, s + 1, "full", null)), clips: [], faces: null,
    captionWords: null, settings: FANCY, outPath, signal: ctl.signal, onProgress: (f) => { if (f > 0) ctl.abort(); },
  });
  await assert.rejects(run, /cancelled/);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("cancel.mp4")), []);
  // An already-cancelled render never starts.
  await assert.rejects(renderFancy(src, { segments: [{ start: 0, end: 6 }], beats: [], clips: [], faces: null, captionWords: null, settings: FANCY, outPath, signal: AbortSignal.abort() }), /cancelled/);
});

/** Yellow (title) pixels in a band of rows of a 1080x1920 image. */
function yellowIn(path: string, y: number, h: number): number {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", `crop=1080:${h}:0:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 25 });
  let n = 0;
  for (let i = 0; i < buf.length; i += 3) if (buf[i] > 200 && buf[i + 1] > 170 && buf[i + 2] < 110) n++;
  return n;
}

test("the cover title goes low when the face is high in the frame, and in the top third otherwise", async () => {
  const dir = tmp();
  const src = makeVideo(dir, "gray.mp4", ["-f", "lavfi", "-i", "color=c=gray:size=1920x1080:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const cover = (cy: number, name: string) => makeCover(src, {
    at: 1, segments: [{ start: 0, end: 2 }], faces: [{ t: 0, cx: 960, cy, size: 160 }, { t: 2, cx: 960, cy, size: 160 }], title: "Stop guessing what works", out: join(dir, name),
  });
  // Face top at about 11% of the frame: the title moves down, above the bottom safe area.
  const high = await cover(200, "high.jpg");
  assert.ok(yellowIn(high, 1000, 536) > 2000, "title in the lower area");
  assert.ok(yellowIn(high, 0, 700) < 200, "nothing at the top");
  assert.ok(yellowIn(high, 1536, 384) < 200, "clear of the bottom safe area");
  // The ink flips with it: the bottom is darker than the top.
  const luma = (p: string, y: number) => execFileSync("ffmpeg", ["-v", "error", "-i", p, "-vf", `crop=1080:40:0:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"]).reduce((a, b) => a + b, 0);
  assert.ok(luma(high, 1870) < luma(high, 20) / 2, "darkened at the bottom");
  // Face top at about 76%: the title stays in the top third.
  const low = await cover(900, "low.jpg");
  assert.ok(yellowIn(low, 200, 500) > 2000, "title in the top third");
  assert.ok(yellowIn(low, 1000, 920) < 200, "nothing low");
  assert.ok(luma(low, 20) < luma(low, 1870) / 2, "darkened at the top");
});

test("a cover word longer than a line gets a smaller size so it fits", () => {
  const size = (ass: string) => Number(/^Style: Cover,[^,]+,(\d+),/m.exec(ass)![1]);
  assert.equal(size(coverAss("Short words only here")), 120);
  const long = "Antidisestablishmentarianism";
  const s = size(coverAss(`${long} explained`));
  assert.ok(s < 120 && long.length * s * 0.42 <= 1080 - 120, `size ${s}`);
  assert.match(coverAss("x", "bottom"), /\\an2\\pos\(540,\d+\)/);
});

test("the ink is anchored to the title: the band just above a low title is darkened by at least half", async () => {
  const dir = tmp();
  const src = makeVideo(dir, "white.mp4", ["-f", "lavfi", "-i", "color=c=white:size=1920x1080:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const title = "The one habit that changes everything";
  const p = await makeCover(src, {
    at: 1, segments: [{ start: 0, end: 2 }], faces: [{ t: 0, cx: 960, cy: 200, size: 160 }, { t: 2, cx: 960, cy: 200, size: 160 }], title, out: join(dir, "ink.jpg"),
  });
  const { top, lines } = coverLayout(title, "bottom");
  assert.equal(lines.length, 3);
  const mean = (y: number, h: number) => {
    const buf = execFileSync("ffmpeg", ["-v", "error", "-i", p, "-vf", `crop=1080:${h}:0:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 25 });
    return buf.reduce((a, b) => a + b, 0) / buf.length;
  };
  const clear = mean(100, 40);
  const above = mean(top - 40, 30);
  assert.ok(clear > 200, `the source is bright (${clear})`);
  assert.ok(above < clear / 2, `just above the first line: ${above.toFixed(0)} vs ${clear.toFixed(0)} unshaded`);
});

test("a long low title shrinks rather than climb above 35% of the height", () => {
  const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen";
  const low = coverLayout(long, "bottom");
  assert.ok(low.lines.length >= 7);
  assert.ok(low.top >= 0.35 * 1920, `top ${low.top}`);
  assert.ok(low.size < 120);
  assert.equal(coverLayout("The one habit that changes everything", "bottom").size, 120);
});
