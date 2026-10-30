// Creating and showing posts: shared by the web page's upload route and the MCP endpoint.
import { createHash } from "node:crypto";
import { createWriteStream, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dataDir } from "./config.ts";
import { randomToken } from "./crypto.ts";
import type { Store } from "./db.ts";
import { probe } from "./media.ts";
import type { Publisher } from "./platforms/base.ts";
import type { Account, Job, Platform, Post, TikTokOptions } from "./types.ts";

const MAX_SCHEDULE_AHEAD_MS = 365 * 86_400_000;

/** Parses a schedule time (epoch ms); blank = post now. */
export function parseSchedule(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const at = Number(raw);
  if (!Number.isInteger(at)) throw new Error("the scheduled time is not a valid date");
  if (at < Date.now() - 60_000) throw new Error("the scheduled time has already passed; pick a time in the future");
  if (at > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw new Error("posts can be scheduled up to a year ahead");
  return at;
}

/** Copies a video into data/uploads, hashing it on the way. The caller deletes it if the post is refused. */
export async function saveUpload(source: Readable, filename: string): Promise<{ path: string; sha256: string }> {
  const path = join(dataDir, "uploads", `${randomToken(12)}${extname(filename).toLowerCase() || ".mp4"}`);
  const hash = createHash("sha256");
  const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
  try {
    await pipeline(source, tap, createWriteStream(path));
  } catch (err) {
    try { unlinkSync(path); } catch {}
    throw err;
  }
  return { path, sha256: hash.digest("hex") };
}

export interface Draft {
  sourcePath: string;
  sha256: string;
  caption: string;
  title: string;
  accountIds: number[];
  tiktok: TikTokOptions | null;
  scheduledAt: number | null;
}

/** Thrown when the same file already went, or is due to go, to some of the chosen accounts. */
export class DuplicateError extends Error {}

/**
 * Rejects everything knowable before upload (unknown accounts, caption limits, durations, TikTok rules,
 * and unless allowed, a repeat of the same file), so nothing is half-posted because of a caption problem.
 */
export async function checkDraft(store: Store, publishers: Record<Platform, Publisher>, d: Draft, allowDuplicate = false) {
  if (!d.accountIds.length) throw new Error("pick at least one account");
  const accounts = d.accountIds.map((id) => store.account(id));
  if (accounts.some((a) => !a)) throw new Error("unknown account selected");
  const src = await probe(d.sourcePath); // rejects non-video files before anything is queued

  const problems: string[] = [];
  for (const a of accounts as Account[]) {
    const p = publishers[a.platform];
    const reason = p.validate({ ...d, id: 0, createdAt: 0 }, a);
    if (reason) problems.push(`${p.label} (${a.name}): ${reason}`);
    const max = p.maxDurationSec(a);
    if (src.durationSec > max + 0.05) problems.push(`${p.label} (${a.name}): accepts up to ${max}s; the video is ${src.durationSec.toFixed(1)}s`);
    if (src.durationSec < p.minDurationSec) problems.push(`${p.label} (${a.name}): needs at least ${p.minDurationSec}s`);
  }
  if (problems.length) throw new Error(problems.join("\n"));

  if (!allowDuplicate) {
    const dupes = (accounts as Account[]).filter((a) => store.alreadyPublished(d.sha256, a.id));
    if (dupes.length) {
      throw new DuplicateError(`This exact video was already published, or is waiting to be posted, to: ${dupes.map((a) => `${publishers[a.platform].label} ${a.name}`).join(", ")}`);
    }
  }
  return { accounts: accounts as Account[], durationSec: src.durationSec };
}

/** What the page and agents see of a post: never tokens or file paths. */
export function postView(store: Store, { post, jobs }: { post: Post; jobs: Job[] }) {
  return {
    id: post.id,
    caption: post.caption,
    title: post.title,
    createdAt: post.createdAt,
    scheduledAt: post.scheduledAt,
    jobs: jobs.map((j) => ({
      id: j.id,
      platform: j.platform,
      account: store.account(j.accountId)?.name ?? "(disconnected)",
      state: j.state,
      attempts: j.attempts,
      nextRunAt: j.nextRunAt,
      url: j.resultUrl,
      error: j.error,
    })),
  };
}
