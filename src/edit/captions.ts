// Word-synced captions as an ASS subtitle file, burned in by ffmpeg's ass filter. A few words show at a
// time with the spoken word highlighted, placed clear of each app's buttons and caption overlay.
import { assHex, FONT_FAMILY, PALETTE } from "./fancy/palette.ts";
import type { Word } from "./transcribe.ts";

/** Fractions of the 1080x1920 frame that platform UI covers: top bar, bottom caption area, right-side buttons. */
export const SAFE_AREA = { top: 0.10, bottom: 0.20, right: 0.15, left: 0.06 } as const;

const W = 1080;
const H = 1920;
const WHITE = "&H00FFFFFF&";
const ACCENT = "&H0036D7FF&"; // warm yellow (ASS colours are BGR)
const HOLD = 0.25; // keep the last word of a group up a moment after it's said
const PAUSE = 0.4;

const clock = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** ASS reads { } as override tags and \ as escapes; show look-alikes instead. */
export const escape = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");

function groups(words: Word[], maxWords: number, breakAt: number[] = []): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    const crosses = (b: number) => prev!.start < b && b <= w.start;
    if (prev && (cur.length >= maxWords || /[.?!…]$/.test(prev.text) || w.start - prev.end > PAUSE || breakAt.some(crosses))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

export type CaptionPlace = "seam" | "lower";

const FANCY_CREAM = assHex(PALETTE.cream);
const FANCY_YELLOW = assHex(PALETTE.yellow);
const FANCY_SIZE = 84;
const FANCY_POP = 110; // percent scale on the spoken word
/** On the seam the caption sits in an ink box (85% opaque, 14 px of padding), so the gold rule never runs through it. */
const SEAM_BOX_ALPHA = 0.85;
const SEAM_PAD = 14;

/** The safe band across the frame: clear of the left edge and of the right-side buttons. */
const SAFE_LEFT = Math.ceil(W * SAFE_AREA.left);
const SAFE_RIGHT = W - Math.ceil(W * SAFE_AREA.right);
/** The safe band's centre, where Fancy captions are centred: the frame's (540) would push wide lines under the buttons. */
export const FANCY_CAPTION_X = Math.round((SAFE_LEFT + SAFE_RIGHT) / 2);
/**
 * Fancy styles' margins: libass wraps a positioned line at PlayResX less the style's margins, so these make a line
 * centred on FANCY_CAPTION_X at most as wide as the band, less the seam box's padding on each side (which also
 * covers the lower caption's outline and shadow) and a little for the italic's overhang. No line, box included,
 * reaches past the band.
 */
const ITALIC_OVERHANG = 6;
const FANCY_HALF_WIDTH = Math.min(FANCY_CAPTION_X - SAFE_LEFT, SAFE_RIGHT - FANCY_CAPTION_X) - SEAM_PAD - ITALIC_OVERHANG;
const FANCY_MARGIN_L = FANCY_CAPTION_X - FANCY_HALF_WIDTH;
const FANCY_MARGIN_R = W - (FANCY_CAPTION_X + FANCY_HALF_WIDTH);

/** Where a Fancy caption is anchored: centred on the seam of a split, or in the lower third inside SAFE_AREA. */
const placement = (place: CaptionPlace) =>
  place === "seam" ? `{\\an5\\pos(${FANCY_CAPTION_X},960)}` : `{\\an2\\pos(${FANCY_CAPTION_X},${H - Math.ceil(H * SAFE_AREA.bottom) - 40})}`;

export function buildAss(
  words: Word[],
  /** `breakAt`: times a group never spans (a word starting at or after one begins a new group), e.g. where placeAt changes */
  opts: { maxWords?: number; look?: "fancy"; placeAt?: (t: number) => CaptionPlace; breakAt?: number[] } = {},
): string {
  const marginL = Math.ceil(W * SAFE_AREA.left);
  const marginR = Math.ceil(W * SAFE_AREA.right);
  const marginV = Math.ceil(H * SAFE_AREA.bottom) + 40;
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...(opts.look === "fancy"
      ? [
        `Style: FancyCaption,${FONT_FAMILY},${FANCY_SIZE},${FANCY_CREAM},${FANCY_CREAM},${assHex(PALETTE.ink)},${assHex("#000000", PALETTE.shadowAlpha)},-1,-1,0,0,100,100,0,0,1,3,2,2,${FANCY_MARGIN_L},${FANCY_MARGIN_R},${marginV},1`,
        // BorderStyle 3 draws the outline colour as a box, the outline width as its padding.
        `Style: FancySeam,${FONT_FAMILY},${FANCY_SIZE},${FANCY_CREAM},${FANCY_CREAM},${assHex(PALETTE.ink, SEAM_BOX_ALPHA)},${assHex(PALETTE.ink, SEAM_BOX_ALPHA)},-1,-1,0,0,100,100,0,0,3,${SEAM_PAD},0,5,${FANCY_MARGIN_L},${FANCY_MARGIN_R},0,1`,
      ]
      : [`Style: Caption,Arial,78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,0,2,${marginL},${marginR},${marginV},1`]),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  const gs = groups(words, opts.maxWords ?? 3, opts.breakAt);
  gs.forEach((group, gi) => {
    const nextStart = gs[gi + 1]?.[0].start ?? Infinity;
    // Nor does the last word's hold run past a break (where the caption would sit in the wrong place).
    const nextBreak = opts.breakAt?.filter((b) => b > group[0].start).reduce((a, b) => Math.min(a, b), Infinity) ?? Infinity;
    group.forEach((word, wi) => {
      // Each word's event runs until the next word starts, so the group stays on screen without flicker.
      const start = word.start;
      const end = wi < group.length - 1 ? group[wi + 1].start : Math.min(word.end + HOLD, nextStart, nextBreak);
      if (opts.look === "fancy") {
        const pop = `{\\c${FANCY_YELLOW}&\\fscx${FANCY_POP}\\fscy${FANCY_POP}}`;
        const rest = `{\\c${FANCY_CREAM}&\\fscx100\\fscy100}`;
        const fancy = group.map((w, k) => (k === wi ? `${pop}${escape(w.text)}${rest}` : escape(w.text))).join(" ");
        const place = opts.placeAt?.(word.start) ?? "lower";
        const style = place === "seam" ? "FancySeam" : "FancyCaption";
        events.push(`Dialogue: 0,${clock(start)},${clock(Math.max(end, start + 0.01))},${style},,0,0,0,,${placement(place)}${fancy}`);
        return;
      }
      const text = group
        .map((w, k) => (k === wi ? `{\\c${ACCENT}}${escape(w.text)}{\\c${WHITE}}` : escape(w.text)))
        .join(" ");
      events.push(`Dialogue: 0,${clock(start)},${clock(Math.max(end, start + 0.01))},Caption,,0,0,0,,${text}`);
    });
  });
  return [...head, ...events, ""].join("\n");
}
