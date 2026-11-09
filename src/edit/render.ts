// Makes the edited cut in one ffmpeg pass: keep the planned segments, follow the speaker, punch in on
// alternate cuts, burn in captions, and even out the sound. The result is a high-quality 1080x1920 file
// that still goes through media.ts's render() like any upload.
import { spawn } from "node:child_process";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { probe } from "../media.ts";
import { buildAss } from "./captions.ts";
import { applyRanges, fixWords, planCuts, remapWords, type Segment } from "./cuts.ts";
import { planReframe, sendcmdScript } from "./reframe.ts";
import type { EditSettings } from "./settings.ts";
import { filterPath, type Transcript } from "./transcribe.ts";

const PUNCH = 1.06;

function filterGraph(segs: Segment[], s: EditSettings, opts: { reframe: { width: number; height: number; x: number; cmds: string } | null; ass: string | null; audioIn: string; hasAudio: boolean }) {
  const n = segs.length;
  const parts: string[] = [];
  let v = "[0:v]";
  if (opts.reframe) {
    const { width, height, x, cmds } = opts.reframe;
    parts.push(`${v}sendcmd=f=${filterPath(cmds)},crop@rf=w=${width}:h=${height}:x=${Math.round(x)}:y=0[rf]`);
    v = "[rf]";
  }
  parts.push(`${v}split=${n}${segs.map((_, i) => `[v${i}]`).join("")}`);
  parts.push(`${opts.audioIn}asplit=${n}${segs.map((_, i) => `[a${i}]`).join("")}`);
  segs.forEach((seg, i) => {
    const punch = s.punchIn && n > 1 && i % 2 === 1
      ? `,scale=trunc(iw*${PUNCH}/2)*2:-2,crop=trunc(iw/${PUNCH}/2)*2:trunc(ih/${PUNCH}/2)*2`
      : "";
    parts.push(
      `[v${i}]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS${punch},` +
      "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30" +
      `[vs${i}]`,
    );
    parts.push(`[a${i}]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[as${i}]`);
  });
  parts.push(`${segs.map((_, i) => `[vs${i}][as${i}]`).join("")}concat=n=${n}:v=1:a=1[cv][ca]`);
  parts.push(`[cv]${opts.ass ? `ass=filename=${filterPath(opts.ass)},` : ""}format=yuv420p[vout]`);
  // Silence has nothing to clean or level (and loudnorm turns it into NaNs the encoder rejects).
  const clean = s.audio && opts.hasAudio ? "afftdn=nr=10,loudnorm=I=-14:TP=-1.5:LRA=11," : "";
  parts.push(`[ca]${clean}aresample=48000,aformat=channel_layouts=stereo[aout]`);
  return parts.join(";");
}

/** The source stretches an edit keeps: the cut plan (when tightening), with the user's keep and drop ranges. */
export function planSegments(transcript: Transcript, s: EditSettings, durationSec: number): Segment[] {
  const base = s.tighten ? planCuts(transcript.words, durationSec) : [{ start: 0, end: durationSec }];
  return applyRanges(base, durationSec, s.keep, s.drop);
}

export async function renderEdit(
  source: string,
  transcript: Transcript,
  s: EditSettings,
  outPath: string,
  onProgress?: (fraction: number) => void,
): Promise<{ path: string; durationSec: number; segments: Segment[] }> {
  const src = await probe(source);
  const segs = planSegments(transcript, s, src.durationSec);
  const editedSec = segs.reduce((t, g) => t + g.end - g.start, 0);
  const temp: string[] = [];

  let reframe = null;
  if (s.reframe) {
    // A failed face pass is not worth failing the edit for: the letterbox is the fallback either way.
    const plan = await planReframe(source, src).catch((err) => {
      console.error(`reframe skipped: ${(err as Error).message}`);
      return null;
    });
    if (plan) {
      const cmds = `${outPath}.crop.txt`;
      writeFileSync(cmds, sendcmdScript(plan.keys));
      temp.push(cmds);
      reframe = { width: plan.width, height: plan.height, x: plan.keys[0].x, cmds };
    }
  }
  let ass: string | null = null;
  if (s.captions && transcript.words.length) {
    ass = `${outPath}.ass`;
    const words = fixWords(transcript.words, s.captionFixes);
    // Uncut, the captions show every word as said (fillers too), as before.
    const captionWords = s.tighten || s.drop?.length ? remapWords(words, segs) : words;
    writeFileSync(ass, buildAss(captionWords));
    temp.push(ass);
  }

  const part = `${outPath}.part.mp4`;
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    "-i", source,
    // Silent clips get a silent track so the audio half of the graph always has an input.
    ...(src.hasAudio ? [] : ["-f", "lavfi", "-t", String(src.durationSec), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
    "-filter_complex", filterGraph(segs, s, { reframe, ass, audioIn: src.hasAudio ? "[0:a:0]" : "[1:a]", hasAudio: src.hasAudio }),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", part,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(config.ffmpeg, args, { windowsHide: true });
      let stderr = "";
      ff.stderr.on("data", (d) => (stderr += d));
      ff.stdout.on("data", (d: Buffer) => {
        const us = String(d).match(/out_time_us=(\d+)/g)?.at(-1)?.split("=")[1];
        if (us && editedSec > 0) onProgress?.(Math.min(1, Number(us) / 1e6 / editedSec));
      });
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`edit failed: ${stderr.trim() || `ffmpeg exited ${code}`}`))));
    });
    renameSync(part, outPath);
  } finally {
    for (const f of [...temp, part]) try { unlinkSync(f); } catch {}
  }
  onProgress?.(1);
  return { path: outPath, durationSec: (await probe(outPath)).durationSec, segments: segs };
}
