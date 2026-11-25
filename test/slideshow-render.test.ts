import "./isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { probe } from "../src/media.ts";
import type { Slide } from "../src/edit/slideshow/plan.ts";
import {
  extractStill, renderSlideshow, renderSpeechTrack, slideshowFilterGraph, slideTextAss, xfadeOffsets, type RenderSlide,
} from "../src/edit/slideshow/render.ts";
import { landscape60, makeVideo, tmp, verticalSilent } from "./helpers.ts";

const image = (size: string, name: string) => makeVideo(tmp(), name, ["-f", "lavfi", "-i", `color=c=red:s=${size}`, "-frames:v", "1"]);
const slide = (n: number, asset: number | null, title = ""): Slide => ({ start: n * 2, end: n * 2 + 2, asset, title, body: "" });

test("xfadeOffsets are the slides' lengths added up", () => {
  assert.deepEqual(xfadeOffsets([4, 3, 5]), [4, 7]);
  assert.deepEqual(xfadeOffsets([5]), []);
});

test("the filter graph has zoompan, a crossfade between each pair, the grade and its output", () => {
  const slides: RenderSlide[] = [
    { kind: "image", path: "/a.png", seconds: 3, zoomIn: true },
    { kind: "video", path: "/b.mp4", seconds: 3, zoomIn: false },
    { kind: "card", path: null, seconds: 3, zoomIn: true },
  ];
  const g = slideshowFilterGraph({ slides, ass: "/t.ass", captionsAss: null, speech: false, music: false, totalSec: 9 });
  assert.match(g, /zoompan/);
  assert.equal(g.match(/xfade=transition=fade/g)!.length, 2);
  assert.match(g, /colorbalance=rs=-0\.04/);
  assert.match(g, /\[vout\]/);
  assert.match(g, /\[aout\]/);
});

test("slide text: numbers, lower third, or the top when captions are on", () => {
  const slides = [slide(0, 0, "One"), slide(1, null, "Two"), slide(2, 1, "Three")];
  const plain = slideTextAss(slides, { numbers: true, captionsOn: false });
  assert.match(plain, /1\/3/);
  assert.match(plain, /3\/3/);
  assert.match(plain, /Style: SlideText,.*,1,4,0,2,60,60,420,1/);
  const captioned = slideTextAss(slides, { numbers: true, captionsOn: true });
  assert.match(captioned, /Style: SlideText,.*,1,4,0,8,60,60,220,1/);
  assert.doesNotMatch(slideTextAss(slides, { numbers: false, captionsOn: false }), /1\/3/);
});

test("odd image shapes render as full-frame slides", async () => {
  const out = join(tmp(), "show.mp4");
  const slides: RenderSlide[] = [
    { kind: "image", path: image("4000x500", "pano.png"), seconds: 2, zoomIn: true },
    { kind: "image", path: image("64x64", "icon.png"), seconds: 2, zoomIn: false },
    { kind: "image", path: image("720x1280", "phone.png"), seconds: 2, zoomIn: true },
    { kind: "video", path: verticalSilent(tmp(), 1), seconds: 2, zoomIn: false },
    { kind: "card", path: null, seconds: 2, zoomIn: true },
  ];
  const r = await renderSlideshow({ slides, text: slides.map((_, i) => slide(i, i < 4 ? i : null, `Slide ${i + 1}`)), captionsAss: null, speechPath: null, musicPath: null, totalSec: 10, outPath: out });
  assert.ok(Math.abs(r.durationSec - 10) < 0.15, `${r.durationSec}`);
  const p = await probe(out);
  assert.deepEqual([p.width, p.height], [1080, 1920]);
  for (const at of [1, 3, 5]) {
    const top = execFileSync("ffmpeg", ["-v", "error", "-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "crop=1080:4:0:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 20 });
    assert.ok(top.some((b) => b > 16), `at ${at} s the top row is black: the image was letterboxed`);
  }
  assert.ok(!existsSync(`${out}.slides.ass`), "temporary files are cleaned up");
});

test("music runs under the slides and the video ends with them", async () => {
  const out = join(tmp(), "show.mp4");
  const music = makeVideo(tmp(), "m.mp3", ["-f", "lavfi", "-i", "sine=frequency=330", "-t", "3"]);
  const slides: RenderSlide[] = [0, 1, 2].map((i) => ({ kind: "card", path: null, seconds: 2, zoomIn: i % 2 === 0 }));
  const r = await renderSlideshow({ slides, text: slides.map((_, i) => slide(i, null, `T${i}`)), captionsAss: null, speechPath: null, musicPath: music, totalSec: 6, outPath: out });
  assert.ok(Math.abs(r.durationSec - 6) < 0.15, `${r.durationSec}`);
  assert.equal((await probe(out)).hasAudio, true);
});

test("the narration track and a still from a video", async () => {
  const src = landscape60(tmp(), 4);
  const speech = await renderSpeechTrack(src, [{ start: 0, end: 1 }, { start: 2, end: 3.5 }], true, join(tmp(), "s.m4a"));
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", speech]).toString());
  assert.ok(Math.abs(Number(info.format.duration) - 2.5) < 0.2, `${info.format.duration}`);
  const silent = await renderSpeechTrack(verticalSilent(tmp(), 3), [{ start: 0, end: 2 }], true, join(tmp(), "q.m4a"));
  assert.ok(existsSync(silent));
  const still = await extractStill(src, 1.5, join(tmp(), "f.jpg"));
  const bytes = readFileSync(still);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8]);
  assert.equal((await probe(still)).width, 1920);
});
