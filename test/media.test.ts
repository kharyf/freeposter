import assert from "node:assert/strict";
import { test } from "node:test";
import { probe, render, sampleFrames, specProblems } from "../src/media.ts";
import { landscape60, sha256, tmp, verticalSilent } from "./helpers.ts";

// Edge cases from the acceptance set: wrong aspect ratio + 60 fps + 44.1 kHz audio, and a silent clip.

test("landscape 60fps clip renders to the 1080x1920/30fps/AAC-48k spec", async () => {
  const dir = tmp();
  const src = landscape60(dir);
  const before = await probe(src);
  assert.ok(specProblems(before).length > 0, "source should not already meet spec");

  const out = await render(src, sha256(src), dir);
  assert.deepEqual(specProblems(out.probe), []);
  assert.ok(Math.abs(out.probe.durationSec - 4) < 0.2, `duration ${out.probe.durationSec}`);
});

test("silent clip gets a silent AAC track and keeps its length", async () => {
  const dir = tmp();
  const src = verticalSilent(dir);
  assert.equal((await probe(src)).hasAudio, false);
  const out = await render(src, sha256(src), dir);
  assert.equal(out.probe.hasAudio, true);
  assert.deepEqual(specProblems(out.probe), []);
  assert.ok(Math.abs(out.probe.durationSec - 4) < 0.2, `duration ${out.probe.durationSec}`);
});

test("non-video input is rejected with a clear reason", async () => {
  const dir = tmp();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${dir}/notes.mp4`, "this is not a video");
  await assert.rejects(probe(`${dir}/notes.mp4`), /not a readable video file/);
});

test("sampleFrames takes small JPEG stills spread through the video", async () => {
  const frames = await sampleFrames(landscape60(tmp()), 4);
  assert.equal(frames.length, 4);
  for (const f of frames) assert.equal(f.subarray(0, 2).toString("hex"), "ffd8", "a JPEG");
});
