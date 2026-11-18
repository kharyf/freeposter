// Scoring: pure functions over snapshots and labels, no store access.
import type { Job, Platform } from "../types.ts";
import { AGES, type Snapshot, type VideoLabels } from "./types.ts";

export type ScoreAge = "24h" | "72h" | "7d";
export const SCORE_AGES: ScoreAge[] = ["24h", "72h", "7d"];
export type LabelDimension = "hook" | "angle" | "cta" | "style" | "type" | "source";

const BASELINE_SIZE = 30;
const MIN_BASELINE = 8;
const BOOTSTRAP_RESAMPLES = 1000;

/** log1p(value) at ageSec, interpolated linearly between the nearest points on each side; null without extrapolating. */
export function valueAtAge(points: { ageSec: number; value: number }[], ageSec: number): number | null {
  let before: { ageSec: number; value: number } | null = null;
  let after: { ageSec: number; value: number } | null = null;
  for (const p of points) {
    if (p.ageSec <= ageSec && (!before || p.ageSec > before.ageSec)) before = p;
    if (p.ageSec >= ageSec && (!after || p.ageSec < after.ageSec)) after = p;
  }
  if (!before || !after) return null;
  if (before.ageSec === after.ageSec) return Math.log1p(before.value);
  const a = Math.log1p(before.value);
  const b = Math.log1p(after.value);
  return a + ((b - a) * (ageSec - before.ageSec)) / (after.ageSec - before.ageSec);
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** median and count over log1p(views) values */
export function baseline(values: number[]): { median: number; n: number } {
  return { median: median(values), n: values.length };
}

/** mid-rank percentile, 0-100; NaN for an empty baseline (callers treat it as no score) */
export function percentile(value: number, baselineValues: number[]): number {
  const n = baselineValues.length;
  if (n === 0) return NaN;
  let below = 0;
  let equal = 0;
  for (const b of baselineValues) {
    if (b < value) below++;
    else if (b === value) equal++;
  }
  return (100 * (below + 0.5 * equal)) / n;
}

/** beta-binomial shrinkage toward the prior mean */
export function shrinkRate(successes: number, trials: number, priorMean: number, priorWeight = 200): number {
  return (successes + priorMean * priorWeight) / (trials + priorWeight);
}

/** a Job with its publish time (the jobs.published_at column, which the Job type does not carry) */
export type ScoredJob = Job & { publishedAt: number | null };

export interface VideoScore {
  postId: number;
  perPlatform: Partial<Record<Platform, Partial<Record<ScoreAge, number>>>>;
  overall: Partial<Record<ScoreAge, number>>;
  provisional: Partial<Record<ScoreAge, boolean>>;
}

export function scoreVideos(input: {
  labels: VideoLabels[];
  snapshotsByJob: Map<number, Snapshot[]>;
  jobs: ScoredJob[];
  now: number;
}): VideoScore[] {
  const { labels, snapshotsByJob, jobs, now } = input;
  const cache = new Map<string, number | null>();
  const get = (job: ScoredJob, age: ScoreAge): number | null => {
    const key = `${job.id}:${age}`;
    let v = cache.get(key);
    if (v === undefined) {
      const points = (snapshotsByJob.get(job.id) ?? [])
        .filter((s) => s.reading.views !== null)
        .map((s) => ({ ageSec: s.ageSec, value: s.reading.views as number }));
      v = valueAtAge(points, AGES[age]);
      cache.set(key, v);
    }
    return v;
  };

  const baselineFor = (job: ScoredJob, age: ScoreAge): number[] =>
    jobs
      .filter((j) => j.accountId === job.accountId && j.postId !== job.postId && j.publishedAt != null && j.publishedAt <= now)
      .sort((a, b) => b.publishedAt! - a.publishedAt! || b.id - a.id)
      .map((j) => get(j, age))
      .filter((v): v is number => v !== null)
      .slice(0, BASELINE_SIZE);

  return labels.map((label) => {
    const score: VideoScore = { postId: label.postId, perPlatform: {}, overall: {}, provisional: {} };
    const mine = jobs.filter((j) => j.postId === label.postId);
    for (const age of SCORE_AGES) {
      const byPlatform = new Map<Platform, number[]>();
      let provisional = false;
      for (const job of mine) {
        const v = get(job, age);
        if (v === null) {
          provisional = true;
          continue;
        }
        const base = baselineFor(job, age);
        if (base.length < MIN_BASELINE) provisional = true;
        const p = percentile(v, base);
        if (Number.isNaN(p)) continue;
        const list = byPlatform.get(job.platform);
        if (list) list.push(p);
        else byPlatform.set(job.platform, [p]);
      }
      // several jobs of one post on one platform average into that platform's value
      const percentiles: number[] = [];
      for (const [platform, list] of byPlatform) {
        const avg = list.reduce((a, b) => a + b, 0) / list.length;
        (score.perPlatform[platform] ??= {})[age] = avg;
        percentiles.push(avg);
      }
      if (percentiles.length > 0) {
        score.overall[age] = median(percentiles);
        score.provisional[age] = provisional;
      }
    }
    return score;
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function keysFor(l: VideoLabels, dim: LabelDimension): string[] {
  const idOrText = (id: number | null, text: string | null): string[] =>
    id !== null ? [String(id)] : text ? [text] : [];
  switch (dim) {
    case "hook": return idOrText(l.hookId, l.hookText);
    case "angle": return idOrText(l.angleId, l.angleText);
    case "cta": return idOrText(l.ctaId, l.ctaText);
    case "style": return l.styleId ? [l.styleId] : [];
    case "type": return [...new Set(l.types)].map(String);
    case "source": return [l.source];
  }
}

export function compareLabels(
  scores: VideoScore[],
  labels: VideoLabels[],
  dim: LabelDimension,
  age: ScoreAge,
  seed = 1,
): { key: string; median: number; lo: number; hi: number; n: number; enough: boolean }[] {
  const overall = new Map(scores.map((s) => [s.postId, s.overall[age]]));
  const groups = new Map<string, number[]>();
  for (const l of labels) {
    const v = overall.get(l.postId);
    if (v === undefined) continue;
    for (const key of keysFor(l, dim)) {
      const g = groups.get(key);
      if (g) g.push(v);
      else groups.set(key, [v]);
    }
  }
  const out = [...groups.entries()].map(([key, vals]) => {
    const rand = mulberry32(seed);
    const meds: number[] = [];
    for (let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
      const sample = vals.map(() => vals[Math.floor(rand() * vals.length)]!);
      meds.push(median(sample));
    }
    meds.sort((a, b) => a - b);
    return {
      key,
      median: median(vals),
      lo: quantile(meds, 0.05),
      hi: quantile(meds, 0.95),
      n: vals.length,
      enough: vals.length >= 3,
    };
  });
  return out.sort((a, b) => b.median - a.median || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
