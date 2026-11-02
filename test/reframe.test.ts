import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { probe } from "../src/media.ts";
import { planReframe, sendcmdScript, smoothKeys } from "../src/edit/reframe.ts";
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
