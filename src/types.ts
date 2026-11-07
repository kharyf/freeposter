import type { EditSettings } from "./edit/settings.ts";

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
  /** the edit to publish instead of the original, once it is ready and approved */
  editId?: number | null;
  /** Drive posts that were edited: never fall back to the original */
  requireEdit?: boolean;
  /**
   * Set while the AI writes the caption of a post made with a blank one: what the video is called (its title or
   * file name). Its jobs wait until the caption is in. Null/absent once it has a caption.
   */
  captionTopic?: string | null;
}

export type DriveFileState =
  | "pending" // seen, still uploading (size not yet stable)
  | "queued" // handed to the intake
  | "ignored" | "invalid" | "late"
  | "downloading" | "transcribing" | "processing"
  | "scheduled" | "edit_failed" | "failed"
  | "needs_caption" // only in older databases; resume() captions these
  | "cancelled" // its post was cancelled in FreePoster
  | "removed"; // deleted from the Drive folder; found by Sync and taken off the list

/** One video seen in the watched Drive folder, and how far FreePoster got with it. */
export interface DriveFileRecord {
  driveId: string;
  name: string;
  state: DriveFileState;
  size: number;
  md5: string | null;
  scheduledAt: number | null;
  sourcePath: string | null;
  sha256: string | null;
  editId: number | null;
  postId: number | null;
  title: string | null;
  caption: string | null;
  note: string | null;
  /** when it was uploaded to Drive; the date a name without one posts on */
  uploadedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DriveConnection {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  email: string;
  folderId: string | null;
  baselineDone: boolean;
  /** Where Drive's change feed left off (null until the first look, and after the folder changes) */
  changesToken: string | null;
  error: string | null;
}

export type EditState = "queued" | "transcribing" | "editing" | "ready" | "failed";

export interface Edit {
  id: number;
  sourcePath: string;
  sha256: string;
  settings: EditSettings;
  /** editKey(sha256, settings): names the cached output and its render */
  key: string;
  state: EditState;
  progress: number;
  outputPath: string | null;
  durationSec: number | null;
  transcriptPath: string | null;
  error: string | null;
  approvedAt: number | null;
  createdAt: number;
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
