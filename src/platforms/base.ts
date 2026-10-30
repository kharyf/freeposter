import { open } from "node:fs/promises";
import type { Account, NewAccount, Platform, Post, TokenSet } from "../types.ts";

/** Thrown when the platform is still processing; the runner re-checks later without spending an attempt. */
export class StillProcessing extends Error {
  delayMs: number;
  constructor(message: string, delayMs = 30_000) {
    super(message);
    this.delayMs = delayMs;
  }
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
