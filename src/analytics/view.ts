// What the analytics views (the MCP get_analytics tool and the Analytics tab's routes) share: which videos a filter
// keeps, their scores, and the names of the library entries and types their labels point at.
import type { Store } from "../db.ts";
import { CampaignStore } from "../campaigns/store.ts";
import { scoreVideos, type LabelDimension, type ScoredJob, type VideoScore } from "./score.ts";
import { AnalyticsStore } from "./store.ts";
import type { Source, VideoLabels } from "./types.ts";

export interface VideoFilter {
  accountId?: number;
  days?: number;
  source?: Source;
  campaignId?: number;
}

export function selectVideos(store: Store, f: VideoFilter, now: number): {
  a: AnalyticsStore;
  labels: VideoLabels[];
  /** scores of the kept videos */
  shown: VideoScore[];
  jobsOf: Map<number, ScoredJob[]>;
} {
  const a = new AnalyticsStore(store);
  const allLabels = a.allLabels();
  const jobs = a.scoredJobs();
  const scores = scoreVideos({ labels: allLabels, snapshotsByJob: new Map(jobs.map((j) => [j.id, a.snapshots(j.id)])), jobs, now });
  const jobsOf = new Map<number, ScoredJob[]>();
  for (const j of jobs) jobsOf.set(j.postId, [...(jobsOf.get(j.postId) ?? []), j]);
  const since = f.days === undefined ? null : now - f.days * 86_400_000;
  const labels = allLabels.filter((l) => {
    const mine = jobsOf.get(l.postId) ?? [];
    if (!mine.length) return false;
    if (f.source !== undefined && l.source !== f.source) return false;
    if (f.campaignId !== undefined && l.campaignId !== f.campaignId) return false;
    if (f.accountId !== undefined && !mine.some((j) => j.accountId === f.accountId)) return false;
    if (since !== null && Math.min(...mine.map((j) => j.publishedAt ?? 0)) < since) return false;
    return true;
  });
  const kept = new Set(labels.map((l) => l.postId));
  return { a, labels, shown: scores.filter((s) => kept.has(s.postId)), jobsOf };
}

/** Names for the ids labels carry. */
export function labelNames(store: Store) {
  const cs = new CampaignStore(store);
  const entries = new Map(cs.entries().map((e) => [e.id, e]));
  const entryName = new Map(cs.entries().map((e) => [String(e.id), e.name]));
  const typeName = new Map(cs.types().map((ty) => [String(ty.id), ty.name]));
  return {
    entries, entryName, typeName,
    nameOf: (dim: LabelDimension, key: string) =>
      dim === "type" ? typeName.get(key) ?? key : dim === "hook" || dim === "angle" || dim === "cta" ? entryName.get(key) ?? key : key,
  };
}
