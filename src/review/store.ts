// Reviews: the only way an agent gets a video posted. One row per request; the user approves, rejects or asks for
// a redo on Telegram or in the window. Every change of state is one guarded UPDATE from 'pending', so a second tap,
// a repeated Telegram update or a race between the window and the phone can decide a review only once.
import type { Store } from "../db.ts";
import type { TikTokOptions } from "../types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  source_path TEXT NOT NULL,
  master_path TEXT,
  master_sha256 TEXT,
  view_path TEXT,
  duration_sec REAL,
  draft TEXT NOT NULL,
  state TEXT NOT NULL,
  step TEXT,
  expires_at INTEGER NOT NULL,
  requested_via TEXT NOT NULL,
  nonce_hash TEXT,
  chat_id INTEGER,
  card_message_id INTEGER,
  card_dirty INTEGER NOT NULL DEFAULT 0,
  card_version INTEGER NOT NULL DEFAULT 0,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER NOT NULL DEFAULT 0,
  send_error TEXT,
  prompt_message_id INTEGER,
  decided_at INTEGER,
  decided_via TEXT,
  decided_by INTEGER,
  decision_update_id INTEGER UNIQUE,
  reason TEXT,
  note TEXT,
  at_sec REAL,
  post_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_open ON reviews(subject_kind, subject_id) WHERE state IN ('preparing', 'pending');
CREATE INDEX IF NOT EXISTS reviews_state ON reviews(state);
`;

/**
 * preparing: making the exact file and writing the caption; pending: waiting for the user;
 * approved / rejected / redo: the user decided; superseded: a newer version or request replaced it;
 * expired: nobody decided in time; failed: it couldn't be prepared, or could no longer be posted when approved.
 */
export type ReviewState = "preparing" | "pending" | "approved" | "rejected" | "redo" | "superseded" | "expired" | "failed";
export const OPEN_STATES: ReviewState[] = ["preparing", "pending"];

export type SubjectKind = "edit" | "production" | "file";

/** Where a pending review's card is in Telegram's two-tap flows. */
export type ReviewStep = "reject_reason" | "redo_reason" | "redo_note";

/** One letter each, to keep Telegram's 64-byte callback_data short. */
export const REASONS = { c: "cuts", k: "captions", f: "framing", s: "sound", z: "zooms", o: "other", n: "none" } as const;
export type Reason = (typeof REASONS)[keyof typeof REASONS];
export const isReason = (r: unknown): r is Reason => Object.values(REASONS).includes(r as Reason);

/** Everything about the post the review covers: approving it posts exactly this. */
export interface ReviewDraft {
  accountIds: number[];
  caption: string;
  title: string;
  scheduledAt: number | null;
  tiktok: TikTokOptions | null;
  allowDuplicate: boolean;
  /** set while the caption is still to be written (see captionTopicFor) */
  captionTopic: string | null;
}

export interface Review {
  id: number;
  subjectKind: SubjectKind;
  subjectId: number | null;
  revision: number;
  sourcePath: string;
  masterPath: string | null;
  masterSha256: string | null;
  viewPath: string | null;
  durationSec: number | null;
  draft: ReviewDraft;
  state: ReviewState;
  step: ReviewStep | null;
  expiresAt: number;
  /** drive: Drive intake sent its own edit, and follows the decision itself */
  requestedVia: "agent" | "window" | "drive";
  nonceHash: string | null;
  chatId: number | null;
  cardMessageId: number | null;
  cardDirty: boolean;
  /** goes up with every change the card must show; a sync clears the dirty flag only for the version it showed */
  cardVersion: number;
  sendAttempts: number;
  nextSendAt: number;
  sendError: string | null;
  promptMessageId: number | null;
  decidedAt: number | null;
  decidedVia: "telegram" | "window" | null;
  decidedBy: number | null;
  decisionUpdateId: number | null;
  reason: Reason | null;
  note: string | null;
  atSec: number | null;
  postId: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

const toReview = (r: any): Review => ({
  id: r.id, subjectKind: r.subject_kind, subjectId: r.subject_id, revision: r.revision, sourcePath: r.source_path,
  masterPath: r.master_path, masterSha256: r.master_sha256, viewPath: r.view_path, durationSec: r.duration_sec,
  draft: JSON.parse(r.draft), state: r.state, step: r.step, expiresAt: r.expires_at, requestedVia: r.requested_via,
  nonceHash: r.nonce_hash, chatId: r.chat_id, cardMessageId: r.card_message_id, cardDirty: Boolean(r.card_dirty), cardVersion: r.card_version,
  sendAttempts: r.send_attempts, nextSendAt: r.next_send_at, sendError: r.send_error, promptMessageId: r.prompt_message_id,
  decidedAt: r.decided_at, decidedVia: r.decided_via, decidedBy: r.decided_by, decisionUpdateId: r.decision_update_id,
  reason: r.reason, note: r.note, atSec: r.at_sec, postId: r.post_id, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
});

export interface Decision {
  via: "telegram" | "window";
  /** Telegram from.id */
  by?: number | null;
  /** Telegram update_id of the tap or reply: a redelivered update can't decide again */
  updateId?: number | null;
  reason?: Reason | null;
  note?: string | null;
  atSec?: number | null;
}

export class ReviewStore {
  store: Store;

  constructor(store: Store) {
    this.store = store;
    store.db.exec(SCHEMA);
  }

  get db() {
    return this.store.db;
  }

  /** A new review; any open review of the same subject is superseded (only one can be open at a time). */
  create(f: { subjectKind: SubjectKind; subjectId: number | null; revision: number; sourcePath: string; draft: ReviewDraft; expiresAt: number; requestedVia: Review["requestedVia"] }): { review: Review; superseded: number[] } {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = f.subjectId === null ? [] : (this.db
        .prepare("SELECT id FROM reviews WHERE subject_kind = ? AND subject_id = ? AND state IN ('preparing', 'pending')")
        .all(f.subjectKind, f.subjectId) as { id: number }[]).map((r) => r.id);
      for (const id of old) this.db.prepare("UPDATE reviews SET state = 'superseded', card_dirty = 1, card_version = card_version + 1, updated_at = ? WHERE id = ?").run(now, id);
      const { lastInsertRowid } = this.db
        .prepare(`INSERT INTO reviews (subject_kind, subject_id, revision, source_path, draft, state, expires_at, requested_via, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?)`)
        .run(f.subjectKind, f.subjectId, f.revision, f.sourcePath, JSON.stringify(f.draft), f.expiresAt, f.requestedVia, now, now);
      this.db.exec("COMMIT");
      return { review: this.get(Number(lastInsertRowid))!, superseded: old };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  get(id: number): Review | undefined {
    const r = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
    return r ? toReview(r) : undefined;
  }

  recent(limit = 20): Review[] {
    return this.db.prepare("SELECT * FROM reviews ORDER BY id DESC LIMIT ?").all(limit).map(toReview);
  }

  inState(...states: ReviewState[]): Review[] {
    return this.db.prepare(`SELECT * FROM reviews WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY id`).all(...states).map(toReview);
  }

  /** The review of this post (one post per review). */
  forPost(postId: number): Review | undefined {
    const r = this.db.prepare("SELECT * FROM reviews WHERE post_id = ?").get(postId);
    return r ? toReview(r) : undefined;
  }

  /** The exact file is made and the caption written: the review now waits for the user. */
  prepared(id: number, f: { masterPath: string; masterSha256: string; viewPath: string; durationSec: number; draft: ReviewDraft }): boolean {
    const { changes } = this.db
      .prepare(`UPDATE reviews SET state = 'pending', master_path = ?, master_sha256 = ?, view_path = ?, duration_sec = ?, draft = ?, updated_at = ?
                WHERE id = ? AND state = 'preparing'`)
      .run(f.masterPath, f.masterSha256, f.viewPath, f.durationSec, JSON.stringify(f.draft), Date.now(), id);
    return changes > 0;
  }

  /** Closes an open review without a decision (superseded, expired, or it failed). */
  close(id: number, state: "superseded" | "expired" | "failed", error: string | null = null): boolean {
    const { changes } = this.db
      .prepare("UPDATE reviews SET state = ?, error = ?, step = NULL, card_dirty = 1, card_version = card_version + 1, next_send_at = 0, updated_at = ? WHERE id = ? AND state IN ('preparing', 'pending')")
      .run(state, error, Date.now(), id);
    return changes > 0;
  }

  /**
   * The user's decision. True only for the call that moved it out of 'pending': a second tap, a repeated update id
   * or a decision on a review that was superseded or expired meanwhile changes nothing.
   */
  decide(id: number, to: "approved" | "rejected" | "redo", d: Decision): boolean {
    try {
      const { changes } = this.db
        .prepare(`UPDATE reviews SET state = ?, step = NULL, decided_at = ?, decided_via = ?, decided_by = ?, decision_update_id = ?,
                  reason = ?, note = ?, at_sec = ?, card_dirty = 1, card_version = card_version + 1, next_send_at = 0, updated_at = ? WHERE id = ? AND state = 'pending'`)
        .run(to, Date.now(), d.via, d.by ?? null, d.updateId ?? null, d.reason ?? null, d.note ?? null, d.atSec ?? null, Date.now(), id);
      return changes > 0;
    } catch (err) {
      // The same Telegram update already decided a review.
      if (/UNIQUE/.test((err as Error).message)) return false;
      throw err;
    }
  }

  /** An approved review whose post couldn't be made: it stays approved (the user did approve), with the reason. */
  approvedButFailed(id: number, error: string) {
    this.db.prepare("UPDATE reviews SET state = 'failed', error = ?, card_dirty = 1, card_version = card_version + 1, next_send_at = 0, updated_at = ? WHERE id = ? AND state = 'approved' AND post_id IS NULL").run(error, Date.now(), id);
  }

  setPost(id: number, postId: number) {
    this.db.prepare("UPDATE reviews SET post_id = ?, card_dirty = 1, card_version = card_version + 1, next_send_at = 0, updated_at = ? WHERE id = ?").run(postId, Date.now(), id);
  }

  setStep(id: number, step: ReviewStep | null, reason: Reason | null = null): boolean {
    const { changes } = this.db
      .prepare("UPDATE reviews SET step = ?, reason = ?, prompt_message_id = CASE WHEN ? IS NULL THEN NULL ELSE prompt_message_id END, updated_at = ? WHERE id = ? AND state = 'pending'")
      .run(step, reason, step, Date.now(), id);
    return changes > 0;
  }

  setPrompt(id: number, messageId: number) {
    this.db.prepare("UPDATE reviews SET prompt_message_id = ? WHERE id = ?").run(messageId, id);
  }

  /** The pending review waiting for a redo note sent as a reply to this message. */
  byPrompt(chatId: number, messageId: number): Review | undefined {
    const r = this.db.prepare("SELECT * FROM reviews WHERE chat_id = ? AND prompt_message_id = ? AND state = 'pending' AND step = 'redo_note'").get(chatId, messageId);
    return r ? toReview(r) : undefined;
  }

  // ---- the Telegram card ----

  /** Reviews whose card must be sent, or brought up to date with the review's state. */
  dueCards(now: number): Review[] {
    return this.db
      .prepare(`SELECT * FROM reviews WHERE next_send_at <= ? AND send_attempts < 8 AND (
                  (state = 'pending' AND card_message_id IS NULL) OR (card_message_id IS NOT NULL AND card_dirty = 1)) ORDER BY id`)
      .all(now)
      .map(toReview);
  }

  /** A fresh nonce's hash for the buttons about to be sent; the previous card's buttons stop working. */
  setNonce(id: number, nonceHash: string) {
    this.db.prepare("UPDATE reviews SET nonce_hash = ? WHERE id = ?").run(nonceHash, id);
  }

  /** The card is up. If the review changed while it was uploading, it stays dirty and the next sync edits it. */
  cardSent(id: number, chatId: number, messageId: number, version: number) {
    this.db
      .prepare("UPDATE reviews SET chat_id = ?, card_message_id = ?, card_dirty = CASE WHEN card_version = ? THEN 0 ELSE 1 END, send_attempts = 0, send_error = NULL WHERE id = ?")
      .run(chatId, messageId, version, id);
  }

  cardSynced(id: number, version: number) {
    // Only when nothing changed since the sync began; otherwise it goes again.
    this.db.prepare("UPDATE reviews SET card_dirty = 0, send_attempts = 0, send_error = NULL WHERE id = ? AND card_version = ?").run(id, version);
  }

  markDirty(id: number) {
    this.db.prepare("UPDATE reviews SET card_dirty = 1, card_version = card_version + 1, next_send_at = 0 WHERE id = ?").run(id);
  }

  sendFailed(id: number, error: string, nextAt: number) {
    this.db.prepare("UPDATE reviews SET send_attempts = send_attempts + 1, send_error = ?, next_send_at = ? WHERE id = ?").run(error, nextAt, id);
  }
}
