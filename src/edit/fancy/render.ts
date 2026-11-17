// The Fancy compositor: plays the beats in order. A full beat is the speaker filling the frame; a split beat stacks
// the speaker in one 1080x960 half over or under its graphic, with a gold seam between. Each beat's crop follows the
// face and carries its zoom, slow push and snap, re-keyed every output frame. Each beat renders in a short ffmpeg
// pass of its own (so memory stays flat however long the video is); a last pass joins them, burns in the captions
// (on the seam in splits, low in full beats) and adds the cut sound.
import { probe } from "../../media.ts";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { buildAss, type CaptionPlace } from "../captions.ts";
import { sourceTime, type Segment } from "../cuts.ts";
import { cropAround, type FaceKey } from "../reframe.ts";
import { runFfmpeg } from "../render.ts";
import type { EditSettings } from "../settings.ts";
import { filterPath, type Word } from "../transcribe.ts";
import type { Beat, Layout } from "./beats.ts";
import type { RenderedGraphic } from "./graphics.ts";
import { fancyFontDir, PALETTE } from "./palette.ts";

const FPS = 30;
const OUT_W = 1080;
const OUT_H = 1920;
const HALF_H = 960;
/** The source is upscaled this much first, so the crops move in finer steps (no stair-stepping in slow zooms). */
const UPSCALE = 1.5;
const SNAP = 1.1;
const SNAP_FRAMES = 6;
const SEAM = 6;
/** Face positions are averaged over this many seconds either side, within the footage they're in. */
const FACE_SMOOTH = 0.5;

export interface Crop { x: number; y: number; w: number; h: number }

const isSplit = (layout: Layout) => layout !== "full";
const sec = (t: number) => t.toFixed(3);
/** The first frame (on the 30 fps output grid) that trim keeps for a beat starting at t: trim rounds to the nearest. */
const frameAt = (t: number) => Math.round(Number(sec(t)) * FPS);

/** The face at source time t, linearly between keys. */
function faceLerp(faces: FaceKey[], t: number): FaceKey {
  if (t <= faces[0].t) return faces[0];
  for (let i = 1; i < faces.length; i++) {
    const b = faces[i];
    if (t > b.t) continue;
    const a = faces[i - 1];
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
    return { t, cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f, size: a.size + (b.size - a.size) * f };
  }
  return faces.at(-1)!;
}

/**
 * The face at source time t, steadied: the mean over a second around t, kept inside `within` (the segment the frame
 * comes from), so the crop glides instead of twitching with each detection and never drifts across a cut.
 */
export function faceAt(faces: FaceKey[] | null, t: number, within?: Segment): FaceKey | null {
  if (!faces?.length) return null;
  const lo = within?.start ?? -Infinity;
  const hi = within?.end ?? Infinity;
  let cx = 0, cy = 0, size = 0, n = 0;
  for (let d = -FACE_SMOOTH; d <= FACE_SMOOTH + 1e-9; d += 0.1) {
    const f = faceLerp(faces, Math.min(hi, Math.max(lo, t + d)));
    cx += f.cx; cy += f.cy; size += f.size; n++;
  }
  return { t, cx: cx / n, cy: cy / n, size: size / n };
}

/** Where edited time t comes from: the source time and the segment holding it. */
function sourceAt(segments: Segment[], t: number): { t: number; seg: Segment | undefined } {
  const src = sourceTime(segments, t) ?? segments.at(-1)?.end ?? t;
  return { t: src, seg: segments.find((s) => src >= s.start - 1e-9 && src <= s.end + 1e-9) };
}

/** The zoom at edited time t: the beat's level, its slow push, and the snap eased in over 6 frames. */
function zoomAt(b: Beat, t: number): number {
  let z = b.zoom * (1 + b.pushPerSec * Math.max(0, t - b.start));
  if (b.snapAt !== null) {
    const p = Math.min(1, Math.max(0, (t - b.snapAt) / (SNAP_FRAMES / FPS)));
    z *= 1 + (SNAP - 1) * (1 - (1 - p) ** 3);
  }
  return z;
}

/**
 * The crop for each output frame of a beat, in `src` pixels (the upscaled picture; `faceScale` takes face keys there
 * from source pixels). Crops land on whole pixels, not cropAround's even ones: it is asked about a picture twice the
 * size and the answer halved, which halves the step a slow push moves in.
 */
export function beatCrops(b: Beat, ctx: { segments: Segment[]; faces: FaceKey[] | null; src: { width: number; height: number }; faceScale?: number }): Crop[] {
  const k = (ctx.faceScale ?? 1) * 2;
  const double = { width: ctx.src.width * 2, height: ctx.src.height * 2 };
  const aspect = isSplit(b.layout) ? OUT_W / HALF_H : OUT_W / OUT_H;
  const first = frameAt(b.start);
  const out: Crop[] = [];
  for (let f = first; f < frameAt(b.end); f++) {
    const t = f / FPS;
    const at = sourceAt(ctx.segments, t);
    const face = faceAt(ctx.faces, at.t, at.seg);
    const scaled = face && { ...face, cx: face.cx * k, cy: face.cy * k, size: face.size * k };
    const c = cropAround(scaled, double, aspect, zoomAt(b, t));
    out.push({ x: c.x / 2, y: c.y / 2, w: c.w / 2, h: c.h / 2 });
  }
  return out;
}

/** sendcmd lines re-keying crop@<name> at each frame where the crop changes (times are beat-local). */
function cropScript(name: string, crops: Crop[]): string {
  const lines: string[] = [];
  let prev: Crop | null = null;
  crops.forEach((c, f) => {
    const sets = (["w", "h", "x", "y"] as const).filter((p) => !prev || prev[p] !== c[p]).map((p) => `crop@${name} ${p} ${c[p]}`);
    // Half a frame early, so the key lands on its frame whatever the rounding.
    if (sets.length) lines.push(`${(f ? (f - 0.5) / FPS : 0).toFixed(4)} ${sets.join(", ")};`);
    prev = c;
  });
  return lines.join("\n") + "\n";
}

/** Where a beat's frames come from: the source seek point and length, and the segments it plays with their edited offsets. */
export interface BeatSource { seek: number; duration: number; parts: { seg: Segment; offset: number }[] }

export function beatSource(segments: Segment[], b: { start: number; end: number }): BeatSource {
  const all: BeatSource["parts"] = [];
  let offset = 0;
  for (const seg of segments) {
    all.push({ seg, offset });
    offset += seg.end - seg.start;
  }
  // A little either side, so fps has the frames either side of the beat's ends to pick from.
  const lo = b.start - 0.2;
  const hi = b.end + 0.2;
  const parts = all.filter((p) => p.offset < hi && p.offset + p.seg.end - p.seg.start > lo);
  if (!parts.length) parts.push(all.at(-1)!);
  const from = Math.min(...parts.map((p) => p.seg.start + Math.max(0, lo - p.offset)));
  const to = Math.max(...parts.map((p) => Math.min(p.seg.end, p.seg.start + hi - p.offset)));
  const seek = Math.max(0, from - 1);
  return { seek, duration: to - seek + 1, parts };
}

export interface GraphBeat {
  start: number;
  end: number;
  layout: Layout;
  /** the crop on the beat's first frame (the sendcmd script moves it from there) */
  crop: Crop;
  /** path of the beat's sendcmd script */
  cmds: string;
  /** where in the graphic clip (input 1) the beat starts and how long its last frame must be held; null on a full beat */
  graphic: { offset: number; padSec: number } | null;
}

/**
 * One beat's picture, from the source (input 0, opened `seek` seconds in) and its graphic clip (input 1) to [vout].
 * Each beat renders on its own, so memory stays the same however long the video is.
 */
export function beatGraph(b: GraphBeat, src: BeatSource, upscale: { width: number; height: number }): string {
  // The source's frames move to their edited times (segment j's source s lands at offset_j + s - start_j) and fps
  // samples the edited timeline from there: the same 30 fps grid in every beat, and the cut's frames exactly.
  const at = (v: string) => `(${v}+${src.seek.toFixed(6)})`;
  const inSeg = src.parts.map(({ seg }) => (v: string) => `gte(${at(v)},${sec(seg.start)})*lt(${at(v)},${sec(seg.end)})`);
  const select = inSeg.map((w) => w("t")).join("+");
  const toEdited = src.parts.map(({ seg, offset }, i) => `${inSeg[i]("T")}*(${at("T")}-${sec(seg.start)}+${offset.toFixed(6)})`).join("+");
  const split = b.graphic !== null;
  const { x, y, w, h } = b.crop;
  const parts = [
    // fps stops at the last frame's start, a frame short of the end: holding it a moment lets the beat end on time.
    `[0:v]select='${select}',setpts='(${toEdited})/TB',fps=${FPS},tpad=stop_mode=clone:stop_duration=0.1,` +
    `trim=start=${sec(b.start)}:end=${sec(b.end)},setpts=PTS-STARTPTS,setsar=1,` +
    `scale=${upscale.width}:${upscale.height}:flags=lanczos,format=yuv420p,sendcmd=f=${filterPath(b.cmds)},` +
    `crop@c=w=${w}:h=${h}:x=${x}:y=${y}:exact=1,scale=${OUT_W}:${split ? HALF_H : OUT_H}:flags=lanczos,setsar=1,format=yuv420p` +
    `[${split ? "p" : "vout"}]`,
  ];
  if (b.graphic) {
    // A little longer than the beat: the speaker half ends the stack (shortest=1), so the two never differ by a frame.
    parts.push(
      `[1:v]fps=${FPS},scale=${OUT_W}:${HALF_H},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${sec(b.graphic.padSec)},` +
      `trim=start=${sec(Math.max(0, b.graphic.offset))}:duration=${sec(b.end - b.start + 0.1)},setpts=PTS-STARTPTS[q]`,
    );
    const order = b.layout === "speakerTop" ? "[p][q]" : "[q][p]";
    parts.push(`${order}vstack=inputs=2:shortest=1,drawbox=x=0:y=${HALF_H - SEAM / 2}:w=${OUT_W}:h=${SEAM}:color=0x${PALETTE.gold.slice(1)}:t=fill[vout]`);
  }
  return parts.join(";\n");
}

/**
 * The finishing pass's filtergraph: the joined beats (input 0) get the captions, and the source's sound is cut as
 * the Basic edit cuts it, but joined on its own (joined with video, each segment's sound is padded out to a whole
 * frame, and over a few cuts it drifts from the edited timeline the beats and captions are timed on).
 */
export function fancyFilterGraph(g: { segments: Segment[]; settings: EditSettings; audioIn: string; hasAudio: boolean; ass: string | null }): string {
  const segs = g.segments;
  const n = segs.length;
  const parts: string[] = [];
  parts.push(`${g.audioIn}asplit=${n}${segs.map((_, i) => `[a${i}]`).join("")}`);
  segs.forEach((seg, i) => parts.push(`[a${i}]atrim=start=${sec(seg.start)}:end=${sec(seg.end)},asetpts=PTS-STARTPTS[as${i}]`));
  parts.push(`${segs.map((_, i) => `[as${i}]`).join("")}concat=n=${n}:v=0:a=1[ca]`);
  const captions = g.ass ? `ass=filename=${filterPath(g.ass)}:fontsdir=${filterPath(fancyFontDir())},` : "";
  parts.push(`[0:v]${captions}format=yuv420p[vout]`);
  // Silence has nothing to clean or level (and loudnorm turns it into NaNs the encoder rejects).
  const clean = g.settings.audio && g.hasAudio ? "afftdn=nr=10,loudnorm=I=-14:TP=-1.5:LRA=11," : "";
  parts.push(`[ca]${clean}aresample=48000,aformat=channel_layouts=stereo[aout]`);
  return parts.join(";");
}

/** How big the cut picture gets before cropping: 1.5x, unless the source is already that big for a 9:16 frame. */
function upscaleOf(src: { width: number; height: number }): { width: number; height: number; scale: number } {
  const fit = Math.min(src.width, (src.height * 9) / 16);
  const scale = fit >= OUT_W * UPSCALE ? 1 : UPSCALE;
  const even = (v: number) => Math.round(v / 2) * 2;
  return { width: even(src.width * scale), height: even(src.height * scale), scale };
}

/** Share of the progress bar the beats take; the finishing pass has the rest. */
const BEATS_SHARE = 0.85;
/** Beat passes run at once: two keep the CPU busy between passes, at about a single Basic edit's peak memory. */
const BEAT_PASSES = 2;
const FFMPEG_HEAD = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"];
/** The beats are an intermediate: near-lossless, quick to write, and without B-frames, so the join is frame-exact. */
const BEAT_ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-bf", "0", "-pix_fmt", "yuv420p"];

/**
 * The beats, checked to tile [0, editedSec]: ends within half a frame of the next start are joined exactly, and
 * the last beat ends at editedSec. A real gap, an overlap, or a beat past the end is a planning bug: it throws.
 */
export function tileBeats(beats: Beat[], editedSec: number): Beat[] {
  const tol = 0.5 / FPS;
  const at = (t: number) => `${t.toFixed(3)} s`;
  if (!beats.length) return [{ start: 0, end: editedSec, layout: "full", graphic: null, graphicOffset: 0, zoom: 1, pushPerSec: 0, snapAt: null }];
  const out = beats.map((b) => ({ ...b }));
  if (Math.abs(out[0].start) > tol) throw new Error(`the Fancy beats start at ${at(out[0].start)}, not at 0`);
  out[0].start = 0;
  for (let i = 1; i < out.length; i++) {
    const gap = out[i].start - out[i - 1].end;
    if (Math.abs(gap) > tol) {
      throw new Error(`the Fancy beats ${gap > 0 ? "leave a gap" : "overlap"} between ${at(Math.min(out[i - 1].end, out[i].start))} and ${at(Math.max(out[i - 1].end, out[i].start))}`);
    }
    out[i].start = out[i - 1].end;
  }
  const last = out.at(-1)!;
  if (last.start >= editedSec - tol) throw new Error(`a Fancy beat starts at ${at(last.start)}, at or past the end of the ${at(editedSec)} edit`);
  last.end = editedSec;
  for (const b of out) if (!(b.end > b.start)) throw new Error(`a Fancy beat at ${at(b.start)} has no length`);
  return out;
}

/** A line of a concat demuxer list (it reads ' inside a quoted name as '\''). */
const listLine = (path: string) => `file '${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;

export async function renderFancy(
  source: string,
  opts: {
    segments: Segment[];
    beats: Beat[];
    clips: RenderedGraphic[];
    faces: FaceKey[] | null;
    /** on the edited timeline */
    captionWords: Word[] | null;
    settings: EditSettings;
    outPath: string;
    onProgress?: (f: number) => void;
    /** cancels the render: running ffmpeg passes are killed */
    signal?: AbortSignal;
  },
): Promise<{ path: string; durationSec: number }> {
  const { segments, clips, outPath } = opts;
  const src = await probe(source);
  const editedSec = segments.reduce((t, s) => t + s.end - s.start, 0);
  const up = upscaleOf(src);
  // A split whose clip is missing (it shouldn't be) plays full frame rather than failing the edit.
  const beats = tileBeats(opts.beats, editedSec)
    .map((b): Beat => (isSplit(b.layout) && (b.graphic === null || !clips[b.graphic]) ? { ...b, layout: "full", graphic: null } : b))
    .filter((b) => frameAt(b.end) > frameAt(b.start));

  const temp: string[] = [];
  const progress = opts.onProgress;
  // Stops every pass: when the caller cancels, or when one beat fails (the others' work is wasted then).
  const stop = new AbortController();
  const onCancel = () => stop.abort();
  opts.signal?.addEventListener("abort", onCancel, { once: true });
  if (opts.signal?.aborted) stop.abort();
  try {
    // Each beat in a pass of its own, two at a time.
    const beatFiles = beats.map((_, i) => `${outPath}.b${i}.mp4`);
    const doneSec = beats.map(() => 0);
    const report = () => progress?.((doneSec.reduce((a, b) => a + b, 0) / editedSec) * BEATS_SHARE);
    const renderBeat = async (i: number) => {
      const b = beats[i];
      const crops = beatCrops(b, { segments, faces: opts.faces, src: up, faceScale: up.scale });
      const cmds = `${outPath}.b${i}.cmd`;
      temp.push(cmds, beatFiles[i]);
      writeFileSync(cmds, cropScript("c", crops));
      const clip = b.graphic === null ? null : clips[b.graphic];
      const len = b.end - b.start;
      const graphic = clip ? { offset: b.graphicOffset, padSec: Math.max(0, Math.max(0, b.graphicOffset) + len - clip.durationSec) + 0.5 } : null;
      const from = beatSource(segments, b);
      await runFfmpeg([
        ...FFMPEG_HEAD,
        "-ss", from.seek.toFixed(3), "-t", from.duration.toFixed(3), "-i", source,
        ...(clip ? ["-i", clip.path] : []),
        "-filter_complex", beatGraph({ start: b.start, end: b.end, layout: b.layout, crop: crops[0], cmds, graphic }, from, up),
        "-map", "[vout]", ...BEAT_ENCODE, beatFiles[i],
      ], len, (f) => { doneSec[i] = f * len; report(); }, stop.signal);
      doneSec[i] = len;
      report();
    };
    let next = 0;
    let firstError: unknown = null;
    const worker = async () => {
      while (!stop.signal.aborted && next < beats.length) {
        const i = next++;
        try { await renderBeat(i); } catch (err) {
          firstError ??= err;
          stop.abort();
        }
      }
    };
    // Every pass has exited (or never started) before the temp files are cleared.
    await Promise.all(Array.from({ length: BEAT_PASSES }, worker));
    if (firstError) throw firstError;
    if (stop.signal.aborted) throw new Error("cancelled");

    // Then join them, with the captions and the sound.
    let ass: string | null = null;
    if (opts.captionWords?.length) {
      const placeAt = (t: number): CaptionPlace => {
        const b = beats.find((x) => t < x.end) ?? beats.at(-1)!;
        return isSplit(b.layout) ? "seam" : "lower";
      };
      const breakAt = beats.slice(1).filter((b, i) => isSplit(b.layout) !== isSplit(beats[i].layout)).map((b) => b.start);
      ass = `${outPath}.ass`;
      temp.push(ass);
      writeFileSync(ass, buildAss(opts.captionWords, { look: "fancy", placeAt, breakAt }));
    }
    const list = `${outPath}.beats.txt`;
    const part = `${outPath}.part.mp4`;
    temp.push(list, part);
    writeFileSync(list, beatFiles.map(listLine).join("\n") + "\n");
    await runFfmpeg([
      ...FFMPEG_HEAD,
      "-f", "concat", "-safe", "0", "-i", list,
      "-i", source,
      // Silent clips get a silent track so the audio half of the graph always has an input.
      ...(src.hasAudio ? [] : ["-f", "lavfi", "-t", String(src.durationSec), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
      "-filter_complex", fancyFilterGraph({ segments, settings: opts.settings, audioIn: src.hasAudio ? "[1:a:0]" : "[2:a]", hasAudio: src.hasAudio, ass }),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", part,
    ], editedSec, (f) => progress?.(BEATS_SHARE + f * (1 - BEATS_SHARE)), stop.signal);
    renameSync(part, outPath);
  } finally {
    opts.signal?.removeEventListener("abort", onCancel);
    for (const f of temp) try { unlinkSync(f); } catch {}
  }
  progress?.(1);
  return { path: outPath, durationSec: (await probe(outPath)).durationSec };
}
