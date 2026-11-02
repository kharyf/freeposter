// Word-synced captions as an ASS subtitle file, burned in by ffmpeg's ass filter. A few words show at a
// time with the spoken word highlighted, placed clear of each app's buttons and caption overlay.
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
const escape = (text: string) => text.replace(/\\/g, "＼").replace(/\{/g, "｛").replace(/\}/g, "｝");

function groups(words: Word[], maxWords: number): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (cur.length >= maxWords || /[.?!…]$/.test(prev.text) || w.start - prev.end > PAUSE)) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function buildAss(words: Word[], opts: { maxWords?: number } = {}): string {
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
    `Style: Caption,Arial,78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,0,2,${marginL},${marginR},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  const gs = groups(words, opts.maxWords ?? 3);
  gs.forEach((group, gi) => {
    const nextStart = gs[gi + 1]?.[0].start ?? Infinity;
    group.forEach((word, wi) => {
      // Each word's event runs until the next word starts, so the group stays on screen without flicker.
      const start = word.start;
      const end = wi < group.length - 1 ? group[wi + 1].start : Math.min(word.end + HOLD, nextStart);
      const text = group
        .map((w, k) => (k === wi ? `{\\c${ACCENT}}${escape(w.text)}{\\c${WHITE}}` : escape(w.text)))
        .join(" ");
      events.push(`Dialogue: 0,${clock(start)},${clock(Math.max(end, start + 0.01))},Caption,,0,0,0,,${text}`);
    });
  });
  return [...head, ...events, ""].join("\n");
}
