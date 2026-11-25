// What tagged resources add to Basic, Fancy and custom edits, in one ffmpeg pass after the edit is rendered:
// a music bed (looped or trimmed to length, ducked under speech), a logo on every frame, an end clip, and the
// text notes that go to the AI. The pass reads the edit's snapshot, so a resource deleted later changes nothing.
import { renameSync, unlinkSync } from "node:fs";
import { probe } from "../media.ts";
import { runFfmpeg } from "./render.ts";
import type { EditSettings } from "./settings.ts";

export interface Extras { music: string | null; overlay: string | null; endClip: string | null; context: string }

export const MAX_CONTEXT = 6000;

export function extrasOf(s: EditSettings, readText: (path: string) => string): Extras {
  const uses = s.resources ?? [];
  const pathOf = (role: string) => uses.find((u) => u.as === role)?.path ?? null;
  const texts: string[] = [];
  if (s.instructions) texts.push(s.instructions);
  for (const u of uses) if (u.as === "context") {
    try { texts.push(readText(u.path)); } catch {}
  }
  return { music: pathOf("music"), overlay: pathOf("overlay"), endClip: pathOf("clip"), context: texts.join("\n\n").slice(0, MAX_CONTEXT) };
}

export const hasMediaExtras = (e: Extras): boolean => Boolean(e.music || e.overlay || e.endClip);

const STEREO = "aresample=48000,aformat=channel_layouts=stereo";
const sec3 = (n: number) => n.toFixed(3);

/** An audio graph ending in [aout] (or `out`): the speech, the music ducked under it, or both. speechIn/musicIn are ffmpeg pad labels. */
export function audioMixGraph(o: { speechIn: string | null; musicIn: string | null; sec: number; out?: string }): string {
  const out = o.out ?? "aout";
  const music = o.musicIn
    ? `${o.musicIn}atrim=0:${sec3(o.sec)},asetpts=PTS-STARTPTS,volume=0.25,afade=t=out:st=${sec3(Math.max(0, o.sec - 1))}:d=1`
    : null;
  if (o.speechIn && music) {
    return [
      `${o.speechIn}asplit[sp][key]`,
      `${music}[mus]`,
      "[mus][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]",
      `[sp][duck]amix=inputs=2:duration=first:normalize=0,${STEREO}[${out}]`,
    ].join(";");
  }
  if (music) return `${music},${STEREO}[${out}]`;
  if (o.speechIn) return `${o.speechIn}${STEREO}[${out}]`;
  return `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${sec3(o.sec)},${STEREO}[${out}]`;
}

const FRAME = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30";

/**
 * The filter graph for the pass. Inputs, in order: 0 the edit, then the music, the logo and the end clip, each only when used.
 */
export function extrasFilterGraph(o: { videoSec: number; hasAudio: boolean; music: boolean; overlay: boolean; endClip: { hasAudio: boolean; sec: number } | null }): string {
  let next = 1;
  const musicIdx = o.music ? next++ : -1;
  const overlayIdx = o.overlay ? next++ : -1;
  const endIdx = o.endClip ? next++ : -1;
  const parts: string[] = [];

  let v = "[0:v]";
  if (o.endClip) {
    // Both halves of a concat must be the same size, whatever the edit was.
    parts.push(`${v}${FRAME}[mv]`);
    v = "[mv]";
  }
  if (o.overlay) {
    parts.push(`[${overlayIdx}:v]scale=180:-1,format=rgba,colorchannelmixer=aa=0.9[lg]`);
    parts.push(`${v}[lg]overlay=x=main_w-overlay_w-40:y=140[vo]`);
    v = "[vo]";
  }

  const mainAudio = o.endClip ? "amain" : "aout";
  parts.push(audioMixGraph({ speechIn: o.hasAudio ? "[0:a:0]" : null, musicIn: o.music ? `[${musicIdx}:a]` : null, sec: o.videoSec, out: mainAudio }));

  if (o.endClip) {
    parts.push(`[${endIdx}:v]${FRAME}[ev]`);
    parts.push(o.endClip.hasAudio
      ? `[${endIdx}:a:0]${STEREO}[ea]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${sec3(o.endClip.sec)},${STEREO}[ea]`);
    parts.push(`${v}[amain][ev][ea]concat=n=2:v=1:a=1[cv][aout]`);
    parts.push("[cv]format=yuv420p[vout]");
  } else {
    parts.push(`${v}format=yuv420p[vout]`);
  }
  return parts.join(";");
}

/** Renders `inPath` with the media extras into `outPath`. Returns the new length. */
export async function applyExtras(inPath: string, outPath: string, e: Extras, o: { signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<{ durationSec: number }> {
  const main = await probe(inPath);
  const end = e.endClip ? await probe(e.endClip) : null;
  const totalSec = main.durationSec + (end?.durationSec ?? 0);
  const graph = extrasFilterGraph({
    videoSec: main.durationSec, hasAudio: main.hasAudio, music: Boolean(e.music), overlay: Boolean(e.overlay),
    endClip: end ? { hasAudio: end.hasAudio, sec: end.durationSec } : null,
  });
  const part = `${outPath}.part.mp4`;
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    "-i", inPath,
    ...(e.music ? ["-stream_loop", "-1", "-i", e.music] : []),
    ...(e.overlay ? ["-i", e.overlay] : []),
    ...(e.endClip ? ["-i", e.endClip] : []),
    "-filter_complex", graph,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", part,
  ];
  try {
    await runFfmpeg(args, totalSec, o.onProgress, o.signal);
    renameSync(part, outPath);
  } finally {
    try { unlinkSync(part); } catch {}
  }
  o.onProgress?.(1);
  return { durationSec: (await probe(outPath)).durationSec };
}
