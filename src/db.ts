import { DatabaseSync } from "node:sqlite";
import { decrypt, encrypt } from "./crypto.ts";
import { editKey, type EditSettings } from "./edit/settings.ts";
import type { Account, DriveChoice, DriveConnection, DriveFileRecord, Edit, Job, JobState, NewAccount, Platform, Post, TikTokOptions, TokenSet } from "./types.ts";

/** What a pending sign-in is for: a posting platform, or the watched Google Drive folder. */
export type SignIn = Platform | "drive" | "openrouter";

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
CREATE TABLE IF NOT EXISTS edits (
  id INTEGER PRIMARY KEY,
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  settings TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  output_path TEXT,
  duration_sec REAL,
  transcript_path TEXT,
  error TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER,
  email TEXT NOT NULL DEFAULT '',
  folder_id TEXT,
  baseline_done INTEGER NOT NULL DEFAULT 0,
  changes_token TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS drive_files (
  drive_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  md5 TEXT,
  scheduled_at INTEGER,
  source_path TEXT,
  sha256 TEXT,
  edit_id INTEGER,
  post_id INTEGER,
  title TEXT,
  caption TEXT,
  note TEXT,
  uploaded_at INTEGER,
  review_id INTEGER,
  filename_review_at INTEGER,
  held_by INTEGER,
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  job TEXT NOT NULL,
  ok INTEGER NOT NULL,
  cost REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  model TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_outbox (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  push INTEGER NOT NULL DEFAULT 1,
  read_at INTEGER,
  nudged_at INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface OutboxRow {
  id: number;
  key: string;
  event: string;
  body: string;
  attempts: number;
  nextTryAt: number;
  sentAt: number | null;
  lastError: string | null;
  createdAt: number;
  /** whether the webhook delivers it (one was set when it happened) */
  push: boolean;
  /** when an agent first read it from the feed (list_events / wait_for_events) */
  readAt: number | null;
  /** when the user was told no agent had picked it up */
  nudgedAt: number | null;
}

const toOutbox = (r: any): OutboxRow => ({
  id: r.id, key: r.key, event: r.event, body: r.body, attempts: r.attempts,
  nextTryAt: r.next_try_at, sentAt: r.sent_at, lastError: r.last_error, createdAt: r.created_at,
  push: r.push !== 0, readAt: r.read_at ?? null, nudgedAt: r.nudged_at ?? null,
});

/** JSON from a column, or `fallback` when it's empty or damaged (one bad row must not break every read). */
function parseOr<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
}

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
    // ...and before edits.
    if (!postColumns.some((c) => c.name === "edit_id")) this.db.exec("ALTER TABLE posts ADD COLUMN edit_id INTEGER REFERENCES edits(id)");
    if (!postColumns.some((c) => c.name === "require_edit")) this.db.exec("ALTER TABLE posts ADD COLUMN require_edit INTEGER NOT NULL DEFAULT 0");
    // ...and before captions were written for posts made with a blank one.
    if (!postColumns.some((c) => c.name === "caption_topic")) this.db.exec("ALTER TABLE posts ADD COLUMN caption_topic TEXT");
    // ...and before reviews: an approved review's post uploads exactly the file that was approved.
    if (!postColumns.some((c) => c.name === "review_id")) this.db.exec("ALTER TABLE posts ADD COLUMN review_id INTEGER");
    if (!postColumns.some((c) => c.name === "approved_sha256")) this.db.exec("ALTER TABLE posts ADD COLUMN approved_sha256 TEXT");
    // ...and before Fancy covers.
    if (!postColumns.some((c) => c.name === "cover")) this.db.exec("ALTER TABLE posts ADD COLUMN cover TEXT");
    // Posts made before this was recorded are 'legacy': the audit can't vouch for them.
    if (!postColumns.some((c) => c.name === "origin")) this.db.exec("ALTER TABLE posts ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'");
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    if (!jobColumns.some((c) => c.name === "uploaded_sha256")) this.db.exec("ALTER TABLE jobs ADD COLUMN uploaded_sha256 TEXT");
    const editColumns = this.db.prepare("PRAGMA table_info(edits)").all() as { name: string }[];
    if (!editColumns.some((c) => c.name === "parent_edit_id")) this.db.exec("ALTER TABLE edits ADD COLUMN parent_edit_id INTEGER");
    if (!editColumns.some((c) => c.name === "cuts_path")) this.db.exec("ALTER TABLE edits ADD COLUMN cuts_path TEXT");
    if (!editColumns.some((c) => c.name === "notes")) this.db.exec("ALTER TABLE edits ADD COLUMN notes TEXT");
    if (!editColumns.some((c) => c.name === "cover")) this.db.exec("ALTER TABLE edits ADD COLUMN cover TEXT");
    const driveColumns = this.db.prepare("PRAGMA table_info(drive_files)").all() as { name: string }[];
    if (!driveColumns.some((c) => c.name === "uploaded_at")) this.db.exec("ALTER TABLE drive_files ADD COLUMN uploaded_at INTEGER");
    if (!driveColumns.some((c) => c.name === "review_id")) this.db.exec("ALTER TABLE drive_files ADD COLUMN review_id INTEGER");
    if (!driveColumns.some((c) => c.name === "choice")) this.db.exec("ALTER TABLE drive_files ADD COLUMN choice TEXT");
    if (!driveColumns.some((c) => c.name === "filename_review_at")) {
      // Files that already reached review by their filename before this column existed are marked as such.
      this.db.exec("ALTER TABLE drive_files ADD COLUMN filename_review_at INTEGER");
      this.db.exec("UPDATE drive_files SET filename_review_at = updated_at WHERE review_id IS NOT NULL OR post_id IS NOT NULL OR state IN ('reviewing', 'unreviewed', 'rejected', 'scheduled', 'cancelled')");
    }
    // The campaign holding a held file (null for files held before this was recorded), and when the user let it go.
    if (!driveColumns.some((c) => c.name === "held_by")) this.db.exec("ALTER TABLE drive_files ADD COLUMN held_by INTEGER");
    if (!driveColumns.some((c) => c.name === "released_at")) this.db.exec("ALTER TABLE drive_files ADD COLUMN released_at INTEGER");
    const connColumns = this.db.prepare("PRAGMA table_info(drive_connection)").all() as { name: string }[];
    if (!connColumns.some((c) => c.name === "changes_token")) this.db.exec("ALTER TABLE drive_connection ADD COLUMN changes_token TEXT");
    // ...and before the outbox became the event feed every agent can read, not only a webhook.
    const outboxColumns = this.db.prepare("PRAGMA table_info(notify_outbox)").all() as { name: string }[];
    if (!outboxColumns.some((c) => c.name === "push")) this.db.exec("ALTER TABLE notify_outbox ADD COLUMN push INTEGER NOT NULL DEFAULT 1");
    if (!outboxColumns.some((c) => c.name === "read_at")) this.db.exec("ALTER TABLE notify_outbox ADD COLUMN read_at INTEGER");
    if (!outboxColumns.some((c) => c.name === "nudged_at")) this.db.exec("ALTER TABLE notify_outbox ADD COLUMN nudged_at INTEGER");
    // A crash mid-run leaves jobs "running"; their progress checkpoint lets them resume safely.
    const interrupted = this.db.prepare("UPDATE jobs SET state = 'retry' WHERE state = 'running' RETURNING id").all() as { id: number }[];
    // ...and a campaign post's job stays held while the campaign kill switch is on.
    if (interrupted.length && this.pref<boolean>("campaigns.killed") === true) {
      for (const { id } of interrupted) {
        const postId = this.campaignPostOfJob(id);
        if (postId !== null) this.holdPost(postId);
      }
    }
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

  putOAuthState(state: string, platform: SignIn, verifier: string) {
    this.db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(Date.now() - 15 * 60_000);
    this.db.prepare("INSERT INTO oauth_states VALUES (?, ?, ?, ?)").run(state, platform, verifier, Date.now());
  }

  /** Which platform a pending sign-in belongs to; the redirect page's callback doesn't say. */
  oauthStatePlatform(state: string): SignIn | undefined {
    const row = this.db.prepare("SELECT platform FROM oauth_states WHERE state = ?").get(state) as { platform: SignIn } | undefined;
    return row?.platform;
  }

  takeOAuthState(state: string, platform: SignIn): string | undefined {
    const row = this.db
      .prepare("SELECT verifier FROM oauth_states WHERE state = ? AND platform = ? AND created_at > ?")
      .get(state, platform, Date.now() - 15 * 60_000) as { verifier: string } | undefined;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    return row?.verifier;
  }

  // ---- posts & jobs ----

  /** held: the jobs are made held (see holdPost) in the same transaction, so they can never go out before someone releases them. */
  createPost(p: Omit<Post, "id" | "createdAt">, accountIds: number[], opts: { held?: boolean } = {}): number {
    this.db.exec("BEGIN");
    try {
      const postId = this.insertPost(p, accountIds);
      if (opts.held) this.holdPost(postId);
      this.db.exec("COMMIT");
      return postId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Creates a Drive file's post and links the two in one transaction, so a restart or an overlapping
   * tick can never make a second post for the same file. Returns null when the file already has one.
   */
  createDrivePost(driveId: string, p: Omit<Post, "id" | "createdAt">, accountIds: number[], note: string | null): number | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT post_id FROM drive_files WHERE drive_id = ?").get(driveId) as { post_id: number | null } | undefined;
      if (!row || row.post_id !== null) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const postId = this.insertPost(p, accountIds);
      this.db.prepare("UPDATE drive_files SET state = 'scheduled', post_id = ?, note = ?, updated_at = ? WHERE drive_id = ?").run(postId, note, Date.now(), driveId);
      this.db.exec("COMMIT");
      return postId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private insertPost(p: Omit<Post, "id" | "createdAt">, accountIds: number[]): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO posts (caption, title, source_path, sha256, tiktok, created_at, scheduled_at, edit_id, require_edit, caption_topic, review_id, approved_sha256, origin, cover) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.caption, p.title, p.sourcePath, p.sha256, p.tiktok ? JSON.stringify(p.tiktok) : null, Date.now(), p.scheduledAt ?? null, p.editId ?? null, p.requireEdit ? 1 : 0, p.captionTopic ?? null,
        p.reviewId ?? null, p.approvedSha256 ?? null, p.origin ?? "window", p.cover ? JSON.stringify(p.cover) : null);
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
    return postId;
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
      editId: r.edit_id ?? null,
      requireEdit: Boolean(r.require_edit),
      captionTopic: r.caption_topic ?? null,
      reviewId: r.review_id ?? null,
      approvedSha256: r.approved_sha256 ?? null,
      origin: r.origin,
      cover: parseOr(r.cover, null),
    };
  }

  /** Posts made with a blank caption whose caption the AI hasn't written yet. */
  postsAwaitingCaption(): Post[] {
    const rows = this.db.prepare("SELECT id FROM posts WHERE caption_topic IS NOT NULL ORDER BY id").all() as { id: number }[];
    return rows.map(({ id }) => this.post(id)!);
  }

  /**
   * The written caption (and title, unless the post already has one), which lets its jobs go. Ignored when the
   * post isn't waiting any more, because the user typed their own meanwhile. Returns whether it was used.
   */
  fillCaption(postId: number, caption: string, title: string): boolean {
    const { changes } = this.db
      .prepare("UPDATE posts SET caption = ?, title = CASE WHEN title = '' THEN ? ELSE title END, caption_topic = NULL WHERE id = ? AND caption_topic IS NOT NULL")
      .run(caption, title, postId);
    return changes > 0;
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

  /** Posts that go (or went) out in [from, to): at their scheduled time, or when made if they had none. */
  postsBetween(from: number, to: number) {
    const rows = this.db
      .prepare("SELECT id FROM posts WHERE COALESCE(scheduled_at, created_at) >= ? AND COALESCE(scheduled_at, created_at) < ? ORDER BY COALESCE(scheduled_at, created_at), id")
      .all(from, to) as { id: number }[];
    return rows.map(({ id }) => ({ post: this.post(id)!, jobs: this.jobsForPost(id) }));
  }

  /** Drive files with a posting time in [from, to) that haven't become a post (yet). */
  driveFilesBetween(from: number, to: number): DriveFileRecord[] {
    return this.db
      .prepare("SELECT * FROM drive_files WHERE post_id IS NULL AND scheduled_at >= ? AND scheduled_at < ? AND state NOT IN ('ignored', 'pending', 'removed') ORDER BY scheduled_at")
      .all(from, to)
      .map(toDriveFile);
  }

  /** The Drive file a post was made for. */
  driveFileForPost(postId: number): DriveFileRecord | undefined {
    const r = this.db.prepare("SELECT * FROM drive_files WHERE post_id = ?").get(postId);
    return r ? toDriveFile(r) : undefined;
  }

  jobsForPost(postId: number): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE post_id = ? ORDER BY platform").all(postId).map(toJob);
  }

  job(id: number): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? toJob(row) : undefined;
  }

  /** Atomically claims the next due job, skipping platforms already busy and posts still waiting for their caption. */
  claimNextJob(busy: Set<Platform>): Job | undefined {
    const placeholders = [...busy].map(() => "?").join(",");
    const row = this.db
      .prepare(
        `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state IN ('queued', 'retry', 'waiting_quota') AND next_run_at <= ?
           AND post_id NOT IN (SELECT id FROM posts WHERE caption_topic IS NOT NULL)
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
    // A campaign post's job that was mid-upload when the kill switch was pressed falls back into the queue held.
    if ((state === "retry" || state === "waiting_quota" || state === "queued") && this.pref<boolean>("campaigns.killed") === true) {
      const postId = this.campaignPostOfJob(jobId);
      if (postId !== null) this.holdPost(postId);
    }
  }

  /** The post of a job when a campaign's review made it, else null. */
  private campaignPostOfJob(jobId: number): number | null {
    try {
      const r = this.db.prepare(
        "SELECT p.id FROM jobs j JOIN posts p ON p.id = j.post_id JOIN reviews r ON r.id = p.review_id WHERE j.id = ? AND r.requested_via = 'campaign'",
      ).get(jobId) as { id: number } | undefined;
      return r?.id ?? null;
    } catch {
      return null; // no reviews table: no campaign posts
    }
  }

  /** The hash of the file a job is about to upload (the audit compares it with what was approved). */
  recordUpload(jobId: number, sha256: string) {
    this.db.prepare("UPDATE jobs SET uploaded_sha256 = ? WHERE id = ?").run(sha256, jobId);
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
   * Moves a post to a new time, but only while none of its jobs has started (no attempt, no upload checkpoint): a
   * held job stays held and goes at the new time once released. Returns whether it moved.
   */
  movePost(postId: number, at: number): boolean {
    const jobs = this.db.prepare("SELECT id, state, attempts, progress FROM jobs WHERE post_id = ?").all(postId) as { id: number; state: string; attempts: number; progress: string }[];
    const unstarted = (j: (typeof jobs)[number]) => {
      if (j.state !== "queued" || j.attempts !== 0) return false;
      return Object.keys(JSON.parse(j.progress) as object).every((k) => k === "heldFrom");
    };
    if (!jobs.length || !jobs.every(unstarted)) return false;
    // A savepoint, so it nests inside a caller's transaction (a campaign's table saved with its change log).
    this.db.exec("SAVEPOINT move_post");
    try {
      for (const j of jobs) {
        const progress = JSON.parse(j.progress) as Record<string, unknown>;
        if (typeof progress.heldFrom === "number") {
          progress.heldFrom = at;
          this.db.prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(progress), Date.now(), j.id);
        } else this.db.prepare("UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?").run(at, Date.now(), j.id);
      }
      this.db.prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").run(at, postId);
      this.db.exec("RELEASE move_post");
    } catch (err) {
      this.db.exec("ROLLBACK TO move_post; RELEASE move_post");
      throw err;
    }
    return true;
  }

  /**
   * Holds a post's jobs that haven't gone out (the campaign kill switch, or a campaign post waiting for its time):
   * they won't run until releasePost. The time they had is kept in progress.heldFrom. Returns how many were held.
   */
  holdPost(postId: number): number {
    const jobs = this.db.prepare("SELECT id, next_run_at, progress FROM jobs WHERE post_id = ? AND state IN ('queued', 'retry', 'waiting_quota')").all(postId) as { id: number; next_run_at: number; progress: string }[];
    let held = 0;
    for (const j of jobs) {
      const progress = JSON.parse(j.progress) as Record<string, unknown>;
      if (typeof progress.heldFrom === "number") continue;
      progress.heldFrom = j.next_run_at;
      this.db.prepare("UPDATE jobs SET next_run_at = ?, progress = ?, updated_at = ? WHERE id = ?").run(Number.MAX_SAFE_INTEGER, JSON.stringify(progress), Date.now(), j.id);
      held++;
    }
    return held;
  }

  /**
   * Lets a held post's jobs go again: at `at` when given (the post's scheduled time moves with them), else at the
   * time they had, or now if that has passed. Returns how many were released.
   */
  releasePost(postId: number, opts: { at?: number; now?: number } = {}): number {
    const { at } = opts;
    const jobs = this.db.prepare("SELECT id, progress FROM jobs WHERE post_id = ? AND state IN ('queued', 'retry', 'waiting_quota')").all(postId) as { id: number; progress: string }[];
    let released = 0;
    for (const j of jobs) {
      const progress = JSON.parse(j.progress) as Record<string, unknown>;
      if (typeof progress.heldFrom !== "number") continue;
      const next = at ?? Math.max(progress.heldFrom, opts.now ?? Date.now());
      delete progress.heldFrom;
      this.db.prepare("UPDATE jobs SET next_run_at = ?, progress = ?, updated_at = ? WHERE id = ?").run(next, JSON.stringify(progress), Date.now(), j.id);
      released++;
    }
    if (released && at !== undefined) this.db.prepare("UPDATE posts SET scheduled_at = ? WHERE id = ?").run(at, postId);
    return released;
  }

  /**
   * A cancelled post's held jobs that cancelPost had to keep (they had tried, or carry an upload checkpoint): each is
   * finished as failed and no longer held, so it never goes out and stays in the history; retry_job can send it
   * deliberately. Returns the platforms they were for.
   */
  failHeld(postId: number): string[] {
    const jobs = this.db.prepare("SELECT id, platform, progress FROM jobs WHERE post_id = ? AND state IN ('queued', 'retry', 'waiting_quota')").all(postId) as { id: number; platform: string; progress: string }[];
    const platforms: string[] = [];
    for (const j of jobs) {
      const progress = JSON.parse(j.progress) as Record<string, unknown>;
      if (typeof progress.heldFrom !== "number") continue;
      const next = progress.heldFrom;
      delete progress.heldFrom;
      this.db
        .prepare("UPDATE jobs SET state = 'failed', error = ?, progress = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
        .run(`cancelled while held: it had already started on ${j.platform}; check there for a leftover draft`, JSON.stringify(progress), next, Date.now(), j.id);
      platforms.push(j.platform);
    }
    return platforms;
  }

  /**
   * Cancels a post's unstarted jobs: never tried, nothing sent. A held one counts when holding is all its progress
   * says (in a retry or waiting for quota too). A job that has tried, or carries an upload checkpoint (an Instagram
   * container, a Facebook upload), is left alone, like jobs under way: it may have half-made a post on the platform.
   * Deletes the post when no jobs remain.
   */
  cancelPost(postId: number): { cancelled: number; deleted: Post | undefined; orphanedSource: string | null } {
    const post = this.post(postId);
    const { changes } = this.db
      .prepare(`DELETE FROM jobs WHERE post_id = ? AND attempts = 0 AND ((state = 'queued' AND progress = '{}')
                OR (state IN ('queued', 'retry', 'waiting_quota') AND json_extract(progress, '$.heldFrom') IS NOT NULL
                    AND json_remove(progress, '$.heldFrom') = '{}'))`)
      .run(postId);
    const left = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE post_id = ?").get(postId) as { n: number };
    if (left.n === 0) {
      this.db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
      this.db.prepare("UPDATE drive_files SET state = 'cancelled', post_id = NULL, note = 'its post was cancelled', updated_at = ? WHERE post_id = ?").run(Date.now(), postId);
    }
    const deleted = left.n === 0 ? post : undefined;
    return { cancelled: Number(changes), deleted, orphanedSource: deleted && !this.sourceInUse(deleted.sourcePath) ? deleted.sourcePath : null };
  }

  /**
   * A video deleted from the Drive folder: cancels its post if that hasn't started going out (what's already
   * posted stays posted) and takes it off the list. The record is kept, so the same file is never taken in again.
   */
  removeDriveFile(driveId: string): { cancelled: number; orphanedSource: string | null } {
    const f = this.driveFile(driveId);
    if (!f) return { cancelled: 0, orphanedSource: null };
    const out = f.postId !== null && this.post(f.postId) ? this.cancelPost(f.postId) : { cancelled: 0, orphanedSource: null };
    this.db.prepare("UPDATE drive_files SET state = 'removed', note = 'deleted from the Drive folder', updated_at = ? WHERE drive_id = ?").run(Date.now(), driveId);
    return { cancelled: out.cancelled, orphanedSource: out.orphanedSource };
  }

  /** Whether any post, edit or Drive file still needs this uploaded video (edits share one copy of a file). */
  sourceInUse(path: string): boolean {
    const used = (sql: string) => Boolean(this.db.prepare(sql).get(path));
    return used("SELECT 1 FROM posts WHERE source_path = ?") || used("SELECT 1 FROM edits WHERE source_path = ?") || used("SELECT 1 FROM drive_files WHERE source_path = ?");
  }

  /** Points an unstarted post at an edit (or back to the original). Edited Drive posts can't go back to the original. */
  setPostEdit(postId: number, editId: number | null): number {
    if (editId === null && this.post(postId)?.requireEdit) return 0;
    if (!this.allUnstarted(postId)) return 0;
    this.db.prepare("UPDATE posts SET edit_id = ? WHERE id = ?").run(editId, postId);
    return this.jobsForPost(postId).length;
  }

  /**
   * Changes the caption and title of a post that hasn't started going out anywhere. A caption the user types
   * replaces one the AI is still writing; leaving it blank keeps the AI writing it.
   */
  updatePostText(postId: number, caption: string, title: string): number {
    if (!this.allUnstarted(postId)) return 0;
    this.db
      .prepare("UPDATE posts SET caption = ?, title = ?, caption_topic = CASE WHEN ? = '' THEN caption_topic ELSE NULL END WHERE id = ?")
      .run(caption, title, caption.trim(), postId);
    return this.jobsForPost(postId).length;
  }

  private allUnstarted(postId: number): boolean {
    const count = (sql: string) => (this.db.prepare(sql).get(postId) as { n: number }).n;
    const total = count("SELECT COUNT(*) AS n FROM jobs WHERE post_id = ?");
    return total > 0 && total === count(`SELECT COUNT(*) AS n ${this.unstartedJobs(postId)}`);
  }

  // ---- edits ----

  /**
   * Queues an edit, or returns the one already made (or being made) from the same file with the same settings.
   * Rejected and superseded edits aren't reused: asking for those settings again makes a new edit (its file is cached).
   */
  createEdit(sourcePath: string, sha256: string, settings: EditSettings, parentEditId: number | null = null): Edit {
    const key = editKey(sha256, settings);
    const existing = this.db.prepare("SELECT id FROM edits WHERE key = ? AND state NOT IN ('failed', 'rejected', 'superseded') ORDER BY id DESC LIMIT 1").get(key) as { id: number } | undefined;
    if (existing) return this.edit(existing.id)!;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO edits (source_path, sha256, settings, key, state, parent_edit_id, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
      .run(sourcePath, sha256, JSON.stringify(settings), key, parentEditId, Date.now());
    return this.edit(Number(lastInsertRowid))!;
  }

  edit(id: number): Edit | undefined {
    const r = this.db.prepare("SELECT * FROM edits WHERE id = ?").get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      sourcePath: r.source_path,
      sha256: r.sha256,
      settings: JSON.parse(r.settings),
      key: r.key,
      state: r.state,
      progress: r.progress,
      outputPath: r.output_path,
      durationSec: r.duration_sec,
      transcriptPath: r.transcript_path,
      error: r.error,
      approvedAt: r.approved_at,
      parentEditId: r.parent_edit_id ?? null,
      cutsPath: r.cuts_path ?? null,
      notes: parseOr(r.notes, []),
      cover: parseOr(r.cover, null),
      createdAt: r.created_at,
    };
  }

  /** Atomically takes the oldest queued edit. */
  claimNextEdit(): Edit | undefined {
    const row = this.db
      .prepare("UPDATE edits SET state = 'transcribing', progress = 0, error = NULL WHERE id = (SELECT id FROM edits WHERE state = 'queued' ORDER BY id LIMIT 1) RETURNING id")
      .get() as { id: number } | undefined;
    return row ? this.edit(row.id) : undefined;
  }

  updateEdit(id: number, f: Partial<Pick<Edit, "state" | "progress" | "outputPath" | "durationSec" | "transcriptPath" | "error" | "cutsPath" | "notes" | "cover">>) {
    const cols = { state: "state", progress: "progress", outputPath: "output_path", durationSec: "duration_sec", transcriptPath: "transcript_path", error: "error", cutsPath: "cuts_path", notes: "notes", cover: "cover" } as const;
    const keys = (Object.keys(f) as (keyof typeof cols)[]).filter((k) => k in cols);
    if (!keys.length) return;
    this.db.prepare(`UPDATE edits SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => (k === "notes" || k === "cover" ? (f[k] == null ? null : JSON.stringify(f[k])) : f[k] ?? null)), id);
  }

  /** Only the user approves edits (the page's Approve button, or a review they approved); agents have no way to. */
  approveEdit(id: number) {
    this.db.prepare("UPDATE edits SET approved_at = ? WHERE id = ? AND state = 'ready'").run(Date.now(), id);
  }

  /** A ready (or failed) edit the user turned down, or one replaced by a revision. Never once approved. */
  closeEdit(id: number, state: "rejected" | "superseded"): boolean {
    const { changes } = this.db.prepare("UPDATE edits SET state = ? WHERE id = ? AND approved_at IS NULL AND state IN ('ready', 'failed', 'queued', 'rejected')").run(state, id);
    return changes > 0;
  }

  /** Edits still to be made or being made. */
  openEditCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM edits WHERE state IN ('queued', 'transcribing', 'editing')").get() as { n: number }).n;
  }

  /** Edits interrupted by a crash or quit start over. */
  requeueInterruptedEdits() {
    this.db.prepare("UPDATE edits SET state = 'queued', progress = 0 WHERE state IN ('transcribing', 'editing')").run();
  }

  // ---- Google Drive ----

  driveConnection(): DriveConnection | undefined {
    const r = this.db.prepare("SELECT * FROM drive_connection WHERE id = 1").get() as any;
    if (!r) return undefined;
    return {
      accessToken: decrypt(this.key, r.access_token),
      refreshToken: decrypt(this.key, r.refresh_token),
      expiresAt: r.expires_at,
      email: r.email,
      folderId: r.folder_id,
      baselineDone: Boolean(r.baseline_done),
      changesToken: r.changes_token,
      error: r.error,
    };
  }

  /** Saves Drive tokens (a new sign-in also clears any "reconnect" error). */
  saveDriveTokens(t: { accessToken: string; refreshToken: string; expiresAt: number | null }, email?: string) {
    this.db
      .prepare(
        `INSERT INTO drive_connection (id, access_token, refresh_token, expires_at, email) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, email = CASE WHEN ? THEN excluded.email ELSE email END, error = NULL`,
      )
      .run(encrypt(this.key, t.accessToken), encrypt(this.key, t.refreshToken), t.expiresAt, email ?? "", email === undefined ? 0 : 1);
  }

  /** A new folder starts with a fresh baseline: what's already in it is never posted. */
  setDriveFolder(folderId: string | null) {
    this.db.prepare("UPDATE drive_connection SET folder_id = ?, baseline_done = 0, changes_token = NULL, error = NULL WHERE id = 1 AND COALESCE(folder_id, '') != COALESCE(?, '')").run(folderId, folderId);
  }

  setDriveError(error: string | null) {
    this.db.prepare("UPDATE drive_connection SET error = ? WHERE id = 1").run(error);
  }

  setDriveChangesToken(token: string | null) {
    this.db.prepare("UPDATE drive_connection SET changes_token = ? WHERE id = 1").run(token);
  }

  markDriveBaseline() {
    this.db.prepare("UPDATE drive_connection SET baseline_done = 1 WHERE id = 1").run();
  }

  deleteDriveConnection() {
    this.db.prepare("DELETE FROM drive_connection WHERE id = 1").run();
  }

  driveFile(driveId: string): DriveFileRecord | undefined {
    const r = this.db.prepare("SELECT * FROM drive_files WHERE drive_id = ?").get(driveId);
    return r ? toDriveFile(r) : undefined;
  }

  driveFiles(limit = 50): DriveFileRecord[] {
    return this.db.prepare("SELECT * FROM drive_files WHERE state NOT IN ('ignored', 'pending', 'removed') ORDER BY created_at DESC LIMIT ?").all(limit).map(toDriveFile);
  }

  /** The Drive file an edit (or an earlier version of it) was made for. */
  driveFileForEdit(editId: number): DriveFileRecord | undefined {
    for (let id: number | null = editId, hops = 0; id !== null && hops < 50; hops++) {
      const r = this.db.prepare("SELECT * FROM drive_files WHERE edit_id = ?").get(id);
      if (r) return toDriveFile(r);
      id = this.edit(id)?.parentEditId ?? null;
    }
    return undefined;
  }

  /** Records the post an approved review of a Drive file's edit made; only once. */
  linkDrivePost(driveId: string, postId: number, note: string | null) {
    this.db.prepare("UPDATE drive_files SET state = 'scheduled', post_id = ?, note = ?, updated_at = ? WHERE drive_id = ? AND post_id IS NULL")
      .run(postId, note, Date.now(), driveId);
  }

  driveFileForReview(reviewId: number): DriveFileRecord | undefined {
    const r = this.db.prepare("SELECT * FROM drive_files WHERE review_id = ?").get(reviewId);
    return r ? toDriveFile(r) : undefined;
  }

  /** The newest revision of an edit (revise_edit makes children), or the edit itself when it has none. */
  latestRevision(editId: number): number {
    let id = editId;
    for (let hops = 0; hops < 50; hops++) {
      const child = this.db.prepare("SELECT id FROM edits WHERE parent_edit_id = ? ORDER BY id DESC LIMIT 1").get(id) as { id: number } | undefined;
      if (!child) break;
      id = child.id;
    }
    return id;
  }

  /** Files part-way through the pipeline, oldest first. */
  driveFilesIn(states: DriveFileRecord["state"][]): DriveFileRecord[] {
    return this.db
      .prepare(`SELECT * FROM drive_files WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...states)
      .map(toDriveFile);
  }

  /** Points every Drive file whose name chose the style `from` at `to` instead (a style given a new id). How many moved. */
  renameDriveStyle(from: string, to: string): number {
    const rows = this.db.prepare("SELECT drive_id, choice FROM drive_files WHERE choice IS NOT NULL").all() as { drive_id: string; choice: string }[];
    let moved = 0;
    for (const r of rows) {
      const choice = JSON.parse(r.choice) as DriveChoice;
      if (choice.styleId !== from) continue;
      this.db.prepare("UPDATE drive_files SET choice = ? WHERE drive_id = ?").run(JSON.stringify({ ...choice, styleId: to }), r.drive_id);
      moved++;
    }
    return moved;
  }

  /** Inserts a file seen in the folder, or updates the given fields of one already known. */
  upsertDriveFile(driveId: string, f: Partial<Omit<DriveFileRecord, "driveId" | "createdAt" | "updatedAt">>) {
    const cols = {
      name: "name", state: "state", size: "size", md5: "md5", scheduledAt: "scheduled_at", sourcePath: "source_path", sha256: "sha256",
      editId: "edit_id", postId: "post_id", title: "title", caption: "caption", note: "note", uploadedAt: "uploaded_at", reviewId: "review_id",
      choice: "choice", filenameReviewAt: "filename_review_at", heldBy: "held_by", releasedAt: "released_at",
    } as const;
    const keys = (Object.keys(f) as (keyof typeof cols)[]).filter((k) => k in cols);
    const values = keys.map((k) => (k === "choice" ? (f.choice ? JSON.stringify(f.choice) : null) : (f[k] ?? null)));
    if (!this.driveFile(driveId)) {
      this.db
        .prepare(`INSERT INTO drive_files (drive_id, ${keys.map((k) => cols[k]).join(", ")}, created_at, updated_at) VALUES (?, ${keys.map(() => "?").join(", ")}, ?, ?)`)
        .run(driveId, ...values, Date.now(), Date.now());
    } else if (keys.length) {
      this.db.prepare(`UPDATE drive_files SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")}, updated_at = ? WHERE drive_id = ?`).run(...values, Date.now(), driveId);
    }
  }

  // ---- AI use (which provider answered which job, and what pay-per-use ones charged) ----

  recordAiUse(u: { provider: string; job: string; ok: boolean; cost?: number | null; promptTokens?: number | null; completionTokens?: number | null; model?: string | null; error?: string | null }) {
    this.db
      .prepare("INSERT INTO ai_usage (provider, job, ok, cost, prompt_tokens, completion_tokens, model, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(u.provider, u.job, u.ok ? 1 : 0, u.cost ?? null, u.promptTokens ?? null, u.completionTokens ?? null, u.model ?? null, u.error ?? null, Date.now());
    // Keep the last few thousand; it's only for the AI Providers panel.
    this.db.prepare("DELETE FROM ai_usage WHERE id <= (SELECT MAX(id) FROM ai_usage) - 5000").run();
  }

  /** Calls (every attempt, ok or not) and tokens (where reported) of the given jobs since `from` (ms). */
  aiUsageSince(from: number, jobs: string[]): { calls: number; tokens: number } {
    if (!jobs.length) return { calls: 0, tokens: 0 };
    const row = this.db
      .prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens FROM ai_usage WHERE created_at >= ? AND job IN (${jobs.map(() => "?").join(",")})`)
      .get(from, ...jobs) as { calls: number; tokens: number };
    return { calls: row.calls, tokens: row.tokens };
  }

  /** The latest answer and failure per provider. */
  aiLastUses(): { provider: string; ok: number; error: string | null; created_at: number }[] {
    return this.db
      .prepare(`SELECT provider, ok, error, MAX(created_at) AS created_at FROM ai_usage GROUP BY provider, ok`)
      .all() as { provider: string; ok: number; error: string | null; created_at: number }[];
  }

  /** A provider's paid answers for one job: how many, the average and the latest cost, and average sizes. */
  aiCosts(provider: string, job: string): { uses: number; average: number | null; last: number | null; promptTokens: number | null; completionTokens: number | null } {
    const avg = this.db
      .prepare("SELECT COUNT(*) AS uses, AVG(cost) AS average, AVG(prompt_tokens) AS p, AVG(completion_tokens) AS c FROM (SELECT * FROM ai_usage WHERE provider = ? AND job = ? AND ok = 1 AND cost IS NOT NULL ORDER BY id DESC LIMIT 50)")
      .get(provider, job) as { uses: number; average: number | null; p: number | null; c: number | null };
    const last = this.db
      .prepare("SELECT cost FROM ai_usage WHERE provider = ? AND job = ? AND ok = 1 AND cost IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(provider, job) as { cost: number } | undefined;
    return { uses: avg.uses, average: avg.average, last: last?.cost ?? null, promptTokens: avg.p, completionTokens: avg.c };
  }

  // ---- preferences (small JSON values kept in the database) ----

  pref<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM prefs WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setPref(key: string, value: unknown) {
    this.db.prepare("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  deletePref(key: string) {
    this.db.prepare("DELETE FROM prefs WHERE key = ?").run(key);
  }

  /** A preference kept encrypted at rest, like the OAuth tokens (an API key, say). */
  secretPref(key: string): string | undefined {
    const sealed = this.pref<string>(key);
    return sealed ? decrypt(this.key, sealed) : undefined;
  }

  setSecretPref(key: string, value: string) {
    this.setPref(key, encrypt(this.key, value));
  }

  /** Jobs that still have to go out; the desktop app keeps running in the background while any remain. */
  pendingJobCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running', 'retry', 'waiting_quota')").get() as { n: number }).n;
  }

  /**
   * Re-queues a failed job (retry_job, the window's Retry). A campaign post's job goes back held, and the campaign
   * task that placed the post back to "scheduled", so the campaign worker places it again: the kill switch, the daily
   * cap and its day's timing all apply again, as for an approval. Returns why it can't be retried, or null.
   */
  retryJob(jobId: number): string | null {
    const postId = this.campaignPostOfJob(jobId);
    let taskId: number | null = null;
    if (postId !== null) {
      // The task whose review made the post (a kept video's post line shares the post, but doesn't own it).
      const owner = this.db.prepare(
        "SELECT t.id FROM campaign_tasks t JOIN posts p ON p.id = t.post_id AND p.review_id = t.review_id WHERE p.id = ? AND t.state <> 'replaced' ORDER BY t.id LIMIT 1",
      ).get(postId) as { id: number } | undefined;
      if (!owner) return "this campaign post has no campaign task to place it any more, so it can't be retried";
      taskId = owner.id;
    }
    // A campaign job is held from the time its post was placed at: placed again, it keeps that time only if it is
    // still ahead and still fits the cap.
    const from = postId === null ? Date.now() : this.post(postId)?.scheduledAt ?? Date.now();
    this.db.exec("BEGIN");
    try {
      const { changes } = this.db
        .prepare("UPDATE jobs SET state = 'queued', attempts = 0, error = NULL, progress = json_remove(progress, '$.heldFrom'), next_run_at = ?, updated_at = ? WHERE id = ? AND state = 'failed'")
        .run(from, Date.now(), jobId);
      if (changes && postId !== null && taskId !== null) {
        this.holdPost(postId);
        this.db.prepare("UPDATE campaign_tasks SET state = 'scheduled', error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), taskId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return null;
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

  // ---- the event log: agents read it (list_events / wait_for_events), and a webhook, when set, delivers it ----

  /** Logs an event once per key (a repeat of the same key is ignored); push = the webhook should deliver it. */
  addEvent(key: string, event: string, body: string, push = true): boolean {
    const now = Date.now();
    return this.db.prepare("INSERT OR IGNORE INTO notify_outbox (key, event, body, next_try_at, created_at, push) VALUES (?, ?, ?, ?, ?, ?)").run(key, event, body, now, now, push ? 1 : 0).changes > 0;
  }

  dueEvents(now: number, maxAttempts = 5): OutboxRow[] {
    return (this.db.prepare("SELECT * FROM notify_outbox WHERE push = 1 AND sent_at IS NULL AND attempts < ? AND next_try_at <= ? ORDER BY id").all(maxAttempts, now) as any[]).map(toOutbox);
  }

  outbox(): OutboxRow[] {
    return (this.db.prepare("SELECT * FROM notify_outbox ORDER BY id").all() as any[]).map(toOutbox);
  }

  /** Events after `since` (an event id), oldest first; with since null, the ones no agent has read yet. */
  feed(since: number | null, limit: number, types: string[] = []): OutboxRow[] {
    const where = [since === null ? "read_at IS NULL" : "id > ?", ...(types.length ? [`event IN (${types.map(() => "?").join(", ")})`] : [])].join(" AND ");
    const args = [...(since === null ? [] : [since]), ...types, limit];
    return (this.db.prepare(`SELECT * FROM notify_outbox WHERE ${where} ORDER BY id LIMIT ?`).all(...args) as any[]).map(toOutbox);
  }

  latestEventId(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM notify_outbox").get() as { id: number }).id;
  }

  eventByKey(key: string): OutboxRow | undefined {
    const row = this.db.prepare("SELECT * FROM notify_outbox WHERE key = ?").get(key);
    return row ? toOutbox(row) : undefined;
  }

  markEventsRead(ids: number[], at = Date.now()) {
    const stmt = this.db.prepare("UPDATE notify_outbox SET read_at = ? WHERE id = ? AND read_at IS NULL");
    for (const id of ids) stmt.run(at, id);
  }

  markEventNudged(id: number, at = Date.now()) {
    this.db.prepare("UPDATE notify_outbox SET nudged_at = ? WHERE id = ?").run(at, id);
  }

  markEvent(id: number, f: { sentAt?: number; attempts: number; nextTryAt: number; error: string | null }) {
    this.db.prepare("UPDATE notify_outbox SET sent_at = ?, attempts = ?, next_try_at = ?, last_error = ? WHERE id = ?").run(f.sentAt ?? null, f.attempts, f.nextTryAt, f.error, id);
  }

  pruneEvents(before: number) {
    this.db.prepare("DELETE FROM notify_outbox WHERE created_at < ?").run(before);
  }

  close() {
    this.db.close();
  }
}

function toDriveFile(r: any): DriveFileRecord {
  return {
    driveId: r.drive_id,
    name: r.name,
    state: r.state,
    size: r.size,
    md5: r.md5,
    scheduledAt: r.scheduled_at,
    sourcePath: r.source_path,
    sha256: r.sha256,
    editId: r.edit_id,
    postId: r.post_id,
    title: r.title,
    caption: r.caption,
    note: r.note,
    uploadedAt: r.uploaded_at,
    reviewId: r.review_id ?? null,
    filenameReviewAt: r.filename_review_at ?? null,
    heldBy: r.held_by ?? null,
    releasedAt: r.released_at ?? null,
    choice: r.choice ? JSON.parse(r.choice) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
    uploadedSha256: r.uploaded_sha256 ?? null,
    updatedAt: r.updated_at,
  };
}
