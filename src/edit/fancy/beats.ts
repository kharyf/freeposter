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
/** The shortest beat (except a whole video shorter than this). */
const MIN_BEAT = 0.5;
/** How far a cadence split may move from its even spacing to land in a word gap. */
const GAP_REACH = 0.4;
const FULL_ZOOMS = [1.0, 1.18, 1.08, 1.3];
const SPLIT_ZOOMS = [1.0, 1.12];
const PUSH_PER_SEC = 0.025;
const EPS = 1e-6;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const isSplit = (layout: Layout) => layout !== "full";

/** `clipStart` is the time the graphic clip's first frame plays. */
interface Coarse { start: number; end: number; layout: Layout; graphic: number | null; clipStart: number }

/**
 * Each graphic's window as a split beat (alternating halves, speaker at the bottom first), full beats between,
 * from exactly 0 to exactly durationSec. The plan is checked upstream; this only keeps a bad window from making
 * a short, empty or backwards beat: windows are taken in time order (keeping their indices), clamped after the
 * one before, and one left under 0.5 s is dropped. A full beat under 0.5 s then goes: between two splits, into
 * the split before it (its graphic runs past its planned end); at the start, into the beat after it (whose
 * graphic then starts with it); at the end, into the beat before it.
 */
function coarseBeats(durationSec: number, graphics: PlannedGraphic[]): Coarse[] {
  const order = graphics.map((g, i) => ({ g, i })).sort((a, b) => a.g.start - b.g.start || a.i - b.i);
  const raw: Coarse[] = [];
  let at = 0;
  for (const { g, i } of order) {
    const start = clamp(g.start, at, durationSec);
    const end = clamp(g.end, start, durationSec);
    if (end - start < MIN_BEAT - EPS) continue;
    if (start > at) raw.push({ start: at, end: start, layout: "full", graphic: null, clipStart: 0 });
    raw.push({ start, end, layout: "speakerBottom", graphic: i, clipStart: g.start });
    at = end;
  }
  if (durationSec > at || !raw.length) raw.push({ start: at, end: durationSec, layout: "full", graphic: null, clipStart: 0 });

  const out: Coarse[] = [];
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    const short = c.layout === "full" && c.end - c.start < MIN_BEAT - EPS && raw.length > 1;
    if (short && out.length) { out.at(-1)!.end = c.end; continue; }
    if (short) {
      // The first beat: the next one starts at 0 instead, and its graphic with it.
      const next = raw[k + 1];
      next.start = c.start;
      if (next.graphic !== null) next.clipStart = c.start;
      continue;
    }
    out.push(c);
  }
  let splits = 0;
  for (const c of out) if (c.graphic !== null) c.layout = splits++ % 2 === 0 ? "speakerBottom" : "speakerTop";
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

/** The point in a word gap nearest `aim`, at most 0.4 s from it; null when no gap is that close. */
function nearestGap(gaps: [number, number][], aim: number): number | null {
  let best: number | null = null;
  for (const [a, b] of gaps) {
    const from = Math.max(a, aim - GAP_REACH);
    const to = Math.min(b, aim + GAP_REACH);
    if (from > to) continue;
    const p = clamp(aim, from, to);
    if (best === null || Math.abs(p - aim) < Math.abs(best - aim)) best = p;
  }
  return best;
}

const fits = (len: number) => len >= MIN_BEAT - EPS && len <= MAX_STRETCH + EPS;

/**
 * Where a coarse beat splits so no stretch inside it runs past 2.0 s without a change. Each stretch between
 * hard changes (the beat's ends and the cuts inside it) longer than 2.0 s is cut into ceil(len / 2.0) near-equal
 * pieces; each split moves to the nearest word gap within 0.4 s when the pieces either side of it stay 0.5–2.0 s.
 */
function cadenceSplits(beat: Coarse, gaps: [number, number][], cuts: number[]): number[] {
  const changes = [beat.start, ...cuts.filter((c) => c > beat.start + EPS && c < beat.end - EPS), beat.end];
  const out: number[] = [];
  for (let s = 1; s < changes.length; s++) {
    const a = changes[s - 1];
    const b = changes[s];
    const len = b - a;
    if (len <= MAX_STRETCH + EPS) continue;
    const n = Math.ceil(len / MAX_STRETCH - EPS);
    const even = (i: number) => (i === n ? b : a + (len * i) / n);
    let prev = a;
    for (let i = 1; i < n; i++) {
      const gap = nearestGap(gaps, even(i));
      const at = gap !== null && fits(gap - prev) && fits(even(i + 1) - gap) ? gap : even(i);
      out.push(at);
      prev = at;
    }
  }
  return out;
}

/**
 * The beats of a Fancy edit, at least 0.5 s each. Each graphic's window becomes a split section, the time
 * between them full frame (see coarseBeats for windows and gaps under 0.5 s), and with punchIn on every stretch
 * longer than 2.0 s without a beat boundary or footage cut is cut into near-equal pieces of at most 2.0 s, each
 * split nudged into a nearby word gap (see cadenceSplits). Full beats cycle their zoom through 1.00, 1.18, 1.08,
 * 1.30 across the video; split beats alternate 1.00 and 1.12 within each section. With punchIn off: no zoom,
 * push or snap, and no cadence splits (cadenceProblems reports what that leaves). Graphics are never invented:
 * with fewer graphics than the rules want, there are fewer splits.
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
