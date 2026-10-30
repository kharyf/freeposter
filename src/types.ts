export const PLATFORMS = ["tiktok", "instagram", "facebook", "x", "youtube"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface Account {
  id: number;
  platform: Platform;
  externalId: string;
  name: string;
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms; null = does not expire (e.g. Facebook Page tokens) */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  meta: Record<string, unknown>;
}

/** What a platform hands back after OAuth; one login can yield several accounts (Facebook Pages). */
export type NewAccount = Omit<Account, "id">;

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

export interface TikTokOptions {
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
}

export interface Post {
  id: number;
  caption: string;
  title: string;
  sourcePath: string;
  sha256: string;
  tiktok: TikTokOptions | null;
  createdAt: number;
  /** epoch ms the post is scheduled to go out; null/absent = as soon as possible */
  scheduledAt?: number | null;
}

export type JobState = "queued" | "running" | "retry" | "waiting_quota" | "published" | "failed";

export interface Job {
  id: number;
  postId: number;
  accountId: number;
  platform: Platform;
  state: JobState;
  attempts: number;
  nextRunAt: number;
  /** platform-specific checkpoint so a restarted job resumes instead of re-posting */
  progress: Record<string, unknown>;
  resultUrl: string | null;
  error: string | null;
  updatedAt: number;
}
