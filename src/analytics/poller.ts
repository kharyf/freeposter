// Takes metric snapshots of published videos at 1h, 6h, 24h, 72h, 7d and 30d after publish.
import type { Account, Job } from "../types.ts";
import { AuthError } from "../http.ts";
import type { Store } from "../db.ts";
import { Gone, NeedsPermission, PlanLimited, StillProcessing, type MetricsContext, type Publisher } from "../platforms/base.ts";
import { backoffMs } from "../runner.ts";
import type { Platform } from "../types.ts";
import { AnalyticsStore } from "./store.ts";
import { AGES } from "./types.ts";

const STANDARD: number[] = Object.values(AGES);
const JITTER = 0.1;
const RECHECK_MS = 6 * 3_600_000;
/** A job that keeps failing is dropped this long after its last standard age. */
const GIVE_UP_MS = (AGES["30d"] + 2 * 86_400) * 1000;

/** The gap before a standard age (the jitter is a tenth of it). */
const gapBefore = (age: number) => age - (STANDARD[STANDARD.indexOf(age) - 1] ?? 0);

/** The standard age a snapshot taken at ageSec stands for (a poll spread early still counts for its own age). */
export function slotOf(ageSec: number): number | null {
  let slot: number | null = null;
  for (const a of STANDARD) if (ageSec + JITTER * gapBefore(a) >= a) slot = a;
  return slot;
}

/** When to take the next snapshot: the first standard age after lastAgeSec, ±10% of its gap; null after the 30-day one. */
export function nextPollAt(publishedAt: number, lastAgeSec: number | null, random: () => number = Math.random): number | null {
  const age = STANDARD.find((a) => lastAgeSec === null || a > lastAgeSec);
  if (age === undefined) return null;
  return Math.round(publishedAt + age * 1000 + (random() * 2 - 1) * JITTER * gapBefore(age) * 1000);
}

/** The platform's id for the video, from where each publisher keeps it. */
export function externalIdOf(job: Job): string {
  const p = job.progress;
  const id = job.platform === "instagram" ? p.mediaId : job.platform === "x" ? p.tweetId : job.platform === "tiktok" ? job.resultUrl?.match(/\/video\/(\d+)/)?.[1] : p.videoId;
  return String(id ?? job.id);
}

export class MetricsPoller {
  store: Store;
  analytics: AnalyticsStore;
  publishers: Record<Platform, Publisher>;
  now: () => number;
  random: () => number;
  timer: NodeJS.Timeout | undefined;
  running = false;
  stopped = false;
  /** token refresh, shared with the posting runner so the two never refresh the same account at once */
  freshAccount: (account: Account, force?: boolean) => Promise<Account>;
  /** told which jobs got a new snapshot, after a tick */
  onRefresh: (jobIds: number[]) => void = () => {};

  constructor(store: Store, publishers: Record<Platform, Publisher>, opts: { now?: () => number; random?: () => number; freshAccount?: (account: Account, force?: boolean) => Promise<Account> } = {}) {
    this.freshAccount = opts.freshAccount ?? (async (a) => a);
    this.store = store;
    this.analytics = new AnalyticsStore(store);
    this.publishers = publishers;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  private publishedAt(jobId: number): number | null {
    const r = this.store.db.prepare("SELECT published_at FROM jobs WHERE id = ? AND state = 'published'").get(jobId) as { published_at: number | null } | undefined;
    return r?.published_at ?? null;
  }

  /** Starts polling a published job (once; a job already polled keeps its schedule). */
  schedule(jobId: number) {
    if (this.analytics.pollFor(jobId)) return;
    const publishedAt = this.publishedAt(jobId);
    if (publishedAt === null) return;
    this.analytics.schedulePoll(jobId, nextPollAt(publishedAt, null, this.random)!);
  }

  /** Every published job without a poll row gets one. */
  backfill() {
    const rows = this.store.db
      .prepare("SELECT id FROM jobs WHERE state = 'published' AND published_at IS NOT NULL AND id NOT IN (SELECT job_id FROM metric_poll)")
      .all() as { id: number }[];
    for (const r of rows) this.schedule(r.id);
  }

  start(intervalMs = 60_000) {
    this.stopped = false;
    this.backfill();
    const run = () => {
      void this.tick()
        .catch((err) => console.error(`metrics poll: ${(err as Error).message}`))
        .finally(() => {
          if (this.stopped) return;
          this.timer = setTimeout(run, intervalMs);
          this.timer.unref();
        });
    };
    run();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Polls every due job: one request at a time per account, different accounts side by side. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const byAccount = new Map<number, number[]>();
      for (const due of this.analytics.duePolls(this.now(), 100)) {
        const job = this.store.job(due.jobId);
        if (!job) this.analytics.finishPoll(due.jobId, "post removed");
        else byAccount.set(job.accountId, [...(byAccount.get(job.accountId) ?? []), due.jobId]);
      }
      const refreshed: number[] = [];
      await Promise.all(
        [...byAccount.entries()].map(async ([accountId, jobIds]) => {
          for (const jobId of jobIds) {
            try {
              if (await this.poll(jobId, accountId)) refreshed.push(jobId);
            } catch (err) {
              console.error(`metrics poll job ${jobId}: ${(err as Error).message}`);
            }
          }
        }),
      );
      if (refreshed.length) this.onRefresh(refreshed);
    } finally {
      this.running = false;
    }
  }

  /** One job's poll; true when it produced a snapshot. */
  private async poll(jobId: number, accountId: number): Promise<boolean> {
    const a = this.analytics;
    const now = this.now();
    const job = this.store.job(jobId)!;
    const publishedAt = this.publishedAt(jobId);
    const account = this.store.account(accountId);
    const publisher = this.publishers[job.platform];
    if (publishedAt === null || !account) {
      a.finishPoll(jobId, "account or post removed");
      return false;
    }
    if (!publisher.metrics) {
      a.finishPoll(jobId, "no metrics for this platform");
      return false;
    }
    const before = a.pollFor(jobId)!;
    // Past the last age nothing is worth recording, whatever state the poll was in.
    if (now > publishedAt + GIVE_UP_MS) {
      a.finishPoll(jobId, before.lastError);
      return false;
    }

    try {
      const ctx = (acct: Account): MetricsContext => ({ account: acct, job, progress: job.progress, publishedAt });
      let reading;
      try {
        reading = await publisher.metrics(ctx(await this.freshAccount(this.store.account(accountId)!)));
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        // The runner's way: one forced refresh, then try again.
        reading = await publisher.metrics(ctx(await this.freshAccount(this.store.account(accountId)!, true)));
      }
      const takenAt = this.now();
      const ageSec = Math.round((takenAt - publishedAt) / 1000);
      const externalId = externalIdOf(job);
      a.addSnapshot({ jobId, platform: job.platform, externalId, takenAt, ageSec, reading });
      // Ages that passed while we couldn't read (permission, outage) are skipped, not back-filled.
      const next = nextPollAt(publishedAt, slotOf(ageSec), this.random);
      if (next === null) a.finishPoll(jobId, null);
      else a.pollOk(jobId, next);
      return true;
    } catch (err) {
      if (err instanceof StillProcessing) {
        a.deferPoll(jobId, null, now + err.delayMs);
      } else if (err instanceof Gone) {
        // Some platforms say "not found" for permission or transient problems, so only a second Gone in a row counts.
        if (before.lastError === "gone?") a.finishPoll(jobId, "gone");
        else a.deferPoll(jobId, "gone?", now + RECHECK_MS);
      } else if (err instanceof NeedsPermission) {
        a.deferPoll(jobId, "needs permission", now + RECHECK_MS);
      } else if (err instanceof PlanLimited) {
        const next = nextPollAt(publishedAt, slotOf(Math.round((now - publishedAt) / 1000)), this.random);
        if (next === null) a.finishPoll(jobId, "limited by plan");
        else a.deferPoll(jobId, "limited by plan", next);
      } else {
        a.notePollError(jobId, (err as Error).message, now + backoffMs(before.attempts + 1, this.random));
      }
      return false;
    }
  }
}
