import { existsSync } from "node:fs";
import { join } from "node:path";
import { config, dataDir } from "./config.ts";
import type { Store } from "./db.ts";
import { AuthError, FatalError, RetryableError } from "./http.ts";
import { render } from "./media.ts";
import { StillProcessing, type Publisher } from "./platforms/base.ts";
import type { Account, Job, Platform, Post } from "./types.ts";

export const MAX_ATTEMPTS = 6;

/** 30s, 1m, 2m, 4m ... capped at 30m, with ±20% jitter so retries don't stampede. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 30 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

const log = (job: Job, msg: string) => console.log(`[job ${job.id} ${job.platform}] ${msg}`);

export class Runner {
  store: Store;
  publishers: Record<Platform, Publisher>;
  busy = new Set<Platform>();
  timer: NodeJS.Timeout | undefined;
  refreshing = new Map<number, Promise<Account>>();
  rendersDir: string;

  constructor(store: Store, publishers: Record<Platform, Publisher>, rendersDir = join(dataDir, "renders")) {
    this.store = store;
    this.publishers = publishers;
    this.rendersDir = rendersDir;
  }

  start(intervalMs = 2_000) {
    const tick = () => {
      this.tick();
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
    // Keep long-lived tokens alive even when nothing is being posted.
    const sweep = () => void this.refreshExpiring().catch((e) => console.error("token sweep:", e.message));
    sweep();
    setInterval(sweep, 6 * 3_600_000).unref();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** Starts every due job, one at a time per platform; different platforms run in parallel. */
  tick(): Promise<void>[] {
    const started: Promise<void>[] = [];
    for (;;) {
      const job = this.store.claimNextJob(this.busy);
      if (!job) return started;
      this.busy.add(job.platform);
      started.push(this.run(job).finally(() => this.busy.delete(job.platform)));
    }
  }

  async run(job: Job): Promise<void> {
    const publisher = this.publishers[job.platform];
    const post = this.store.post(job.postId)!;
    let account = this.store.account(job.accountId);
    if (!account) return this.store.finishJob(job.id, "failed", { error: "account was disconnected" });

    try {
      // Quota is only checked before anything was sent, never in the middle of a post.
      if (Object.keys(job.progress).length === 0) {
        const cap = config.dailyCap[job.platform];
        if (this.store.publishedInLast24h(account.id) >= cap) {
          const at = this.store.quotaFreesAt(account.id, cap);
          this.store.refundAttempt(job.id);
          log(job, `daily cap of ${cap} reached; waiting until ${new Date(at).toLocaleString()}`);
          return this.store.finishJob(job.id, "waiting_quota", {
            nextRunAt: at,
            error: `daily cap of ${cap} posts reached; will post at ${new Date(at).toLocaleString()}`,
          });
        }
        const reason = publisher.validate(post, account);
        if (reason) throw new FatalError(reason);
      }

      const video = await this.renderFor(post);
      const { durationSec } = video.probe;
      const max = publisher.maxDurationSec(account);
      if (durationSec > max + 0.05) {
        throw new FatalError(`${publisher.label} accepts up to ${max}s; this video is ${durationSec.toFixed(1)}s`);
      }
      if (durationSec < publisher.minDurationSec) {
        throw new FatalError(`${publisher.label} needs at least ${publisher.minDurationSec}s; this video is ${durationSec.toFixed(1)}s`);
      }

      account = await this.freshAccount(account);
      const progress = { ...job.progress };
      const ctx = {
        account,
        post,
        videoPath: video.path,
        videoSize: video.size,
        durationSec,
        progress,
        save: (p: Record<string, unknown>) => {
          if (p !== progress) {
            for (const k of Object.keys(progress)) delete progress[k];
            Object.assign(progress, p);
          }
          this.store.saveProgress(job.id, progress);
        },
        log: (m: string) => log(job, m),
      };

      let result;
      try {
        result = await publisher.publish(ctx);
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        // One forced refresh, then give up: the user must reconnect.
        log(job, "token rejected; refreshing once");
        ctx.account = await this.freshAccount(account, true);
        result = await publisher.publish(ctx);
      }

      log(job, `published ${result.url}`);
      this.store.finishJob(job.id, "published", { resultUrl: result.url, error: result.note });
    } catch (err) {
      this.handleFailure(job, err as Error);
    }
  }

  /** The approved edit when the post has one; Drive posts that were edited don't fall back to the original. */
  renderFor(post: Post) {
    const edit = post.editId ? this.store.edit(post.editId) : undefined;
    if (edit?.state === "ready" && edit.approvedAt && edit.outputPath && existsSync(edit.outputPath)) {
      return render(edit.outputPath, edit.key, this.rendersDir);
    }
    if (post.requireEdit) throw new FatalError("the edited video isn't available, and this Drive video posts only its edit (end its name with _RAW to post a video as uploaded)");
    return render(post.sourcePath, post.sha256, this.rendersDir);
  }

  handleFailure(job: Job, err: Error) {
    if (err instanceof StillProcessing) {
      this.store.refundAttempt(job.id);
      return this.store.finishJob(job.id, "retry", { nextRunAt: Date.now() + err.delayMs, error: err.message });
    }
    if (err instanceof AuthError) {
      log(job, `auth failed: ${err.message}`);
      return this.store.finishJob(job.id, "failed", { error: `Login expired or revoked; reconnect this account. (${err.message})` });
    }
    const retryable = err instanceof RetryableError || !(err instanceof FatalError);
    const attempts = this.store.job(job.id)!.attempts;
    if (retryable && attempts < MAX_ATTEMPTS) {
      const wait = err instanceof RetryableError && err.retryAfterMs ? err.retryAfterMs : backoffMs(attempts);
      log(job, `attempt ${attempts} failed, retrying in ${Math.round(wait / 1000)}s: ${err.message}`);
      return this.store.finishJob(job.id, "retry", { nextRunAt: Date.now() + wait, error: err.message });
    }
    log(job, `failed: ${err.message}`);
    this.store.finishJob(job.id, "failed", { error: err.message });
  }

  /** Refreshes when the access token is within 5 minutes of expiry (or when forced). Deduplicated per account. */
  async freshAccount(account: Account, force = false): Promise<Account> {
    const due = account.expiresAt !== null && account.expiresAt - Date.now() < 5 * 60_000;
    if (!force && !due) return account;
    let pending = this.refreshing.get(account.id);
    if (!pending) {
      pending = (async () => {
        const tokens = await this.publishers[account.platform].refresh(account);
        if (!tokens) {
          if (force || (account.expiresAt !== null && account.expiresAt < Date.now())) {
            throw new AuthError(`${account.platform} token cannot be refreshed`);
          }
          return account;
        }
        this.store.saveTokens(account.id, tokens);
        return this.store.account(account.id)!;
      })().finally(() => this.refreshing.delete(account.id));
      this.refreshing.set(account.id, pending);
    }
    return pending;
  }

  /** Refreshes every token expiring within 7 days so accounts never silently lapse. */
  async refreshExpiring() {
    for (const account of this.store.accounts()) {
      if (account.expiresAt === null || account.expiresAt - Date.now() > 7 * 86_400_000) continue;
      try {
        await this.freshAccount(account, true);
      } catch (err) {
        console.error(`could not refresh ${account.platform} ${account.name}: ${(err as Error).message}`);
      }
    }
  }
}
