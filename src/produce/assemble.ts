// Joins a production's shots into the final video in one ffmpeg pass: every shot normalized to 1080x1920 30 fps
// with a stereo 48 kHz track (silence when it has none), cuts or crossfades between them, the voiceover and SFX
// cues mixed in, captions burned from the voiceover, loudness evened out. Then a small preview and a thumbnail.
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { buildAss } from "../edit/captions.ts";
import { filterPath, type Transcript } from "../edit/transcribe.ts";
import { probe, TARGET } from "../media.ts";
import { runTool } from "./proc.ts";
import type { ProductionSpec, Transition } from "./spec.ts";

export interface AssembleOptions {
  /** the file for an SFX library name */
  sfxPath: (name: string) => string;
  /** words in the voiceover, for captions */
  transcribe?: (path: string) => Promise<Transcript>;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

const transitionFor = (spec: ProductionSpec, from: string | undefined, to: string | undefined): Transition =>
  (from && to && spec.transitions[`${from}->${to}`]) || spec.transitions.default;

async function ffmpeg(args: string[], signal: AbortSignal, onLine?: (l: string) => void) {
  const { code, tail } = await runTool(config.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { signal, onLine });
  if (code !== 0) throw new Error(`assembly failed: ${tail}`);
}

export async function assemble(
  shots: { path: string; durationSec: number }[],
  spec: ProductionSpec,
  out: { final: string; preview: string; thumb: string },
  opts: AssembleOptions,
): Promise<{ durationSec: number }> {
  const signal = opts.signal ?? new AbortController().signal;
  const temp: string[] = [];
  const inputs: string[] = [];
  const parts: string[] = [];
  const W = TARGET.width, H = TARGET.height, FPS = TARGET.fps;

  // Shots: video and audio, each trimmed to the length the production uses.
  for (const [i, shot] of shots.entries()) {
    const p = await probe(shot.path);
    inputs.push("-i", shot.path);
    const d = shot.durationSec.toFixed(3);
    parts.push(`[${i}:v:0]trim=0:${d},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
    parts.push(p.hasAudio
      ? `[${i}:a:0]atrim=0:${d},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${d}[a${i}]`);
  }

  // Join: cut = concat, crossfade = xfade/acrossfade overlapping the two shots.
  let v = "[v0]", a = "[a0]", total = shots[0].durationSec;
  for (let i = 1; i < shots.length; i++) {
    const d = shots[i].durationSec;
    const t = transitionFor(spec, spec.shots[i - 1]?.id, spec.shots[i]?.id);
    const nv = `[jv${i}]`, na = `[ja${i}]`;
    if (t.type === "crossfade") {
      const sec = Math.min(t.sec, d / 2, total / 2);
      parts.push(`${v}[v${i}]xfade=transition=fade:duration=${sec.toFixed(3)}:offset=${(total - sec).toFixed(3)}${nv}`);
      parts.push(`${a}[a${i}]acrossfade=d=${sec.toFixed(3)}${na}`);
      total += d - sec;
    } else {
      parts.push(`${v}${a}[v${i}][a${i}]concat=n=2:v=1:a=1${nv}${na}`);
      total += d;
    }
    v = nv;
    a = na;
  }

  // Voiceover and SFX cues over the shots' own sound; the shots' track sets the length.
  const mix = [a];
  let next = shots.length;
  if (spec.audio.voiceover) {
    inputs.push("-i", spec.audio.voiceover);
    parts.push(`[${next}:a:0]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[vo]`);
    mix.push("[vo]");
    next++;
  }
  spec.sfx.forEach((cue, k) => {
    const file = opts.sfxPath(cue.name);
    if (!file || cue.at_sec >= total) return;
    inputs.push("-i", file);
    const ms = Math.round(cue.at_sec * 1000);
    parts.push(`[${next}:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=${cue.gain_db}dB,adelay=${ms}|${ms}[sfx${k}]`);
    mix.push(`[sfx${k}]`);
    next++;
  });
  const mixed = mix.length > 1 ? `${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0[mixed]` : `${a}anull[mixed]`;
  parts.push(mixed);
  parts.push(`[mixed]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo,atrim=0:${total.toFixed(3)}[aout]`);

  // Captions from the voiceover's words.
  let videoOut = v;
  if (spec.captions.source === "voiceover" && spec.audio.voiceover && opts.transcribe) {
    const words = (await opts.transcribe(spec.audio.voiceover)).words.filter((w) => w.start < total);
    if (words.length) {
      const ass = `${out.final}.ass`;
      writeFileSync(ass, buildAss(words));
      temp.push(ass);
      parts.push(`${v}ass=filename=${filterPath(ass)}[vcap]`);
      videoOut = "[vcap]";
    }
  }
  // xfade works in 4:4:4; every platform wants 4:2:0.
  parts.push(`${videoOut}format=yuv420p[vout]`);
  videoOut = "[vout]";
  opts.onProgress?.(0.1);

  const part = `${out.final}.part.mp4`;
  temp.push(part);
  try {
    await ffmpeg([
      ...inputs, "-filter_complex", parts.join(";"), "-map", videoOut, "-map", "[aout]",
      "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "18", "-r", String(FPS), "-g", String(FPS * 2),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-t", total.toFixed(3), part,
    ], signal);
    renameSync(part, out.final);
    opts.onProgress?.(0.8);
    await ffmpeg(["-i", out.final, "-vf", "scale=540:960", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out.preview], signal);
    await ffmpeg(["-ss", Math.min(1, total / 2).toFixed(2), "-i", out.final, "-frames:v", "1", "-vf", "scale=540:960", "-q:v", "4", out.thumb], signal);
  } finally {
    for (const f of temp) try { unlinkSync(f); } catch {}
  }
  opts.onProgress?.(1);
  return { durationSec: (await probe(out.final)).durationSec };
}
