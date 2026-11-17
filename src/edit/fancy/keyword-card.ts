// The graphic that always works: the key phrase in yellow italic serif on ink, with a gold underline drawing in
// beneath it. ffmpeg and libass only, so it needs none of the production tools. It ends every fallback chain.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { config } from "../../config.ts";
import { filterPath } from "../transcribe.ts";
import { assHex, FONT_FAMILY, fancyFontDir, PALETTE } from "./palette.ts";
import { GRAPHIC_SIZE } from "./templates.ts";

const run = promisify(execFile);
const { width: W, height: H } = GRAPHIC_SIZE;
const MARGIN = 64; // clear of the 48 px edge rule
const SIZE = 110;
/** Playfair Bold Italic's average advance, as a fraction of the font size (an estimate, for wrapping and the underline). */
const ADVANCE = 0.42;

/** ASS reads { } as override tags and \ as escapes; show look-alikes instead. */
const escape = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");

/** Greedy word wrap to at most `max` characters a line (a single longer word gets its own line). */
function wrap(words: string[], max: number): string[] {
  const lines: string[] = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (last !== undefined && (last + " " + w).length <= max) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines;
}

/** The largest size, 110 px down, at which the phrase fits the card in at most three lines. */
function layout(phrase: string): { size: number; lines: string[] } {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  for (let size = SIZE; ; size -= 8) {
    const max = Math.floor((W - 2 * MARGIN) / (size * ADVANCE));
    const lines = wrap(words, max);
    if (size <= 48 || (lines.length <= 3 && lines.every((l) => l.length <= max))) return { size, lines };
  }
}

const clock = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `0:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

export function keywordCardAss(phrase: string, durationSec: number): string {
  const { size, lines } = layout(phrase);
  const lineHeight = Math.round(size * 1.3);
  const cy = Math.round(H / 2 - 20);
  const textBottom = cy + (lines.length * lineHeight) / 2;
  const longest = Math.max(...lines.map((l) => l.length));
  const ruleW = Math.round(Math.min(W - 2 * MARGIN, Math.max(160, longest * size * ADVANCE * 0.7)));
  const ruleX = Math.round((W - ruleW) / 2);
  const ruleY = Math.round(textBottom + 24);
  const ms = Math.round(durationSec * 1000);
  const end = clock(durationSec + 0.05);
  const yellow = assHex(PALETTE.yellow);
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
    `Style: FancyCaption,${FONT_FAMILY},${size},${yellow},${yellow},${assHex(PALETTE.ink)},${assHex("#000000", PALETTE.shadowAlpha)},-1,-1,0,0,100,100,0,0,1,0,3,5,${MARGIN},${MARGIN},0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    // The phrase fades in over 0.3 s and keeps growing slowly to the end, so the card never sits still.
    `Dialogue: 1,${clock(0)},${end},FancyCaption,,0,0,0,,{\\an5\\pos(${W / 2},${cy})\\fad(300,0)\\fscx96\\fscy96\\t(0,${ms},0.6,\\fscx104\\fscy104)}${lines.map(escape).join("\\N")}`,
    // The gold underline, drawn left to right after the phrase lands.
    `Dialogue: 0,${clock(0)},${end},FancyCaption,,0,0,0,,{\\an7\\pos(${ruleX},${ruleY})\\bord0\\shad0\\c${assHex(PALETTE.gold)}\\clip(${ruleX},${ruleY - 4},${ruleX},${ruleY + 10})\\t(300,800,0.5,\\clip(${ruleX},${ruleY - 4},${ruleX + ruleW},${ruleY + 10}))\\p1}m 0 0 l ${ruleW} 0 ${ruleW} 5 0 5{\\p0}`,
    "",
  ].join("\n");
}

/** An opaque 1080x960, 30 fps clip of the phrase, durationSec long. */
export async function renderKeywordCard(phrase: string, durationSec: number, out: string, signal?: AbortSignal): Promise<{ path: string; durationSec: number }> {
  mkdirSync(dirname(out), { recursive: true });
  const ass = out.replace(/\.[^.\\/]+$/, "") + ".ass";
  writeFileSync(ass, keywordCardAss(phrase, durationSec));
  const vf = `ass=filename=${filterPath(ass)}:fontsdir=${filterPath(fancyFontDir())},format=yuv420p`;
  try {
    await run(config.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=0x${PALETTE.ink.slice(1)}:s=${W}x${H}:r=30`, "-t", String(durationSec),
      "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", "30", out,
    ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal });
  } catch (err) {
    throw new Error(`the keyword card didn't render: ${(err as any).stderr?.trim() || (err as Error).message}`);
  }
  return { path: out, durationSec };
}
