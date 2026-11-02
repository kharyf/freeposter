// Decides which stretches of the source to keep: drops filler words, long pauses, and earlier takes of a
// phrase the speaker repeated, and never cuts through a word.
import type { Word } from "./transcribe.ts";

/** seconds on the source timeline, kept */
export interface Segment {
  start: number;
  end: number;
}

export const FILLERS: ReadonlySet<string> = new Set(["um", "uh", "erm", "er", "ah", "hmm", "mm", "umm", "uhh"]);

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const endsSentence = (text: string) => /[,.?!…;:-]$/.test(text);

/** Longest phrase checked for a repeated take. */
const MAX_REPEAT = 8;
/** A pause this long (or punctuation) between two copies of a phrase marks a retake. */
const RETAKE_GAP = 0.25;

/** Indices (into words) of the earlier copies of repeated phrases. */
function retakes(words: Word[]): Set<number> {
  const drop = new Set<number>();
  for (let i = 1; i < words.length; i++) {
    const broke = words[i].start - words[i - 1].end > RETAKE_GAP || endsSentence(words[i - 1].text);
    if (!broke) continue;
    for (let n = Math.min(MAX_REPEAT, i, words.length - i); n >= 1; n--) {
      let same = true;
      for (let k = 0; k < n && same; k++) same = norm(words[i - n + k].text) === norm(words[i + k].text);
      if (same) {
        for (let k = i - n; k < i; k++) drop.add(k);
        break;
      }
    }
  }
  return drop;
}

export function planCuts(words: Word[], durationSec: number, opts: { maxGap?: number; pad?: number } = {}): Segment[] {
  const maxGap = opts.maxGap ?? 0.35;
  const pad = opts.pad ?? 0.08;
  const spoken = words.filter((w) => norm(w.text) && !FILLERS.has(norm(w.text)));
  const late = retakes(spoken);
  const keep = new Set(spoken.filter((_, i) => !late.has(i)));
  if (!keep.size) return [{ start: 0, end: durationSec }];

  // Runs of kept words with no removed word between them and no pause longer than maxGap.
  const runs: { first: number; last: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!keep.has(words[i])) continue;
    const run = runs.at(-1);
    // Any removed word (filler or retake) between two kept ones ends the run.
    if (run && run.last === i - 1 && words[i].start - words[run.last].end <= maxGap) run.last = i;
    else runs.push({ first: i, last: i });
  }

  // Pad each run, but never into a neighbouring word or past the clip.
  const segs: Segment[] = runs.map(({ first, last }) => ({
    start: Math.max(words[first].start - pad, first > 0 ? words[first - 1].end : 0, 0),
    end: Math.min(words[last].end + pad, last < words.length - 1 ? words[last + 1].start : durationSec, durationSec),
  }));

  const merged: Segment[] = [];
  for (const s of segs) {
    const prev = merged.at(-1);
    if (prev && s.start - prev.end < 0.05) prev.end = Math.max(prev.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/** The words that survive the cut, with times moved onto the edited timeline. */
export function remapWords(words: Word[], segments: Segment[]): Word[] {
  const out: Word[] = [];
  let offset = 0;
  for (const s of segments) {
    for (const w of words) {
      if (w.start >= s.start - 1e-9 && w.end <= s.end + 1e-9 && norm(w.text) && !FILLERS.has(norm(w.text))) {
        out.push({ text: w.text, start: offset + (w.start - s.start), end: offset + (w.end - s.start) });
      }
    }
    offset += s.end - s.start;
  }
  return out;
}
