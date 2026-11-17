// The Fancy cover: a 9:16 frame of the speaker from the edit, darkened toward the top by an ink gradient, with the
// title in yellow italic serif and a gold rule under it. A blank title leaves just the frame and the gradient.
import { execFile } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config.ts";
import { probe } from "../../media.ts";
import { sourceTime, type Segment } from "../cuts.ts";
import { cropAround, type FaceKey } from "../reframe.ts";
import { filterPath } from "../transcribe.ts";
import { assHex, FONT_FAMILY, fancyFontDir, PALETTE } from "./palette.ts";
import { faceAt } from "./render.ts";

const run = promisify(execFile);
const W = 1080;
const H = 1920;
const SIZE = 120;
const LINE = Math.round(SIZE * 1.18);
const WRAP = 14;
const TOP = 260;
/** Playfair Bold Italic's average advance, as a fraction of the font size (an estimate, for the rule's width). */
const ADVANCE = 0.42;
/** The gradient: fully clear from 55% of the height down, rising to 0.85 ink at the top. */
const CLEAR_AT = 0.55;
const INK_TOP = 0.85;

/** ASS reads { } as override tags and \ as escapes; show look-alikes instead. */
const escape = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");

/** Greedy word wrap to at most `max` characters a line (a single longer word gets its own line). */
function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const w of text.trim().split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${w}`.length <= max) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines;
}

export function coverAss(title: string): string {
  const lines = wrap(title, WRAP);
  const longest = Math.max(...lines.map((l) => l.length));
  const ruleW = Math.round(Math.min(W - 160, Math.max(200, longest * SIZE * ADVANCE * 0.6)));
  const ruleX = Math.round((W - ruleW) / 2);
  const ruleY = TOP + lines.length * LINE + 36;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cover,${FONT_FAMILY},${SIZE},${assHex(PALETTE.yellow)},${assHex(PALETTE.yellow)},${assHex(PALETTE.ink)},${assHex("#000000", PALETTE.shadowAlpha)},-1,-1,0,0,100,100,0,0,1,0,4,8,60,60,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 1,0:00:00.00,0:00:10.00,Cover,,0,0,0,,{\\an8\\pos(${W / 2},${TOP})}${lines.map(escape).join("\\N")}`,
    `Dialogue: 0,0:00:00.00,0:00:10.00,Cover,,0,0,0,,{\\an7\\pos(${ruleX},${ruleY})\\shad0\\c${assHex(PALETTE.gold)}\\p1}m 0 0 l ${ruleW} 0 ${ruleW} 6 0 6{\\p0}`,
    "",
  ].join("\n");
}

/** Writes the cover JPEG for edited time `at` and returns its path. */
export async function makeCover(source: string, opts: { at: number; segments: Segment[]; faces: FaceKey[] | null; title: string; out: string }): Promise<string> {
  const src = await probe(source);
  const t = Math.max(0, Math.min(sourceTime(opts.segments, opts.at) ?? opts.segments.at(-1)?.end ?? 0, src.durationSec - 0.05));
  const seg = opts.segments.find((s) => t >= s.start - 1e-9 && t <= s.end + 1e-9);
  const { x, y, w, h } = cropAround(faceAt(opts.faces, t, seg), src, 9 / 16, 1);
  const ink = PALETTE.ink.slice(1);
  const alpha = `255*${INK_TOP}*clip((${CLEAR_AT}*H-Y)/(${CLEAR_AT}*H),0,1)`;
  const ass = opts.title.trim() ? `${opts.out}.ass` : null;
  if (ass) writeFileSync(ass, coverAss(opts.title));
  const graph = [
    `[0:v]crop=${w}:${h}:${x}:${y},scale=${W}:${H}:flags=lanczos,setsar=1,format=rgba[f]`,
    `color=c=0x${ink}:s=${W}x${H}:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[g]`,
    `[f][g]overlay=shortest=1${ass ? `,ass=filename=${filterPath(ass)}:fontsdir=${filterPath(fancyFontDir())}` : ""},format=yuvj420p[out]`,
  ].join(";");
  try {
    await run(config.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(3), "-i", source,
      "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "3", opts.out,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`the cover didn't render: ${(err as any).stderr?.trim() || (err as Error).message}`);
  } finally {
    if (ass) try { unlinkSync(ass); } catch {}
  }
  return opts.out;
}
