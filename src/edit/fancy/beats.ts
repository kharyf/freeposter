// The Fancy style's beats: the stretches the compositor renders, each either the speaker full frame or a split
// with the speaker in one half and the planned graphic in the other, with its zoom, slow push and snap. The beats
// tile the edited timeline exactly (each starts where the one before ends), and they keep the hard rules: splits
// alternate the speaker's half, starting at the bottom, and with punchIn on no stretch runs longer than 2.0 s
// without a hard change (a beat boundary or a footage cut). Times are on the edited timeline throughout.
import type { Word } from "../transcribe.ts";
import type { PlannedGraphic } from "./plan.ts";

export type Layout = "full" | "speakerTop" | "speakerBottom";

export interface Beat {
  start: number;
  end: number;
  layout: Layout;
  /** index into the plan's graphics, null on a full beat */
  graphic: number | null;
  /** seconds into the graphic clip where the beat starts */
  graphicOffset: number;
  zoom: number;
  pushPerSec: number;
  /** when the picture snaps in, held to the beat's end */
  snapAt: number | null;
}

/** The longest stretch without a hard change. */
const MAX_STRETCH = 2.0;
/** A beat splits at the word gap nearest this far in, between SPLIT_MIN and MAX_STRETCH. */
const SPLIT_AIM = 1.6;
const SPLIT_MIN = 1.2;
const FULL_ZOOMS = [1.0, 1.18, 1.08, 1.3];
const SPLIT_ZOOMS = [1.0, 1.12];
const PUSH_PER_SEC = 0.025;
const EPS = 1e-6;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const isSplit = (layout: Layout) => layout !== "full";

interface Coarse { start: number; end: number; layout: Layout; graphic: number | null; clipStart: number }

/** Each graphic's window as a split beat (alternating halves, speaker at the bottom first), full beats between. */
function coarseBeats(durationSec: number, graphics: PlannedGraphic[]): Coarse[] {
  const out: Coarse[] = [];
  let at = 0;
  let splits = 0;
  graphics.forEach((g, i) => {
    // The plan is checked upstream; this only keeps a bad window from making an empty or backwards beat.
    const start = clamp(g.start, at, durationSec);
    const end = clamp(g.end, start, durationSec);
    if (end - start <= EPS) return;
    if (start - at > EPS) out.push({ start: at, end: start, layout: "full", graphic: null, clipStart: 0 });
    else if (out.length) out.at(-1)!.end = start;
    out.push({ start, end, layout: splits++ % 2 === 0 ? "speakerBottom" : "speakerTop", graphic: i, clipStart: g.start });
    at = end;
  });
  if (durationSec - at > EPS) out.push({ start: at, end: durationSec, layout: "full", graphic: null, clipStart: 0 });
  else if (out.length) out.at(-1)!.end = durationSec;
  return out;
}

/** The silences between words (and before the first and after the last), as [start, end]. */
function wordGaps(words: Word[]): [number, number][] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const gaps: [number, number][] = [];
  let heard = -Infinity;
  for (const w of sorted) {
    if (w.start - heard > EPS) gaps.push([heard, w.start]);
    heard = Math.max(heard, w.end);
  }
  gaps.push([heard, Infinity]);
  return gaps;
}

/** The point in a word gap nearest `last + 1.6`, within [last + 1.2, last + 2.0]; null when no gap reaches it. */
function gapSplit(gaps: [number, number][], last: number): number | null {
  const lo = last + SPLIT_MIN;
  const hi = last + MAX_STRETCH;
  const aim = last + SPLIT_AIM;
  let best: number | null = null;
  for (const [a, b] of gaps) {
    const from = Math.max(a, lo);
    const to = Math.min(b, hi);
    if (from > to) continue;
    const p = clamp(aim, from, to);
    if (best === null || Math.abs(p - aim) < Math.abs(best - aim)) best = p;
  }
  return best;
}

/** Where a coarse beat splits so no stretch inside it runs past 2.0 s without a change. */
function cadenceSplits(beat: Coarse, gaps: [number, number][], cuts: number[]): number[] {
  const inside = cuts.filter((c) => c > beat.start + EPS && c < beat.end - EPS);
  const out: number[] = [];
  let last = beat.start;
  while (beat.end - last > MAX_STRETCH + EPS) {
    const reached = inside.filter((c) => c > last + EPS && c <= last + MAX_STRETCH + EPS);
    if (reached.length) { last = reached.at(-1)!; continue; }
    const at = gapSplit(gaps, last) ?? last + MAX_STRETCH;
    out.push(at);
    last = at;
  }
  return out;
}

/**
 * The beats of a Fancy edit. Each graphic's window becomes a split section, the time between them full frame,
 * and with punchIn on any stretch longer than 2.0 s without a beat boundary or footage cut is split at the word
 * gap nearest 1.6 s in (between 1.2 and 2.0 s), else at 2.0 s exactly. Full beats cycle their zoom through
 * 1.00, 1.18, 1.08, 1.30 across the video; split beats alternate 1.00 and 1.12 within each section. With
 * punchIn off: no zoom, push or snap, and no cadence splits (cadenceProblems reports what that leaves).
 * Graphics are never invented: with fewer graphics than the rules want, there are fewer splits.
 */
export function planBeats(input: { durationSec: number; words: Word[]; graphics: PlannedGraphic[]; emphasis: number[]; cutTimes: number[]; punchIn: boolean }): Beat[] {
  const { durationSec, words, graphics, emphasis, cutTimes, punchIn } = input;
  if (!(durationSec > 0)) return [];
  const gaps = wordGaps(words);
  const cuts = [...cutTimes].sort((a, b) => a - b);
  const snaps = [...emphasis].sort((a, b) => a - b);

  const out: Beat[] = [];
  let fullCount = 0;
  for (const c of coarseBeats(durationSec, graphics)) {
    const points = [c.start, ...(punchIn ? cadenceSplits(c, gaps, cuts) : []), c.end];
    for (let k = 0; k < points.length - 1; k++) {
      const start = points[k];
      const end = points[k + 1];
      const zoom = isSplit(c.layout) ? SPLIT_ZOOMS[k % SPLIT_ZOOMS.length] : FULL_ZOOMS[fullCount++ % FULL_ZOOMS.length];
      out.push({
        start,
        end,
        layout: c.layout,
        graphic: c.graphic,
        graphicOffset: c.graphic === null ? 0 : start - c.clipStart,
        zoom: punchIn ? zoom : 1,
        pushPerSec: punchIn ? PUSH_PER_SEC : 0,
        snapAt: punchIn ? snaps.find((t) => t >= start - EPS && t < end - EPS) ?? null : null,
      });
    }
  }
  return out;
}

const sec = (x: number) => `${x.toFixed(2)}s`;

/**
 * What breaks the hard rules: each stretch longer than 2.0 s without a beat boundary or footage cut, and each
 * split section (consecutive split beats sharing a graphic, numbered from 1) on the wrong half. The count of
 * split sections isn't checked here: the beats can't tell whether the plan had graphics enough for them.
 */
export function cadenceProblems(beats: Beat[], cutTimes: number[]): string[] {
  if (!beats.length) return [];
  const problems: string[] = [];
  const end = beats.at(-1)!.end;
  const changes = [...beats.map((b) => b.start), end, ...cutTimes.filter((c) => c > beats[0].start && c < end)].sort((a, b) => a - b);
  for (let i = 1; i < changes.length; i++) {
    if (changes[i] - changes[i - 1] > MAX_STRETCH + EPS) problems.push(`no change between ${sec(changes[i - 1])} and ${sec(changes[i])}`);
  }
  let section = 0;
  beats.forEach((b, i) => {
    if (!isSplit(b.layout)) return;
    const prev = beats[i - 1];
    if (prev && isSplit(prev.layout) && prev.graphic === b.graphic) return;
    const want: Layout = section % 2 === 0 ? "speakerBottom" : "speakerTop";
    section++;
    if (b.layout !== want) problems.push(`split ${section} doesn't alternate`);
  });
  return problems;
}
