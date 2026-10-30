import { DatabaseSync } from "node:sqlite";
import { decrypt, encrypt } from "./crypto.ts";
import type { Account, Job, JobState, NewAccount, Platform, Post, TikTokOptions, TokenSet } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  refresh_expires_at INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  UNIQUE (platform, external_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  caption TEXT NOT NULL,
  title TEXT NOT NULL,
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  tiktok TEXT,
  created_at INTEGER NOT NULL,
  scheduled_at INTEGER
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  platform TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  progress TEXT NOT NULL DEFAULT '{}',
  result_url TEXT,
  error TEXT,
  published_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (post_id, account_id)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class Store {
  db: DatabaseSync;
  key: Buffer;

  constructor(path: string, key: Buffer) {
    this.db = new DatabaseSync(path);
    this.key = key;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // Databases created before scheduling existed.
    const postColumns = this.db.prepare("PRAGMA table_info(posts)").all() as { name: string }[];
    if (!postColumns.some((c) => c.name === "scheduled_at")) this.db.exec("ALTER TABLE posts ADD COLUMN scheduled_at INTEGER");
    // A crash mid-run leaves jobs "running"; their progress checkpoint lets them resume safely.
    this.db.prepare("UPDATE jobs SET state = 'retry' WHERE state = 'running'").run();
  }

  // ---- accounts ----

  upsertAccount(a: NewAccount): Account {
    this.db
      .prepare(
        `INSERT INTO accounts (platform, external_id, name, access_token, refresh_token, expires_at, refresh_expires_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, external_id) DO UPDATE SET
           name = excluded.name, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, refresh_expires_at = excluded.refresh_expires_at, meta = excluded.meta`,
      )
      .run(
        a.platform,
        a.externalId,
        a.name,
        encrypt(this.key, a.accessToken),
        a.refreshToken ? encrypt(this.key, a.refreshToken) : null,
        a.expiresAt,
        a.refreshExpiresAt,
        JSON.stringify(a.meta),
      );
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE platform = ? AND external_id = ?")
      .get(a.platform, a.externalId);
    return this.toAccount(row);
  }

  saveTokens(accountId: number, t: TokenSet) {
    this.db
      .prepare(
        "UPDATE accounts SET access_token = ?, refresh_token = ?, expires_at = ?, refresh_expires_at = ? WHERE id = ?",
      )
      .run(
        encrypt(this.key, t.accessToken),
        t.refreshToken ? encrypt(this.key, t.refreshToken) : null,
        t.expiresAt,
        t.refreshExpiresAt,
        accountId,
      );
  }

  account(id: number): Account | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
    return row ? this.toAccount(row) : undefined;
  }

  accounts(): Account[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY platform, name").all().map((r) => this.toAccount(r));
  }

  deleteAccount(id: number) {
    // History of published posts is removed with the account; the posts themselves stay live on the platform.
    this.db.prepare("DELETE FROM jobs WHERE account_id = ?").run(id);
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }

  private toAccount(r: any): Account {
    return {
      id: r.id,
      platform: r.platform,
      externalId: r.external_id,
      name: r.name,
      accessToken: decrypt(this.key, r.access_token),
      refreshToken: r.refresh_token ? decrypt(this.key, r.refresh_token) : null,
      expiresAt: r.expires_at,
      refreshExpiresAt: r.refresh_expires_at,
      meta: JSON.parse(r.meta),
    };
  }

  // ---- oauth state (CSRF + PKCE verifier) ----

  putOAuthState(state: string, platform: Platform, verifier: string) {
    this.db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(Date.now() - 15 * 60_000);
    this.db.prepare("INSERT INTO oauth_states VALUES (?, ?, ?, ?)").run(state, platform, verifier, Date.now());
  }

  /** Which platform a pending sign-in belongs to; the redirect page's callback doesn't say. */
  oauthStatePlatform(state: string): Platform | undefined {
    const row = this.db.prepare("SELECT platform FROM oauth_states WHERE state = ?").get(state) as { platform: Platform } | undefined;
    return row?.platform;
  }

  takeOAuthState(state: string, platform: Platform): string | undefined {
    const row = this.db
      .prepare("SELECT verifier FROM oauth_states WHERE state = ? AND platform = ? AND created_at > ?")
      .get(state, platform, Date.now() - 15 * 60_000) as { verifier: string } | undefined;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    return row?.verifier;
  }

  // ---- posts & jobs ----

  createPost(p: Omit<Post, "id" | "createdAt">, accountIds: number[]): number {
    this.db.exec("BEGIN");
    try {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO posts (caption, title, source_path, sha256, tiktok, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(p.caption, p.title, p.sourcePath, p.sha256, p.tiktok ? JSON.stringify(p.tiktok) : null, Date.now(), p.scheduledAt ?? null);
      const postId = Number(lastInsertRowid);
      const insertJob = this.db.prepare(
        "INSERT INTO jobs (post_id, account_id, platform, state, next_run_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
      );
      for (const id of accountIds) {
        const account = this.account(id);
        if (!account) throw new Error(`unknown account ${id}`);
        // A scheduled job is simply a queued job that isn't due yet; the runner picks it up at that time.
        insertJob.run(postId, id, account.platform, p.scheduledAt ?? Date.now(), Date.now());
      }
      this.db.exec("COMMIT");
      return postId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The same video file already published or still due to go to this account (guards against accidental double posting). */
  alreadyPublished(sha256: string, accountId: number): Job | undefined {
    const row = this.db
      .prepare(
        `SELECT jobs.* FROM jobs JOIN posts ON posts.id = jobs.post_id
         WHERE posts.sha256 = ? AND jobs.account_id = ? AND jobs.state != 'failed' LIMIT 1`,
      )
      .get(sha256, accountId);
    return row ? toJob(row) : undefined;
  }

  post(id: number): Post | undefined {
    const r = this.db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      caption: r.caption,
      title: r.title,
      sourcePath: r.source_path,
      sha256: r.sha256,
      tiktok: r.tiktok ? (JSON.parse(r.tiktok) as TikTokOptions) : null,
      createdAt: r.created_at,
      scheduledAt: r.scheduled_at,
    };
  }

  /** The latest posts, plus every post still waiting to go out, however old. */
  recentPosts(limit = 30) {
    const posts = this.db
      .prepare(
        `SELECT id FROM posts
         WHERE id IN (SELECT id FROM posts ORDER BY id DESC LIMIT ?)
            OR id IN (SELECT post_id FROM jobs WHERE state IN ('queued', 'running', 'retry', 'waiting_quota'))
         ORDER BY id DESC`,
      )
      .all(limit) as { id: number }[];
    return posts.map(({ id }) => ({ post: this.post(id)!, jobs: this.jobsForPost(id) }));
  }

  jobsForPost(postId: number): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE post_id = ? ORDER BY platform").all(postId).map(toJob);
  }

  job(id: number): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? toJob(row) : undefined;
  }

  /** Atomically claims the next due job, skipping platforms already busy. */
  claimNextJob(busy: Set<Platform>): Job | undefined {
    const placeholders = [...busy].map(() => "?").join(",");
    const row = this.db
      .prepare(
        `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state IN ('queued', 'retry', 'waiting_quota') AND next_run_at <= ?
           ${busy.size ? `AND platform NOT IN (${placeholders})` : ""}
           ORDER BY next_run_at LIMIT 1)
         RETURNING *`,
      )
      .get(Date.now(), Date.now(), ...busy);
    return row ? toJob(row) : undefined;
  }

  saveProgress(jobId: number, progress: Record<string, unknown>) {
    this.db
      .prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(progress), Date.now(), jobId);
  }

  finishJob(jobId: number, state: JobState, fields: { resultUrl?: string; error?: string; nextRunAt?: number }) {
    this.db
      .prepare(
        `UPDATE jobs SET state = ?, result_url = COALESCE(?, result_url), error = ?, next_run_at = COALESCE(?, next_run_at),
         published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END, updated_at = ? WHERE id = ?`,
      )
      .run(
        state,
        fields.resultUrl ?? null,
        fields.error ?? null,
        fields.nextRunAt ?? null,
        state,
        Date.now(),
        Date.now(),
        jobId,
      );
  }

  /** Waiting-for-quota jobs don't consume attempts. */
  refundAttempt(jobId: number) {
    this.db.prepare("UPDATE jobs SET attempts = MAX(attempts - 1, 0) WHERE id = ?").run(jobId);
  }

  /** Jobs of this post that haven't started yet: queued, never attempted, nothing sent. */
  private unstartedJobs(postId: number) {
    return "FROM jobs WHERE post_id = ? AND state = 'queued' AND attempts = 0 AND progress = '{}'";
  }

  /** Moves a post's unstarted jobs to a new time (null = now). Returns how many moved. */
  reschedulePost(postId: number, at: number | null): number {
    const { changes } = this.db
      .prepare(`UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id IN (SELECT id ${this.unstartedJobs(postId)})`)
      .run(at ?? Date.now(), Date.now(), postId);
    if (changes) this.db.prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").run(at, postId);
    return Number(changes);
  }

  /**
   * Cancels a post's unstarted jobs; jobs already under way are left alone, since stopping
   * mid-upload could leave a half-made post. Deletes the post when no jobs remain.
   */
  cancelPost(postId: number): { cancelled: number; deleted: Post | undefined } {
    const post = this.post(postId);
    const { changes } = this.db.prepare(`DELETE ${this.unstartedJobs(postId)}`).run(postId);
    const left = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE post_id = ?").get(postId) as { n: number };
    if (left.n === 0) this.db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
    return { cancelled: Number(changes), deleted: left.n === 0 ? post : undefined };
  }

  /** Jobs that still have to go out; the desktop app keeps running in the background while any remain. */
  pendingJobCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running', 'retry', 'waiting_quota')").get() as { n: number }).n;
  }

  retryJob(jobId: number) {
    this.db
      .prepare("UPDATE jobs SET state = 'queued', attempts = 0, error = NULL, next_run_at = ?, updated_at = ? WHERE id = ? AND state = 'failed'")
      .run(Date.now(), Date.now(), jobId);
  }

  publishedInLast24h(accountId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE account_id = ? AND state = 'published' AND published_at > ?")
      .get(accountId, Date.now() - 86_400_000) as { n: number };
    return row.n;
  }

  /** Earliest moment a slot frees up under the rolling 24h cap. */
  quotaFreesAt(accountId: number, cap: number): number {
    const row = this.db
      .prepare(
        `SELECT published_at FROM jobs WHERE account_id = ? AND state = 'published' AND published_at > ?
         ORDER BY published_at DESC LIMIT 1 OFFSET ?`,
      )
      .get(accountId, Date.now() - 86_400_000, Math.max(cap - 1, 0)) as { published_at: number } | undefined;
    return (row?.published_at ?? Date.now()) + 86_400_000 + 60_000;
  }

  close() {
    this.db.close();
  }
}

function toJob(r: any): Job {
  return {
    id: r.id,
    postId: r.post_id,
    accountId: r.account_id,
    platform: r.platform,
    state: r.state,
    attempts: r.attempts,
    nextRunAt: r.next_run_at,
    progress: JSON.parse(r.progress),
    resultUrl: r.result_url,
    error: r.error,
    updatedAt: r.updated_at,
  };
}
