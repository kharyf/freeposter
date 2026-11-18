import "./isolated-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { probe } from "../src/media.ts";
import { Fatal, Retryable, type RenderContext } from "../src/produce/adapters/index.ts";
import { wanAdapter } from "../src/produce/adapters/wan.ts";
import { assemble } from "../src/produce/assemble.ts";
import { parseSpec, SpecError, type ProductionSpec, type WanShot } from "../src/produce/spec.ts";
import { wangpModels } from "../src/produce/tools.ts";
import { generateMusic, generateSpeech } from "../src/produce/wan-audio.ts";
import { makeVideo, tmp } from "./helpers.ts";

const FAKE = resolve(import.meta.dirname, "fixtures", "fake-tool.mjs");
const fakeAudio = (args: string[]) => ({ bin: process.execPath, args: [FAKE, "wan-audio", ...args] });
const fakeVideo = (args: string[]) => ({ bin: process.execPath, args: [FAKE, "wan", ...args] });

/** A WanGP folder holding just the model definitions given, as defaults/<id>.json. */
function wangp(defs: Record<string, Record<string, unknown>>) {
  const dir = tmp();
  writeFileSync(join(dir, "wgp.py"), "");
  mkdirSync(join(dir, "defaults"));
  for (const [id, model] of Object.entries(defs)) writeFileSync(join(dir, "defaults", `${id}.json`), JSON.stringify({ model }));
  return dir;
}
const settingsIn = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

test("speech: the settings file holds the speech model and the text, one prompt, and the wav comes back", async () => {
  const dir = wangp({ chatterbox: { name: "TTS Chatterbox Multilingual", architecture: "chatterbox" } });
  const out = tmp();
  const text = "Stop scrolling.\nThis app plans your week.";
  const wav = await generateSpeech(text, out, { dir: () => dir, model: () => "chatterbox", command: fakeAudio });
  const s = settingsIn(out, "wan-speech-settings.json");
  assert.equal(s.model_type, "chatterbox");
  assert.equal(s.prompt, text);
  assert.equal(s.multi_prompts_gen_type, "FG", "every line of the script is one prompt, not one generation per line");
  assert.equal(s.audio_prompt_type, "", "no voice sample chosen: the model's own voice");
  assert.equal(wav, join(out, "speech.wav"));
  assert.ok(meanVolume(wav) > -40);
});

test("speech keeps the user's own voice sample from their WanGP settings", async () => {
  const dir = wangp({ qwen3_tts_base: { name: "TTS Qwen3 Base", architecture: "qwen3_tts_base" } });
  mkdirSync(join(dir, "settings"));
  writeFileSync(join(dir, "settings", "qwen3_tts_base_settings.json"), JSON.stringify({ audio_prompt_type: "A", audio_guide: "C:/voices/me.wav", temperature: 0.7 }));
  const out = tmp();
  await generateSpeech("Hello there.", out, { dir: () => dir, model: () => "qwen3_tts_base", command: fakeAudio });
  const s = settingsIn(out, "wan-speech-settings.json");
  assert.equal(s.audio_prompt_type, "A");
  assert.equal(s.audio_guide, "C:/voices/me.wav");
  assert.equal(s.temperature, 0.7);
});

test("no speech or audio model chosen: the exact Setup errors, before WanGP runs", async () => {
  const opts = { dir: () => tmp(), model: () => "", command: fakeAudio };
  await assert.rejects(generateSpeech("hi", tmp(), opts), (e: Error) => e instanceof Fatal && e.message === "set a WanGP speech model in Setup");
  await assert.rejects(generateMusic("lofi", 10, tmp(), opts), (e: Error) => e instanceof Fatal && e.message === "set a WanGP audio model in Setup");
});

test("music: a described track of the length asked for; lyric models get [Instrumental] and the caption", async () => {
  const dir = wangp({
    stable_audio3_small: { name: "Music Stable Audio 3 Small Music", architecture: "stable_audio3_small" },
    ace_step_v1_5: { name: "Music ACE-Step v1.5 Turbo 2B", architecture: "ace_step_v1_5" },
  });
  const out = tmp();
  const wav = await generateMusic("warm lo-fi groove", 12, out, { dir: () => dir, model: () => "stable_audio3_small", command: fakeAudio });
  let s = settingsIn(out, "wan-music-settings.json");
  assert.equal(s.model_type, "stable_audio3_small");
  assert.equal(s.prompt, "warm lo-fi groove");
  assert.equal(s.duration_seconds, 12);
  assert.equal(s.audio_prompt_type, "");
  assert.equal(wav, join(out, "music.wav"));

  const out2 = tmp();
  await generateMusic("warm lo-fi groove", 12, out2, { dir: () => dir, model: () => "ace_step_v1_5", command: fakeAudio });
  s = settingsIn(out2, "wan-music-settings.json");
  assert.equal(s.prompt, "[Instrumental]");
  assert.equal(s.alt_prompt, "warm lo-fi groove");
  assert.equal(s.duration_seconds, 16, "ACE-Step fades out early: about a third more is asked for");
});

test("speech and music share the WanGP runner: refused settings are Fatal, out of memory Retryable", async () => {
  const dir = wangp({ chatterbox: { name: "TTS Chatterbox", architecture: "chatterbox" } });
  const run = (mode: string) => {
    process.env.FAKE_MODE = mode;
    return generateSpeech("hi", tmp(), { dir: () => dir, model: () => "chatterbox", command: fakeAudio }).finally(() => delete process.env.FAKE_MODE);
  };
  await assert.rejects(run("fail"), (e: Error) => e instanceof Fatal && /speech: WanGP refused the settings/.test(e.message));
  await assert.rejects(run("oom"), (e: Error) => e instanceof Retryable && /out of GPU memory/.test(e.message));
});

const ctx = (): RenderContext => ({ dir: tmp(), signal: new AbortController().signal, onProgress: () => {} });
const shot: WanShot = { id: "hero", kind: "wan", duration_sec: 2, prompt: "a desk", negative_prompt: "", image: null, seed: 1 };

test("a wan shot's own model wins over the default one", async () => {
  const c = ctx();
  await wanAdapter({ dir: () => tmp(), model: () => "t2v", command: fakeVideo }).render({ ...shot, model: "ltx2_22B" }, c);
  assert.equal(settingsIn(c.dir, "wan-settings.json").model_type, "ltx2_22B");
});

test("a presenter shot is driven by the voiceover: audio_guide, and its face where the model wants it", async () => {
  const dir = wangp({ infinitetalk: { name: "Infinitetalk", architecture: "infinitetalk" }, multitalk: { name: "Multitalk", architecture: "multitalk" } });
  const face = "C:/faces/host.png";
  const vo = "C:/work/voiceover.wav";
  let c = ctx();
  await wanAdapter({ dir: () => dir, model: () => "t2v", command: fakeVideo }).render({ ...shot, image: face, model: "multitalk", audio_guide: vo }, c);
  let s = settingsIn(c.dir, "wan-settings.json");
  assert.equal(s.audio_guide, vo);
  assert.equal(s.audio_prompt_type, "A");
  assert.deepEqual(s.image_start, [face]);
  assert.equal(s.image_prompt_type, "S");
  // InfiniteTalk takes the face as a reference image (WanGP's own gen_video_with_speech does the same).
  c = ctx();
  await wanAdapter({ dir: () => dir, model: () => "t2v", command: fakeVideo }).render({ ...shot, image: face, model: "infinitetalk", audio_guide: vo }, c);
  s = settingsIn(c.dir, "wan-settings.json");
  assert.deepEqual(s.image_refs, [face]);
  assert.equal(s.image_start, null);
  assert.equal(s.image_prompt_type, "T");
  assert.equal(s.audio_guide, vo);
  // A plain shot carries no audio guide.
  c = ctx();
  await wanAdapter({ dir: () => dir, model: () => "t2v", command: fakeVideo }).render(shot, c);
  assert.equal("audio_guide" in settingsIn(c.dir, "wan-settings.json"), false);
});

test("parseSpec refuses the internal-only model, audio_guide and audio.music from an agent's spec", () => {
  const ctx = { templates: {}, sfx: [] };
  const wan = { id: "a", kind: "wan", duration_sec: 2, prompt: "x" };
  assert.throws(() => parseSpec({ shots: [{ ...wan, model: "t2v" }] }, ctx), (e: SpecError) => e.problems.some((p) => /unknown field "model"/.test(p)));
  assert.throws(() => parseSpec({ shots: [{ ...wan, audio_guide: "C:/a.wav" }] }, ctx), (e: SpecError) => e.problems.some((p) => /unknown field "audio_guide"/.test(p)));
  assert.throws(() => parseSpec({ shots: [wan], audio: { music: "C:/m.wav" } }, ctx), (e: SpecError) => e.problems.some((p) => /unknown field "music"/.test(p)));
});

/** Mean loudness of a file's sound, in dB (−91 is silence). */
function meanVolume(path: string): number {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? -91);
}

test("assemble mixes the music under the voiceover; music alone still gives the video sound", async () => {
  const d = tmp();
  const silent = makeVideo(d, "silent.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const music = makeVideo(d, "music.wav", ["-f", "lavfi", "-i", "sine=frequency=220", "-t", "5"]);
  const spec: ProductionSpec = { version: 1, title: "", shots: [], transitions: { default: { type: "cut", sec: 0 } }, audio: { voiceover: null, music }, sfx: [], captions: { source: "none" }, post: null };
  const o = { final: join(d, "final.mp4"), preview: join(d, "preview.mp4"), thumb: join(d, "thumb.jpg") };
  const r = await assemble([{ path: silent, durationSec: 2 }], spec, o, { sfxPath: () => "" });
  assert.ok(Math.abs(r.durationSec - 2) < 0.15, `got ${r.durationSec}`);
  assert.ok((await probe(o.final)).hasAudio);
  assert.ok(meanVolume(o.final) > -40, `music should be heard, got ${meanVolume(o.final)} dB`);

  // Under a voiceover the music sits 18 dB down: the mix stays the voiceover's level, not the sum of both.
  const vo = makeVideo(d, "vo.wav", ["-f", "lavfi", "-i", "sine=frequency=440", "-t", "5"]);
  const o2 = { final: join(d, "final2.mp4"), preview: join(d, "preview2.mp4"), thumb: join(d, "thumb2.jpg") };
  await assemble([{ path: silent, durationSec: 2 }], { ...spec, audio: { voiceover: vo, music } }, o2, { sfxPath: () => "" });
  assert.ok((await probe(o2.final)).hasAudio);
});

test("wangpModels sorts a WanGP install's models into video, speech, audio and presenter; image and 3D models aren't video", () => {
  const dir = wangp({
    t2v: { name: "Wan2.1 Text2video 14B", architecture: "t2v" },
    ltx2_22B: { name: "LTX-2", architecture: "ltx2_22B" },
    flux_dev_kontext: { name: "Flux Kontext", architecture: "flux_dev_kontext" },
    z_image: { name: "Z-Image", architecture: "z_image" },
    qwen_image_edit_20B: { name: "Qwen Image Edit", architecture: "qwen_image_edit_20B" },
    trellis2: { name: "Trellis 2", architecture: "trellis2" },
    hunyuan3d_21: { name: "Hunyuan3D", architecture: "hunyuan3d_21" },
    chrono_edit: { name: "Chrono Edit", architecture: "chrono_edit" },
    chatterbox: { name: "TTS Chatterbox", architecture: "chatterbox" },
    qwen3_tts_customvoice: { name: "TTS Qwen3 Custom Voice", architecture: "qwen3_tts_customvoice" },
    ace_step_v1_5: { name: "Music ACE-Step v1.5", architecture: "ace_step_v1_5" },
    infinitetalk: { name: "Infinitetalk", architecture: "infinitetalk" },
  });
  writeFileSync(join(dir, "defaults", "notes.json"), "not json");
  assert.deepEqual(wangpModels(dir), {
    video: ["ltx2_22B", "t2v"],
    speech: ["chatterbox", "qwen3_tts_customvoice"],
    audio: ["ace_step_v1_5"],
    presenter: ["infinitetalk"],
  });
  assert.deepEqual(wangpModels(tmp()), { video: [], speech: [], audio: [], presenter: [] });
});
