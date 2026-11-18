// Shapes shared by the analytics store, the pollers and the scoring code.
import type { Platform } from "../types.ts";

/** Poll ages, in seconds after publish. After the last one a video is no longer polled. */
export const AGES = { "1h": 3_600, "6h": 21_600, "24h": 86_400, "72h": 259_200, "7d": 604_800, "30d": 2_592_000 } as const;
export type Age = keyof typeof AGES;

export interface MetricReading {
  /** the score's metric; null when the platform gave none */
  views: number | null;
  /** impressions when the platform has no video views (X), so the tab can say so */
  viewsKind: "views" | "impressions";
  /** every other number the platform returned, by its own name */
  raw: Record<string, number>;
  /** audience retention curve, when the platform gives one */
  retention: number[] | null;
}

export interface Snapshot {
  id: number;
  jobId: number;
  platform: Platform;
  externalId: string;
  takenAt: number;
  ageSec: number;
  reading: MetricReading;
}

export type Source = "recorded" | "generated";

export interface VideoLabels {
  postId: number;
  source: Source;
  styleId: string | null;
  hookId: number | null;
  hookText: string | null;
  angleId: number | null;
  angleText: string | null;
  ctaId: number | null;
  ctaText: string | null;
  campaignId: number | null;
  campaignTaskId: number | null;
  types: number[];
  labelledBy: "campaign" | "transcript" | "ai" | "user";
}
