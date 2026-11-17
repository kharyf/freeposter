// The Fancy cover: a 9:16 frame of the speaker from the edit with the title in yellow italic serif and a gold rule
// under it, over an ink gradient. The title sits in the top third, or low when the face would be under it; the
// gradient darkens that edge. A blank title leaves just the frame and the gradient.
import { execFile } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config.ts";
import { probe } from "../../media.ts";
import { sourceTime, type Segment } from "../cuts.ts";
import { escape, SAFE_AREA } from "../captions.ts";
import { cropAround, type FaceKey } from "../reframe.ts";
import { filterPath } from "../transcribe.ts";
import { assHex, FONT_FAMILY, fancyFontDir, PALETTE } from "./palette.ts";
import { faceAt } from "./render.ts";

const run = promisify(execFile);
const W = 1080;
const H = 1920;
const SIZE = 120;
const WRAP = 14;
const TOP = 260;
/** Where the rule sits in the lower placement: its bottom 40 px above the bottom SAFE_AREA. */
const LOW_RULE_BOTTOM = H - Math.ceil(H * SAFE_AREA.bottom) - 40;
const RULE_GAP = 36;
const RULE_H = 6;
/** Playfair Bold Italic's average advance, as a fraction of the font size (an estimate, for the rule's width). */
const ADVANCE = 0.42;
/** The gradient: clear over 55% of the height, rising to 0.85 ink at the edge the title sits on. */
const CLEAR_AT = 0.55;
const INK_EDGE = 0.85;
/** A face whose top is higher than this (as a fraction of the frame) would sit under a top-third title. */
const FACE_TOP_LIMIT = 0.4;

export type CoverPlace = "top" | "bottom";

/**
 * Where the title goes: the top third, unless the face's top (within the cover crop) is above 40% of the frame
 * height; then low, above the bottom SAFE_AREA. Without a face, the top.
 */
export function coverPlace(face: FaceKey | null, crop: { y: number; h: number }): CoverPlace {
  if (!face) return "top";
  return (face.cy - face.size / 2 - crop.y) / crop.h < FACE_TOP_LIMIT ? "bottom" : "top";
}

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

export function coverAss(title: string, place: CoverPlace = "top"): string {
  const lines = wrap(title, WRAP);
  const longest = Math.max(...lines.map((l) => l.length));
  // A single word longer than a line gets a smaller size, so it stays inside the margins.
  const size = longest > WRAP ? Math.floor((SIZE * WRAP) / longest) : SIZE;
  const line = Math.round(size * 1.18);
  const ruleW = Math.round(Math.min(W - 160, Math.max(200, longest * size * ADVANCE * 0.6)));
  const ruleX = Math.round((W - ruleW) / 2);
  const ruleY = place === "top" ? TOP + lines.length * line + RULE_GAP : LOW_RULE_BOTTOM - RULE_H;
  const text = place === "top" ? `{\\an8\\pos(${W / 2},${TOP})}` : `{\\an2\\pos(${W / 2},${ruleY - RULE_GAP})}`;
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
    `Style: Cover,${FONT_FAMILY},${size},${assHex(PALETTE.yellow)},${assHex(PALETTE.yellow)},${assHex(PALETTE.ink)},${assHex("#000000", PALETTE.shadowAlpha)},-1,-1,0,0,100,100,0,0,1,0,4,8,60,60,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 1,0:00:00.00,0:00:10.00,Cover,,0,0,0,,${text}${lines.map(escape).join("\\N")}`,
    `Dialogue: 0,0:00:00.00,0:00:10.00,Cover,,0,0,0,,{\\an7\\pos(${ruleX},${ruleY})\\shad0\\c${assHex(PALETTE.gold)}\\p1}m 0 0 l ${ruleW} 0 ${ruleW} ${RULE_H} 0 ${RULE_H}{\\p0}`,
    "",
  ].join("\n");
}

/** Writes the cover JPEG for edited time `at` and returns its path. */
export async function makeCover(source: string, opts: { at: number; segments: Segment[]; faces: FaceKey[] | null; title: string; out: string }): Promise<string> {
  const src = await probe(source);
  const t = Math.max(0, Math.min(sourceTime(opts.segments, opts.at) ?? opts.segments.at(-1)?.end ?? 0, src.durationSec - 0.05));
  const seg = opts.segments.find((s) => t >= s.start - 1e-9 && t <= s.end + 1e-9);
  const face = faceAt(opts.faces, t, seg);
  const { x, y, w, h } = cropAround(face, src, 9 / 16, 1);
  const place = coverPlace(face, { y, h });
  const ink = PALETTE.ink.slice(1);
  // The ink darkens the edge the title sits on.
  const ramp = place === "top" ? `(${CLEAR_AT}*H-Y)/(${CLEAR_AT}*H)` : `(Y-${1 - CLEAR_AT}*H)/(${CLEAR_AT}*H)`;
  const alpha = `255*${INK_EDGE}*clip(${ramp},0,1)`;
  const ass = opts.title.trim() ? `${opts.out}.ass` : null;
  if (ass) writeFileSync(ass, coverAss(opts.title, place));
  const graph = [
    `[0:v]crop=${w}:${h}:${x}:${y},scale=${W}:${H}:flags=lanczos,setsar=1,format=rgba[f]`,
    `color=c=0x${ink}:s=${W}x${H}:d=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[g]`,
    `[f][g]overlay=shortest=1${ass ? `,ass=filename=${filterPath(ass)}:fontsdir=${filterPath(fancyFontDir())}` : ""},format=yuvj420p[out]`,
  ].join(";");
  try {
    await run(config.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(3), "-i", source,
      "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-update", "1", "-q:v", "3", opts.out,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`the cover didn't render: ${(err as any).stderr?.trim() || (err as Error).message}`);
  } finally {
    if (ass) try { unlinkSync(ass); } catch {}
  }
  return opts.out;
}
