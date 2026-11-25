// Draws a slideshow: every slide full-frame 1080x1920 (images with a slow Ken Burns zoom, clips muted, text cards on
// the palette's ink), joined by half-second crossfades, graded warm teal-and-orange, with the slide's title and a small
// slide number on top and the narration and music underneath. One ffmpeg pass.
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { probe } from "../../media.ts";
import { escape } from "../captions.ts";
import { audioMixGraph } from "../extras.ts";
import { assHex, PALETTE } from "../fancy/palette.ts";
import type { Segment } from "../cuts.ts";
import { runFfmpeg } from "../render.ts";
import { filterPath } from "../transcribe.ts";
import type { Slide } from "./plan.ts";

export const FADE = 0.5, ZOOM = 1.08, W = 1080, H = 1920, FPS = 30;
export const GRADE = "colorbalance=rs=-0.04:bs=0.06:rh=0.05:gh=0.01:bh=-0.05,eq=saturation=1.08";

/** When each crossfade starts: the slides' lengths added up (each slide's input runs half a second long to overlap the next). */
export function xfadeOffsets(durations: number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const d of durations.slice(0, -1)) out.push((at += d));
  return out;
}

export interface RenderSlide { kind: "image" | "video" | "card"; path: string | null; seconds: number; zoomIn: boolean }

const clock = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** The titles, body text and slide numbers as an ASS file. Text sits in the lower third, or near the top when captions use it. */
export function slideTextAss(slides: Slide[], o: { numbers: boolean; captionsOn: boolean }): string {
  const ink = assHex(PALETTE.ink);
  const align = o.captionsOn ? 8 : 2;
  const marginV = o.captionsOn ? 220 : 420;
  const head = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: SlideText,Arial,64,&H00FFFFFF,&H00FFFFFF,${ink},&H00000000,-1,0,0,0,100,100,0,0,1,4,0,${align},60,60,${marginV},1`,
    `Style: SlideCard,Arial,84,&H00FFFFFF,&H00FFFFFF,${ink},&H00000000,-1,0,0,0,100,100,0,0,1,4,0,5,60,60,0,1`,
    `Style: SlideNum,Arial,32,&H4DFFFFFF,&H4DFFFFFF,${ink},&H00000000,0,0,0,0,100,100,0,0,1,2,0,3,40,40,60,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  slides.forEach((s, k) => {
    const card = s.asset === null;
    const text = [
      s.title ? `{\\fs${card ? 84 : 64}\\b1}${escape(s.title)}` : "",
      s.body ? `{\\fs44\\b0}${escape(s.body)}` : "",
    ].filter(Boolean).join("\\N");
    const at = `${clock(s.start)},${clock(s.end)}`;
    if (text) events.push(`Dialogue: 1,${at},${card ? "SlideCard" : "SlideText"},,0,0,0,,{\\fad(250,250)}${text}`);
    if (o.numbers) events.push(`Dialogue: 2,${at},SlideNum,,0,0,0,,${k + 1}/${slides.length}`);
  });
  return [...head, ...events, ""].join("\n");
}

const CARD_COLOR = PALETTE.ink.replace("#", "0x");

/** The whole slideshow as one filter graph. Inputs: each slide in order, then the speech track, then the music (each only when used). */
export function slideshowFilterGraph(o: { slides: RenderSlide[]; ass: string | null; captionsAss: string | null; speech: boolean; music: boolean; totalSec: number }): string {
  const n = o.slides.length;
  const parts: string[] = [];
  o.slides.forEach((s, i) => {
    const len = s.seconds + (i < n - 1 ? FADE : 0);
    const frames = Math.max(1, Math.round(len * FPS));
    const z = s.zoomIn ? `1+${ZOOM - 1}*on/${frames}` : `${ZOOM}-${ZOOM - 1}*on/${frames}`;
    const shape =
      s.kind === "image"
        ? `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`
        : s.kind === "video"
          ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},tpad=stop_mode=clone:stop_duration=${len.toFixed(3)},trim=duration=${len.toFixed(3)}`
          : "null";
    parts.push(`[${i}:v]${shape},setpts=PTS-STARTPTS,setsar=1,format=yuv420p,settb=AVTB[s${i}]`);
  });
  const offsets = xfadeOffsets(o.slides.map((s) => s.seconds));
  let last = "[s0]";
  offsets.forEach((off, k) => {
    parts.push(`${last}[s${k + 1}]xfade=transition=fade:duration=${FADE}:offset=${off.toFixed(3)}[x${k + 1}]`);
    last = `[x${k + 1}]`;
  });
  const overlays = [o.ass ? `ass=filename=${filterPath(o.ass)}` : "", o.captionsAss ? `ass=filename=${filterPath(o.captionsAss)}` : ""].filter(Boolean);
  parts.push(`${last}${[GRADE, ...overlays, "format=yuv420p"].join(",")}[vout]`);
  const speechIdx = o.speech ? n : -1;
  const musicIdx = o.music ? n + (o.speech ? 1 : 0) : -1;
  parts.push(audioMixGraph({ speechIn: o.speech ? `[${speechIdx}:a]` : null, musicIn: o.music ? `[${musicIdx}:a]` : null, sec: o.totalSec }));
  return parts.join(";");
}

/** One JPEG frame of a video, for a slide made from the edit's own footage. */
export async function extractStill(source: string, atSec: number, out: string): Promise<string> {
  await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-ss", Math.max(0, atSec).toFixed(3), "-i", source, "-frames:v", "1", "-q:v", "2", out], 0);
  return out;
}

/** The narration of the kept segments (cleaned when asked) as an .m4a, for the slideshow to play over its slides. */
export async function renderSpeechTrack(source: string, segments: Segment[], clean: boolean, out: string, signal?: AbortSignal): Promise<string> {
  const src = await probe(source);
  const editedSec = segments.reduce((t, g) => t + g.end - g.start, 0);
  const n = segments.length;
  const polish = clean && src.hasAudio ? "afftdn=nr=10,loudnorm=I=-14:TP=-1.5:LRA=11," : "";
  const tail = `${polish}aresample=48000,aformat=channel_layouts=stereo[aout]`;
  let args: string[];
  if (src.hasAudio) {
    const graph = [
      `[0:a:0]asplit=${n}${segments.map((_, i) => `[a${i}]`).join("")}`,
      ...segments.map((g, i) => `[a${i}]atrim=start=${g.start.toFixed(3)}:end=${g.end.toFixed(3)},asetpts=PTS-STARTPTS[as${i}]`),
      `${segments.map((_, i) => `[as${i}]`).join("")}concat=n=${n}:v=0:a=1[ca]`,
      `[ca]${tail}`,
    ].join(";");
    args = ["-i", source, "-filter_complex", graph];
  } else {
    // A silent video still gets a track, so the slideshow's audio graph always has its input.
    args = ["-f", "lavfi", "-t", editedSec.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-filter_complex", `[0:a]${tail}`];
  }
  const part = `${out}.part.m4a`;
  try {
    await runFfmpeg(["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", ...args, "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-f", "ipod", part], editedSec, undefined, signal);
    renameSync(part, out);
  } finally {
    try { unlinkSync(part); } catch {}
  }
  return out;
}

/** Renders the slideshow. `captionsAss` is the captions' ASS text (already timed to the narration), when they're on. */
export async function renderSlideshow(o: {
  slides: RenderSlide[]; text: Slide[]; captionsAss: string | null; speechPath: string | null; musicPath: string | null;
  totalSec: number; outPath: string; signal?: AbortSignal; onProgress?: (f: number) => void;
}): Promise<{ durationSec: number }> {
  const textFile = `${o.outPath}.slides.ass`;
  const captionFile = `${o.outPath}.captions.ass`;
  const part = `${o.outPath}.part.mp4`;
  writeFileSync(textFile, slideTextAss(o.text, { numbers: o.text.length > 1, captionsOn: Boolean(o.captionsAss) }));
  if (o.captionsAss) writeFileSync(captionFile, o.captionsAss);
  const n = o.slides.length;
  const inputs: string[] = [];
  o.slides.forEach((s, i) => {
    const len = (s.seconds + (i < n - 1 ? FADE : 0)).toFixed(3);
    if (s.kind === "image") inputs.push("-i", s.path!);
    else if (s.kind === "video") inputs.push("-t", len, "-i", s.path!);
    else inputs.push("-f", "lavfi", "-t", len, "-i", `color=c=${CARD_COLOR}:s=${W}x${H}:r=${FPS}`);
  });
  if (o.speechPath) inputs.push("-i", o.speechPath);
  if (o.musicPath) inputs.push("-stream_loop", "-1", "-i", o.musicPath);
  const graph = slideshowFilterGraph({ slides: o.slides, ass: textFile, captionsAss: o.captionsAss ? captionFile : null, speech: Boolean(o.speechPath), music: Boolean(o.musicPath), totalSec: o.totalSec });
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    ...inputs, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-t", o.totalSec.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", part,
  ];
  try {
    await runFfmpeg(args, o.totalSec, o.onProgress, o.signal);
    renameSync(part, o.outPath);
  } finally {
    for (const f of [textFile, captionFile, part]) try { unlinkSync(f); } catch {}
  }
  o.onProgress?.(1);
  return { durationSec: (await probe(o.outPath)).durationSec };
}
