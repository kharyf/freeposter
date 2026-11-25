import "./isolated-home.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyExtras, audioMixGraph, extrasFilterGraph, extrasOf, hasMediaExtras } from "../src/edit/extras.ts";
import { DEFAULT_EDIT, type ResourceUse } from "../src/edit/settings.ts";
import { probe } from "../src/media.ts";
import { landscape60, makeVideo, tmp, verticalSilent } from "./helpers.ts";

const use = (tag: string, kind: ResourceUse["kind"], path: string, as: ResourceUse["as"]): ResourceUse => ({ id: 1, tag, kind, path, sha256: "x", as });
const sine = (seconds: number) => makeVideo(tmp(), `sine${seconds}.mp3`, ["-f", "lavfi", "-i", "sine=frequency=330", "-t", String(seconds)]);
const png = () => makeVideo(tmp(), "logo.png", ["-f", "lavfi", "-i", "color=red:s=300x100", "-frames:v", "1"]);

test("extrasFilterGraph spells the music, the logo and the end clip", () => {
  const all = extrasFilterGraph({ videoSec: 10, hasAudio: true, music: true, overlay: true, endClip: { hasAudio: true, sec: 3 } });
  assert.match(all, /sidechaincompress/);
  assert.match(all, /overlay=x=main_w-overlay_w-40:y=140/);
  assert.match(all, /concat=n=2/);
  assert.match(all, /volume=0\.25/);
  assert.match(all, /afade=t=out:st=9.000:d=1/);
  const logoOnly = extrasFilterGraph({ videoSec: 10, hasAudio: true, music: false, overlay: true, endClip: null });
  assert.doesNotMatch(logoOnly, /amix/);
  assert.doesNotMatch(logoOnly, /concat/);
  assert.match(audioMixGraph({ speechIn: null, musicIn: "[1:a]", sec: 5 }), /\[aout\]$/);
});

test("extrasOf picks roles and builds the context", () => {
  const s = {
    ...DEFAULT_EDIT, instructions: "Be brief",
    resources: [use("song", "audio", "/s.mp3", "music"), use("logo", "image", "/l.png", "overlay"), use("end", "video", "/e.mp4", "clip"), use("n", "text", "/n.txt", "context")],
  };
  const e = extrasOf(s, () => "x".repeat(7000));
  assert.deepEqual([e.music, e.overlay, e.endClip], ["/s.mp3", "/l.png", "/e.mp4"]);
  assert.equal(e.context.length, 6000);
  assert.ok(e.context.startsWith("Be brief\n\n"));
  assert.equal(hasMediaExtras(e), true);
  const none = extrasOf(DEFAULT_EDIT, () => "");
  assert.equal(hasMediaExtras(none), false);
  assert.equal(none.context, "");
});

test("music loops when short and is trimmed when long", async () => {
  const base = landscape60(tmp(), 4);
  for (const len of [1.5, 10]) {
    const out = join(tmp(), "out.mp4");
    const r = await applyExtras(base, out, { music: sine(len), overlay: null, endClip: null, context: "" });
    assert.ok(Math.abs(r.durationSec - 4) < 0.1, `music ${len}s gave ${r.durationSec}s`);
    assert.equal((await probe(out)).hasAudio, true);
  }
});

test("a logo and an end clip", async () => {
  const base = verticalSilent(tmp(), 4);
  const end = verticalSilent(tmp(), 2);
  const out = join(tmp(), "out.mp4");
  const r = await applyExtras(base, out, { music: null, overlay: png(), endClip: end, context: "" });
  assert.ok(Math.abs(r.durationSec - 6) < 0.15, `${r.durationSec}`);
  const p = await probe(out);
  assert.deepEqual([p.width, p.height], [1080, 1920]);
  assert.equal(p.hasAudio, true);
});

test("an extras pass is cancelled by its signal", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(applyExtras(verticalSilent(tmp(), 2), join(tmp(), "o.mp4"), { music: null, overlay: png(), endClip: null, context: "" }, { signal: ctl.signal }), /cancelled/);
  writeFileSync(join(tmp(), "x"), "");
});
