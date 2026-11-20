// Analytics tables: what each posted video is (labels), what the platforms said about it (append-only snapshots)
// and when to ask next (poll schedule).
import type { Store } from "../db.ts";
import type { ScoredJob } from "./score.ts";
import type { Snapshot, VideoLabels } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS video_labels (
  post_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  style_id TEXT,
  hook_id INTEGER,
  hook_text TEXT,
  angle_id INTEGER,
  angle_text TEXT,
  cta_id INTEGER,
  cta_text TEXT,
  campaign_id INTEGER,
  campaign_task_id INTEGER,
  types TEXT NOT NULL DEFAULT '[]',
  labelled_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  age_sec INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  retention TEXT
);
CREATE INDEX IF NOT EXISTS metric_snapshots_job ON metric_snapshots(job_id, age_sec);
CREATE TABLE IF NOT EXISTS metric_poll (
  job_id INTEGER PRIMARY KEY,
  next_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS metric_poll_due ON metric_poll(done, next_at);
`;

const toLabels = (r: any): VideoLabels => ({
  postId: r.post_id, source: r.source, styleId: r.style_id, hookId: r.hook_id, hookText: r.hook_text,
  angleId: r.angle_id, angleText: r.angle_text, ctaId: r.cta_id, ctaText: r.cta_text, campaignId: r.campaign_id,
  campaignTaskId: r.campaign_task_id, types: JSON.parse(r.types), labelledBy: r.labelled_by, lengthSec: r.length_sec ?? null,
});

const toSnapshot = (r: any): Snapshot => {
  const m = JSON.parse(r.metrics);
  return {
    id: r.id, jobId: r.job_id, platform: r.platform, externalId: r.external_id, takenAt: r.taken_at, ageSec: r.age_sec,
    reading: { views: m.views, viewsKind: m.viewsKind, raw: m.raw, retention: r.retention ? JSON.parse(r.retention) : null },
  };
};

export interface PollRow {
  jobId: number;
  nextAt: number;
  attempts: number;
  lastError: string | null;
  done: boolean;
}

export class AnalyticsStore {
  store: Store;

  constructor(store: Store) {
    this.store = store;
    store.db.exec(SCHEMA);
    const columns = store.db.prepare("PRAGMA table_info(video_labels)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "length_sec")) store.db.exec("ALTER TABLE video_labels ADD COLUMN length_sec INTEGER");
  }

  get db() {
    return this.store.db;
  }

  // ---- labels ----

  /** Insert or replace the labels of a post (the user correcting one replaces it). */
  setLabels(l: VideoLabels) {
    this.db
      .prepare(`INSERT INTO video_labels (post_id, source, style_id, hook_id, hook_text, angle_id, angle_text, cta_id, cta_text, campaign_id, campaign_task_id, types, labelled_by, length_sec, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (post_id) DO UPDATE SET source = excluded.source, style_id = excluded.style_id, hook_id = excluded.hook_id,
                  hook_text = excluded.hook_text, angle_id = excluded.angle_id, angle_text = excluded.angle_text, cta_id = excluded.cta_id,
                  cta_text = excluded.cta_text, campaign_id = excluded.campaign_id, campaign_task_id = excluded.campaign_task_id,
                  types = excluded.types, labelled_by = excluded.labelled_by, length_sec = COALESCE(excluded.length_sec, video_labels.length_sec)`)
      .run(l.postId, l.source, l.styleId, l.hookId, l.hookText, l.angleId, l.angleText, l.ctaId, l.ctaText, l.campaignId,
        l.campaignTaskId, JSON.stringify(l.types), l.labelledBy, l.lengthSec ?? null, Date.now());
  }

  labels(postId: number): VideoLabels | undefined {
    const r = this.db.prepare("SELECT * FROM video_labels WHERE post_id = ?").get(postId);
    return r ? toLabels(r) : undefined;
  }

  allLabels(): VideoLabels[] {
    return this.db.prepare("SELECT * FROM video_labels ORDER BY post_id").all().map(toLabels);
  }

  /** Every job that has published, with its publish time: what scoring reads. */
  scoredJobs(): ScoredJob[] {
    const rows = this.db.prepare("SELECT id, published_at FROM jobs WHERE published_at IS NOT NULL ORDER BY id").all() as { id: number; published_at: number }[];
    return rows.map((r) => ({ ...this.store.job(r.id)!, publishedAt: r.published_at }));
  }

  // ---- snapshots (append-only) ----

  addSnapshot(s: Omit<Snapshot, "id">): number {
    const { views, viewsKind, raw, retention } = s.reading;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO metric_snapshots (job_id, platform, external_id, taken_at, age_sec, metrics, retention) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(s.jobId, s.platform, s.externalId, s.takenAt, s.ageSec, JSON.stringify({ views, viewsKind, raw }), retention ? JSON.stringify(retention) : null);
    return Number(lastInsertRowid);
  }

  /** A job's snapshots, youngest first (ascending age). */
  snapshots(jobId: number): Snapshot[] {
    return this.db.prepare("SELECT * FROM metric_snapshots WHERE job_id = ? ORDER BY age_sec, id").all(jobId).map(toSnapshot);
  }

  // ---- poll schedule ----

  pollFor(jobId: number): PollRow | undefined {
    const r = this.db.prepare("SELECT * FROM metric_poll WHERE job_id = ?").get(jobId) as any;
    return r ? { jobId: r.job_id, nextAt: r.next_at, attempts: r.attempts, lastError: r.last_error, done: Boolean(r.done) } : undefined;
  }

  /** Start or reschedule a job's polling; a finished one stays finished. */
  schedulePoll(jobId: number, nextAt: number) {
    this.db
      .prepare("INSERT INTO metric_poll (job_id, next_at) VALUES (?, ?) ON CONFLICT (job_id) DO UPDATE SET next_at = excluded.next_at WHERE done = 0")
      .run(jobId, nextAt);
  }

  /** Jobs still polled whose platform wants the user to sign in again. */
  needingPermission(): number[] {
    return (this.db.prepare("SELECT job_id FROM metric_poll WHERE done = 0 AND last_error = 'needs permission' ORDER BY job_id").all() as { job_id: number }[]).map((r) => r.job_id);
  }

  duePolls(now: number, limit: number): { jobId: number; attempts: number }[] {
    return (this.db.prepare("SELECT job_id, attempts FROM metric_poll WHERE done = 0 AND next_at <= ? ORDER BY next_at LIMIT ?").all(now, limit) as any[])
      .map((r) => ({ jobId: r.job_id, attempts: r.attempts }));
  }

  /** Polling is over (the 30-day snapshot is taken or the video is gone); error says why when it's the latter. */
  finishPoll(jobId: number, error: string | null) {
    this.db.prepare("UPDATE metric_poll SET done = 1, last_error = ? WHERE job_id = ?").run(error, jobId);
  }

  /** A failed poll: remember why, count the attempt and try again at nextAt. */
  notePollError(jobId: number, error: string, nextAt: number) {
    this.db.prepare("UPDATE metric_poll SET attempts = attempts + 1, last_error = ?, next_at = ? WHERE job_id = ? AND done = 0").run(error, nextAt, jobId);
  }

  /** A successful poll: forget earlier trouble and wait for the next age. */
  pollOk(jobId: number, nextAt: number) {
    this.db.prepare("UPDATE metric_poll SET attempts = 0, last_error = NULL, next_at = ? WHERE job_id = ? AND done = 0").run(nextAt, jobId);
  }

  /** Not a failed attempt (permission, plan, a video that may be gone): say why and look again at nextAt. */
  deferPoll(jobId: number, error: string | null, nextAt: number) {
    this.db.prepare("UPDATE metric_poll SET last_error = ?, next_at = ? WHERE job_id = ? AND done = 0").run(error, nextAt, jobId);
  }
}
