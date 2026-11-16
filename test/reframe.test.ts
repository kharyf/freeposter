import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { probe } from "../src/media.ts";
import { cropAround, planFaceTrack, planReframe, sendcmdScript, smoothKeys } from "../src/edit/reframe.ts";
import { landscape60, makeVideo, tmp, verticalSilent } from "./helpers.ts";

const realModel = join(import.meta.dirname, "..", "data", "models", "ultraface-rfb-320.onnx");
const noModel = !existsSync(realModel) && "face model not downloaded";

test("vertical source needs no reframe", async () => {
  const src = verticalSilent(tmp(), 2);
  assert.equal(await planReframe(src, await probe(src), realModel), null);
});

test("no subject falls back to letterbox", { skip: noModel }, async () => {
  const src = landscape60(tmp(), 2);
  assert.equal(await planReframe(src, await probe(src), realModel), null);
});

test("follows a face", { skip: noModel }, async () => {
  const dir = tmp();
  const face = join(import.meta.dirname, "fixtures", "face.jpg");
  const src = makeVideo(dir, "face.mp4", [
    "-f", "lavfi", "-i", "color=c=gray:size=1920x1080:rate=30",
    "-loop", "1", "-i", face,
    "-filter_complex", "[0:v][1:v]overlay=1400:300,format=yuv420p", "-t", "2", "-c:v", "libx264",
  ]);
  const plan = await planReframe(src, await probe(src), realModel);
  assert.ok(plan, "a face should be found");
  assert.equal(plan.height, 1080);
  assert.equal(plan.width % 2, 0);
  assert.ok(Math.abs(plan.width - 1080 * 9 / 16) <= 2);
  for (const k of plan.keys) {
    const center = k.x + plan.width / 2;
    assert.ok(Math.abs(center - 1565) < 200, `crop centre ${center}`);
    assert.ok(k.x >= 0 && k.x + plan.width <= 1920);
  }
});

test("smoothKeys limits speed", () => {
  const out = smoothKeys([{ t: 0, x: 0 }, { t: 0.5, x: 800 }, { t: 1, x: 800 }], 300);
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i].x - out[i - 1].x) <= 150 + 1e-9, JSON.stringify(out));
  assert.equal(out[0].x, 0);
});

test("sendcmdScript formats crop commands", () => {
  const s = sendcmdScript([{ t: 0, x: 10 }, { t: 0.5, x: 20 }]);
  assert.match(s, /0\.000 crop@rf x 10;/);
  assert.match(s, /0\.500 crop@rf x 20;/);
});

test("a 9:8 crop of a portrait source centres the face with headroom", () => {
  const c = cropAround({ t: 0, cx: 540, cy: 700, size: 300 }, { width: 1080, height: 1920 }, 9 / 8, 1);
  assert.deepEqual([c.w, c.h], [1080, 960]);
  assert.ok(700 - c.y > c.h * 0.3 && 700 - c.y < c.h * 0.5);
});

test("a face near the top edge clamps the crop to the frame", () => {
  const c = cropAround({ t: 0, cx: 540, cy: 60, size: 200 }, { width: 1080, height: 1920 }, 9 / 8, 1.12);
  assert.equal(c.y, 0);
  assert.ok(c.x >= 0 && c.x + c.w <= 1080);
  assert.ok(c.y + c.h <= 1920);
  for (const n of [c.x, c.y, c.w, c.h]) assert.equal(n % 2, 0);
});

test("no face crops the centre", () => {
  const c = cropAround(null, { width: 1920, height: 1080 }, 9 / 16, 1);
  assert.equal(c.x, Math.round((1920 - c.w) / 2 / 2) * 2);
  assert.equal(c.y, 0);
});

test("zoom shrinks the crop", () => {
  const c = cropAround(null, { width: 1080, height: 1920 }, 9 / 16, 1.25);
  assert.deepEqual([c.w, c.h], [864, 1536]);
});

test("planFaceTrack finds the fixture face in a portrait clip", { skip: noModel }, async () => {
  const dir = tmp();
  const face = join(import.meta.dirname, "fixtures", "face.jpg");
  const src = makeVideo(dir, "face-portrait.mp4", [
    "-f", "lavfi", "-i", "color=c=gray:size=1080x1920:rate=30",
    "-loop", "1", "-i", face,
    "-filter_complex", "[0:v][1:v]overlay=300:600,format=yuv420p", "-t", "2", "-c:v", "libx264",
  ]);
  const keys = await planFaceTrack(src, await probe(src), realModel);
  assert.ok(keys, "a face should be found");
  assert.ok(keys.length >= 3);
  for (const k of keys) {
    assert.ok(k.cy > 600 && k.cy < 1012, `cy ${k.cy}`);
    assert.ok(Math.abs(k.cx - 465) < 200, `cx ${k.cx}`);
    assert.ok(k.size > 50 && k.size < 412, `size ${k.size}`);
  }
});

test("planFaceTrack gives null when no face is found", { skip: noModel }, async () => {
  const src = landscape60(tmp(), 2);
  assert.equal(await planFaceTrack(src, await probe(src), realModel), null);
});
