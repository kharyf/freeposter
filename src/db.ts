import { DatabaseSync } from "node:sqlite";
import { decrypt, encrypt } from "./crypto.ts";
import { editKey, type EditSettings } from "./edit/settings.ts";
import type { Account, DriveConnection, DriveFileRecord, Edit, Job, JobState, NewAccount, Platform, Post, TikTokOptions, TokenSet } from "./types.ts";

/** What a pending sign-in is for: a posting platform, or the watched Google Drive folder. */
export type SignIn = Platform | "drive";

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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
    // ...and before edits.
    if (!postColumns.some((c) => c.name === "edit_id")) this.db.exec("ALTER TABLE posts ADD COLUMN edit_id INTEGER REFERENCES edits(id)");
    if (!postColumns.some((c) => c.name === "require_edit")) this.db.exec("ALTER TABLE posts ADD COLUMN require_edit INTEGER NOT NULL DEFAULT 0");
    // ...and before captions were written for posts made with a blank one.
    if (!postColumns.some((c) => c.name === "caption_topic")) this.db.exec("ALTER TABLE posts ADD COLUMN caption_topic TEXT");
    const driveColumns = this.db.prepare("PRAGMA table_info(drive_files)").all() as { name: string }[];
    if (!driveColumns.some((c) => c.name === "uploaded_at")) this.db.exec("ALTER TABLE drive_files ADD COLUMN uploaded_at INTEGER");
    const connColumns = this.db.prepare("PRAGMA table_info(drive_connection)").all() as { name: string }[];
    if (!connColumns.some((c) => c.name === "changes_token")) this.db.exec("ALTER TABLE drive_connection ADD COLUMN changes_token TEXT");
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

  createPost(p: Omit<Post, "id" | "createdAt">, accountIds: number[]): number {
    this.db.exec("BEGIN");
    try {
      const postId = this.insertPost(p, accountIds);
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
      .prepare("INSERT INTO posts (caption, title, source_path, sha256, tiktok, created_at, scheduled_at, edit_id, require_edit, caption_topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(p.caption, p.title, p.sourcePath, p.sha256, p.tiktok ? JSON.stringify(p.tiktok) : null, Date.now(), p.scheduledAt ?? null, p.editId ?? null, p.requireEdit ? 1 : 0, p.captionTopic ?? null);
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
    };
  }

  /** Posts made with a blank caption whose caption Claude hasn't written yet. */
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
  cancelPost(postId: number): { cancelled: number; deleted: Post | undefined; orphanedSource: string | null } {
    const post = this.post(postId);
    const { changes } = this.db.prepare(`DELETE ${this.unstartedJobs(postId)}`).run(postId);
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
   * replaces one Claude is still writing; leaving it blank keeps Claude writing it.
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

  /** Queues an edit, or returns the one already made (or being made) from the same file with the same settings. */
  createEdit(sourcePath: string, sha256: string, settings: EditSettings): Edit {
    const key = editKey(sha256, settings);
    const existing = this.db.prepare("SELECT id FROM edits WHERE key = ? AND state != 'failed' ORDER BY id DESC LIMIT 1").get(key) as { id: number } | undefined;
    if (existing) return this.edit(existing.id)!;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO edits (source_path, sha256, settings, key, state, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
      .run(sourcePath, sha256, JSON.stringify(settings), key, Date.now());
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

  updateEdit(id: number, f: Partial<Pick<Edit, "state" | "progress" | "outputPath" | "durationSec" | "transcriptPath" | "error">>) {
    const cols = { state: "state", progress: "progress", outputPath: "output_path", durationSec: "duration_sec", transcriptPath: "transcript_path", error: "error" } as const;
    const keys = (Object.keys(f) as (keyof typeof cols)[]).filter((k) => k in cols);
    if (!keys.length) return;
    this.db.prepare(`UPDATE edits SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => f[k] ?? null), id);
  }

  /** Only the user approves edits (the page's Approve button); agents have no way to. */
  approveEdit(id: number) {
    this.db.prepare("UPDATE edits SET approved_at = ? WHERE id = ? AND state = 'ready'").run(Date.now(), id);
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

  /** Files part-way through the pipeline, oldest first. */
  driveFilesIn(states: DriveFileRecord["state"][]): DriveFileRecord[] {
    return this.db
      .prepare(`SELECT * FROM drive_files WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...states)
      .map(toDriveFile);
  }

  /** Inserts a file seen in the folder, or updates the given fields of one already known. */
  upsertDriveFile(driveId: string, f: Partial<Omit<DriveFileRecord, "driveId" | "createdAt" | "updatedAt">>) {
    const cols = {
      name: "name", state: "state", size: "size", md5: "md5", scheduledAt: "scheduled_at", sourcePath: "source_path", sha256: "sha256",
      editId: "edit_id", postId: "post_id", title: "title", caption: "caption", note: "note", uploadedAt: "uploaded_at",
    } as const;
    const keys = (Object.keys(f) as (keyof typeof cols)[]).filter((k) => k in cols);
    const values = keys.map((k) => f[k] ?? null);
    if (!this.driveFile(driveId)) {
      this.db
        .prepare(`INSERT INTO drive_files (drive_id, ${keys.map((k) => cols[k]).join(", ")}, created_at, updated_at) VALUES (?, ${keys.map(() => "?").join(", ")}, ?, ?)`)
        .run(driveId, ...values, Date.now(), Date.now());
    } else if (keys.length) {
      this.db.prepare(`UPDATE drive_files SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")}, updated_at = ? WHERE drive_id = ?`).run(...values, Date.now(), driveId);
    }
  }

  // ---- preferences (small JSON values kept in the database) ----

  pref<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM prefs WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setPref(key: string, value: unknown) {
    this.db.prepare("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
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
    updatedAt: r.updated_at,
  };
}
