// Takes metric snapshots of published videos at 1h, 6h, 24h, 72h, 7d and 30d after publish.
import type { Store } from "../db.ts";
import { Gone, NeedsPermission, PlanLimited, StillProcessing, type Publisher } from "../platforms/base.ts";
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

export class MetricsPoller {
  store: Store;
  analytics: AnalyticsStore;
  publishers: Record<Platform, Publisher>;
  now: () => number;
  random: () => number;
  timer: NodeJS.Timeout | undefined;
  running = false;
  /** told which jobs got a new snapshot, after a tick */
  onRefresh: (jobIds: number[]) => void = () => {};

  constructor(store: Store, publishers: Record<Platform, Publisher>, opts: { now?: () => number; random?: () => number } = {}) {
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
    this.backfill();
    const run = () => {
      void this.tick()
        .catch((err) => console.error(`metrics poll: ${(err as Error).message}`))
        .finally(() => {
          this.timer = setTimeout(run, intervalMs);
          this.timer.unref();
        });
    };
    run();
  }

  stop() {
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
    let account = this.store.account(accountId);
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

    try {
      if (account.expiresAt !== null && account.expiresAt - now < 5 * 60_000) {
        const tokens = await publisher.refresh(account);
        if (tokens) {
          this.store.saveTokens(account.id, tokens);
          account = this.store.account(account.id)!;
        }
      }
      const reading = await publisher.metrics({ account, job, progress: job.progress, publishedAt });
      const takenAt = this.now();
      const ageSec = Math.round((takenAt - publishedAt) / 1000);
      const externalId = String(job.progress.videoId ?? job.progress.mediaId ?? job.progress.tweetId ?? job.progress.publishId ?? job.resultUrl ?? job.id);
      a.addSnapshot({ jobId, platform: job.platform, externalId, takenAt, ageSec, reading });
      // Ages that passed while we couldn't read (permission, outage) are skipped, not back-filled.
      const next = nextPollAt(publishedAt, slotOf(ageSec), this.random);
      if (next === null) a.finishPoll(jobId, null);
      else a.pollOk(jobId, next);
      return true;
    } catch (err) {
      if (err instanceof StillProcessing) {
        a.schedulePoll(jobId, now + err.delayMs);
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
      } else if (now > publishedAt + GIVE_UP_MS) {
        a.finishPoll(jobId, (err as Error).message);
      } else {
        a.notePollError(jobId, (err as Error).message, now + backoffMs(before.attempts + 1, this.random));
      }
      return false;
    }
  }
}
