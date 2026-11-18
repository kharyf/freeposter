import { open } from "node:fs/promises";
import type { MetricReading } from "../analytics/types.ts";
import type { Account, Job, NewAccount, Platform, Post, TokenSet } from "../types.ts";

/** Thrown when the platform is still processing; the runner re-checks later without spending an attempt. */
export class StillProcessing extends Error {
  delayMs: number;
  constructor(message: string, delayMs = 30_000) {
    super(message);
    this.delayMs = delayMs;
  }
}

/** Thrown by metrics() when the account must sign in again to grant the analytics permission. */
export class NeedsPermission extends Error {}

/** Thrown by metrics() when the video no longer exists or is private. */
export class Gone extends Error {}

/** Thrown by metrics() when the platform's plan or usage cap withholds the numbers (X). */
export class PlanLimited extends Error {}

export interface MetricsContext {
  account: Account;
  job: Job;
  /** the job's checkpoint (videoId, mediaId, tweetId, ...) */
  progress: Record<string, any>;
  /** ms since epoch */
  publishedAt: number;
}

export interface PublishContext {
  account: Account;
  post: Post;
  /** the normalized 1080x1920 H.264/AAC render */
  videoPath: string;
  videoSize: number;
  durationSec: number;
  /** checkpoint from earlier attempts; publishers must never repeat a step recorded here */
  progress: Record<string, any>;
  save(progress: Record<string, any>): void;
  log(message: string): void;
}

export interface Publisher {
  platform: Platform;
  label: string;
  minDurationSec: number;
  maxDurationSec(account: Account): number;
  /** pre-upload checks on caption/title; return a reason to reject, or null */
  validate(post: Post, account: Account): string | null;
  authorizeUrl(state: string, verifier: string): string;
  exchangeCode(code: string, verifier: string): Promise<NewAccount[]>;
  /** null when this account's token can't or needn't be refreshed */
  refresh(account: Account): Promise<TokenSet | null>;
  publish(ctx: PublishContext): Promise<{ url: string; note?: string }>;
  /** read the published video's numbers; throws NeedsPermission or Gone */
  metrics?(ctx: MetricsContext): Promise<MetricReading>;
  /** the scopes metrics() needs; an account missing any of them "needs permission" */
  analyticsScopes: string[];
}

export async function readChunk(path: string, start: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const fh = await open(path, "r");
  try {
    const buf = new Uint8Array(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The post's cover time in ms, kept inside the video (it must not be past the last frame); null when the post has no cover. */
export function coverMs(post: Post, durationSec: number): number | null {
  if (!post.cover) return null;
  return Math.max(0, Math.min(Math.round(post.cover.atMs), Math.floor(durationSec * 1000) - 1));
}

export const expiresIn = (seconds: number | undefined) =>
  seconds ? Date.now() + Number(seconds) * 1000 : null;

export const firstLine = (text: string, max: number) =>
  (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, max);

/** Count characters the way most platforms do (UTF-16 code units are what TikTok/IG document). */
export const utf16Length = (s: string) => s.length;

/** Poll `check` until it returns a value or `budgetMs` elapses, then hand back to the runner. */
export async function pollUntil<T>(
  what: string,
  check: () => Promise<T | undefined>,
  { intervalMs = 5_000, budgetMs = 120_000 } = {},
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() + intervalMs > deadline) throw new StillProcessing(`${what} still processing`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
