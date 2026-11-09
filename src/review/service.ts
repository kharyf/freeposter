// What a review does, whoever asks and wherever the user answers: an agent (or the window) asks for one, FreePoster
// makes the exact file and writes the caption, the user decides on Telegram or in the window, and only an approval
// makes a post: of that file, which the runner uploads only while it still has the approved hash.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { captionVideo, transcriptText, type CaptionDeps } from "../caption.ts";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { sourceTime, type Segment } from "../edit/cuts.ts";
import type { EditSettings } from "../edit/settings.ts";
import type { Transcript, Word } from "../edit/transcribe.ts";
import { queueEvent, type EventType } from "../notify.ts";
import type { Publisher } from "../platforms/base.ts";
import { captionTopicFor, checkDraft, DuplicateError, type Draft } from "../posts.ts";
import type { ProductionStore } from "../produce/store.ts";
import type { Account, Platform, TikTokOptions } from "../types.ts";
import { hashFile, makeMaster, makeViewCopy } from "./media.ts";
import { OPEN_STATES, ReviewStore, type Decision, type Reason, type Review, type ReviewDraft } from "./store.ts";

export const DEFAULT_EXPIRY_HOURS = 72;
const MIN_LIFETIME_MS = 15 * 60_000;

/** A file's `name` is the user's own file name (the path is FreePoster's copy): a blank caption is written about it. */
export type Subject = { kind: "edit"; id: number } | { kind: "production"; id: number } | { kind: "file"; path: string; name?: string };

export interface ReviewRequest {
  subject: Subject;
  accountIds: number[];
  caption: string;
  title: string;
  scheduledAt: number | null;
  tiktok: TikTokOptions | null;
  allowDuplicate: boolean;
  via: "agent" | "window" | "drive";
  expiresInHours?: number;
  /** false: approving after the scheduled time still posts (at once). Drive videos wait for the user like this. */
  expireAtSchedule?: boolean;
}

export interface Prepared {
  masterPath: string;
  masterSha256: string;
  viewPath: string;
  durationSec: number;
}

export interface ReviewDeps {
  publishers: Record<Platform, Publisher>;
  runner: { tick(): unknown };
  productions?: () => ProductionStore | undefined;
  /** data/reviews */
  dir?: string;
  /** makes the master and the viewing copy (ffmpeg; a stand-in in tests) */
  prepare?: (source: string, key: string, dir: string) => Promise<Prepared>;
  /** the master's speech, for a caption left blank */
  transcribe?: (path: string, sha256: string) => Promise<Transcript>;
  caption?: CaptionDeps;
}

/** What a decision call reports, for the Telegram toast and the window. */
export interface Outcome {
  ok: boolean;
  message: string;
  review?: Review;
}

const log = (id: number, msg: string) => console.log(`[review ${id}] ${msg}`);

async function realPrepare(source: string, key: string, dir: string): Promise<Prepared> {
  const master = await makeMaster(source, key, dir);
  const viewPath = await makeViewCopy(master.path, master.durationSec, join(dir, `view-${key}.mp4`));
  return { masterPath: master.path, masterSha256: master.sha256, viewPath, durationSec: master.durationSec };
}

/** "0:14", "1:02.5", "14s", "at 14 seconds" → seconds; null when the note names no time. */
export function parseTime(note: string): number | null {
  const clock = /(\d{1,2}):(\d{2}(?:\.\d+)?)/.exec(note);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const secs = /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i.exec(note);
  return secs ? Number(secs[1]) : null;
}

/** For a redo of an edit: the one setting a reason most likely means, when it means one. */
export const SUGGESTED: Partial<Record<Reason, Partial<EditSettings>>> = {
  zooms: { punchIn: false },
  framing: { reframe: false },
  sound: { audio: false },
};

export class ReviewService {
  store: Store;
  reviews: ReviewStore;
  deps: ReviewDeps;
  dir: string;
  /** reviews being prepared in this process, and the work under way */
  busy = new Map<number, Promise<void>>();
  /** called whenever a review's card needs sending or updating (the Telegram side pokes its sync) */
  onChange: () => void = () => {};
  /**
   * Given a redo just decided, carries it out when FreePoster can by itself (Drive intake does, for its own edits)
   * and says what it did; null leaves it to the agent, which the redo event asks to make the change.
   */
  autoRedo: (r: Review) => string | null = () => null;
  timer: NodeJS.Timeout | undefined;

  constructor(store: Store, deps: ReviewDeps) {
    this.store = store;
    this.reviews = new ReviewStore(store);
    this.deps = deps;
    this.dir = deps.dir ?? join(dataDir, "reviews");
    mkdirSync(this.dir, { recursive: true });
  }

  start(intervalMs = 3_000) {
    const tick = () => {
      void this.tick().catch((err) => console.error(`reviews: ${(err as Error).message}`));
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  get productions() {
    return this.deps.productions?.();
  }

  private event(r: Review, type: EventType, summary: string, extra: Record<string, unknown> = {}) {
    queueEvent(this.store, type, `${type}:${r.id}`, { review_id: r.id, subject: this.subjectView(r), ...extra }, summary);
  }

  subjectView(r: Review) {
    return { kind: r.subjectKind, id: r.subjectId, revision: r.revision };
  }

  private label(r: Review) {
    if (r.subjectKind === "production") {
      const title = this.productions?.get(r.subjectId!)?.spec.title;
      return `Production ${r.subjectId}${title ? ` (${title})` : ""}`;
    }
    return r.subjectKind === "edit" ? `Edit ${r.subjectId}` : "The video";
  }

  // ---- asking ----

  /** Checks what can be checked now and queues the review; preparing it (the exact file, the caption) happens in tick(). */
  async request(q: ReviewRequest): Promise<Review> {
    let source: string;
    let subjectId: number | null = null;
    let revision = 1;
    let topicName = "";
    if (q.subject.kind === "edit") {
      const edit = this.store.edit(q.subject.id);
      if (!edit) throw new Error(`no edit ${q.subject.id}`);
      if (edit.state !== "ready" || !edit.outputPath) throw new Error(`edit ${edit.id} is ${edit.state}; only a ready edit can be reviewed`);
      source = edit.outputPath;
      subjectId = edit.id;
    } else if (q.subject.kind === "production") {
      const p = this.productions?.get(q.subject.id);
      if (!p) throw new Error(`no production ${q.subject.id}`);
      if (p.state !== "ready" || !p.outputPath) throw new Error(`production ${p.id} is ${p.state}; only a ready production can be reviewed`);
      source = p.outputPath;
      subjectId = p.id;
      revision = p.revision;
      topicName = p.spec.title ?? "";
    } else {
      source = q.subject.path;
      topicName = q.subject.name ?? source;
    }
    const captionTopic = captionTopicFor(q.caption, q.title, topicName);
    // Everything but the duplicate check, which needs the exact file's hash (it runs when the file is made).
    await checkDraft(this.store, this.deps.publishers, {
      sourcePath: source, sha256: "", caption: q.caption, title: q.title, accountIds: q.accountIds, tiktok: q.tiktok,
      scheduledAt: q.scheduledAt, captionTopic,
    }, true);

    const now = Date.now();
    const hours = Math.min(Math.max(q.expiresInHours ?? DEFAULT_EXPIRY_HOURS, 0.25), 24 * 14);
    let expiresAt = now + hours * 3_600_000;
    // A scheduled post's review ends when it was due to go out (approving later posts it at once).
    if (q.scheduledAt && q.expireAtSchedule !== false) expiresAt = Math.max(Math.min(expiresAt, q.scheduledAt), now + MIN_LIFETIME_MS);
    const draft: ReviewDraft = {
      accountIds: q.accountIds, caption: q.caption, title: q.title, scheduledAt: q.scheduledAt, tiktok: q.tiktok,
      allowDuplicate: q.allowDuplicate, captionTopic,
    };
    const { review, superseded } = this.reviews.create({ subjectKind: q.subject.kind, subjectId, revision, sourcePath: source, draft, expiresAt, requestedVia: q.via });
    for (const id of superseded) log(id, `replaced by review ${review.id}`);
    log(review.id, `requested by ${q.via === "drive" ? "Drive intake" : `the ${q.via}`} for ${this.label(review).toLowerCase()}`);
    this.onChange();
    void this.tick().catch((err) => console.error(`reviews: ${(err as Error).message}`));
    return review;
  }

  // ---- the background work ----

  async tick() {
    this.resumeApproved();
    this.sweep();
    // Each review is prepared once at a time; a tick also waits for preparations already under way.
    await Promise.all(this.reviews.inState("preparing").map((r) => this.busy.get(r.id) ?? this.prepare(r)));
  }

  /** Whether the review is still about the current version of its subject. */
  current(r: Review): string | null {
    if (r.subjectKind === "edit") {
      const e = this.store.edit(r.subjectId!);
      if (!e) return "the edit was deleted";
      if (e.state !== "ready") return `the edit is ${e.state} now`;
    } else if (r.subjectKind === "production") {
      const p = this.productions?.get(r.subjectId!);
      if (!p) return "the production was deleted";
      if (p.revision !== r.revision) return `production ${p.id} has a newer version (revision ${p.revision})`;
      if (p.state !== "ready") return `production ${p.id} is ${p.state} now`;
    }
    return null;
  }

  /** Open reviews that ran out of time, or whose subject moved on. */
  sweep() {
    const now = Date.now();
    for (const r of this.reviews.inState(...OPEN_STATES)) {
      if (r.state === "pending" && r.expiresAt <= now) {
        if (this.reviews.close(r.id, "expired")) {
          log(r.id, "expired");
          this.event(r, "review.expired", `Review ${r.id} of ${this.label(r).toLowerCase()} expired without a decision; ask for a new one if it should still go out.`);
          this.onChange();
        }
        continue;
      }
      const stale = this.current(r);
      if (stale && this.reviews.close(r.id, "superseded", stale)) {
        log(r.id, `superseded: ${stale}`);
        this.onChange();
      }
    }
  }

  /** Makes the exact file, writes a blank caption, and checks the post again; then it waits for the user. */
  prepare(r: Review): Promise<void> {
    const work = this.doPrepare(r).finally(() => this.busy.delete(r.id));
    this.busy.set(r.id, work);
    return work;
  }

  private async doPrepare(r: Review) {
    try {
      const stale = this.current(r);
      if (stale) { this.reviews.close(r.id, "superseded", stale); return; }
      const key = `${r.subjectKind}-${r.subjectId ?? `r${r.id}`}-r${r.revision}`;
      log(r.id, "making the exact file");
      const made = await (this.deps.prepare ?? realPrepare)(r.sourcePath, key, this.dir);
      const draft = { ...r.draft };
      if (draft.captionTopic) {
        const accounts = draft.accountIds.map((id) => this.store.account(id)).filter((a): a is Account => Boolean(a));
        const transcript = this.deps.transcribe
          ? await this.deps.transcribe(made.masterPath, made.masterSha256).catch(() => ({ words: [], language: null }) as Transcript)
          : { words: [], language: null };
        const text = this.deps.caption
          ? await captionVideo({ topic: draft.captionTopic, transcript: transcriptText(transcript), sourcePath: made.masterPath, accounts }, this.deps.caption, (m) => log(r.id, m))
          : { caption: "#fyp", title: draft.title || draft.captionTopic };
        draft.caption = text.caption;
        if (!draft.title.trim()) draft.title = text.title;
        draft.captionTopic = null;
      }
      await checkDraft(this.store, this.deps.publishers, this.postDraft({ ...r, draft }, made.masterPath, made.masterSha256), draft.allowDuplicate);
      if (!this.reviews.prepared(r.id, { ...made, draft })) return; // closed meanwhile
      log(r.id, "waiting for the user");
      this.event(r, "review.waiting", `${this.label(r)} is waiting for the user's decision (review ${r.id}). Don't ask them to approve in chat: they decide on the review itself.`,
        { duration_sec: made.durationSec, master_sha256: made.masterSha256 });
      this.onChange();
    } catch (err) {
      const message = err instanceof DuplicateError ? `${err.message} (ask again with allow_duplicate if the user wants it posted again)` : (err as Error).message;
      log(r.id, `couldn't be prepared: ${message}`);
      if (this.reviews.close(r.id, "failed", message)) {
        this.event(r, "review.failed", `Review ${r.id} of ${this.label(r).toLowerCase()} couldn't be prepared: ${message}`, { error: message });
        this.onChange();
      }
    }
  }

  /** The post the review covers, as checkDraft and createPost take it. */
  postDraft(r: Pick<Review, "draft">, masterPath: string, masterSha256: string): Draft {
    return {
      sourcePath: masterPath, sha256: masterSha256, caption: r.draft.caption, title: r.draft.title, accountIds: r.draft.accountIds,
      tiktok: r.draft.tiktok, scheduledAt: r.draft.scheduledAt, editId: null, requireEdit: false, captionTopic: null,
    };
  }

  // ---- deciding ----

  /** Why a pending review can't be decided any more (and closes it), or null when it can. */
  private async stillDecidable(r: Review): Promise<string | null> {
    if (r.expiresAt <= Date.now()) {
      if (this.reviews.close(r.id, "expired")) {
        this.event(r, "review.expired", `Review ${r.id} of ${this.label(r).toLowerCase()} expired without a decision.`);
        this.onChange();
      }
      return "This review expired. Ask for it again.";
    }
    const stale = this.current(r);
    if (stale) {
      if (this.reviews.close(r.id, "superseded", stale)) this.onChange();
      return `There's a newer version: ${stale}.`;
    }
    return null;
  }

  private settled(r: Review | undefined): Outcome {
    if (!r) return { ok: false, message: "No such review." };
    const said: Record<string, string> = {
      preparing: "This review isn't ready yet.",
      approved: "Already approved.",
      rejected: "Already rejected.",
      redo: "Already sent back for a redo.",
      superseded: "There's a newer version of this video.",
      expired: "This review expired.",
      failed: `This review failed${r.error ? `: ${r.error}` : ""}.`,
    };
    return { ok: false, message: said[r.state] ?? "Already decided.", review: r };
  }

  async approve(id: number, d: Decision): Promise<Outcome> {
    const r = this.reviews.get(id);
    if (!r || r.state !== "pending") return this.settled(r);
    const refused = await this.stillDecidable(r);
    if (refused) return { ok: false, message: refused, review: this.reviews.get(id) };
    // The file must still be the one that was shown.
    const sha = r.masterPath && existsSync(r.masterPath) ? await hashFile(r.masterPath) : null;
    if (!sha || sha !== r.masterSha256) {
      const why = "the approved file changed or is gone";
      if (this.reviews.close(r.id, "failed", why)) {
        this.event(r, "review.failed", `Review ${r.id} can't be approved: ${why}. Ask for a new review.`, { error: why });
        this.onChange();
      }
      return { ok: false, message: "The file changed since it was sent. Ask for it again.", review: this.reviews.get(id) };
    }
    // An account may have been disconnected, or a rule changed, since it was sent.
    try {
      await checkDraft(this.store, this.deps.publishers, this.postDraft(r, r.masterPath!, sha), r.draft.allowDuplicate);
    } catch (err) {
      const why = (err as Error).message;
      if (this.reviews.close(r.id, "failed", why)) {
        this.event(r, "review.failed", `Review ${r.id} can't be posted any more: ${why}`, { error: why });
        this.onChange();
      }
      return { ok: false, message: `It can't be posted: ${why}`, review: this.reviews.get(id) };
    }
    if (!this.reviews.decide(r.id, "approved", d)) return this.settled(this.reviews.get(id));
    log(r.id, `approved (${d.via})`);
    const postId = this.makePost(this.reviews.get(id)!);
    this.onChange();
    return { ok: postId !== null, message: postId !== null ? `Approved. Post ${postId} is going out.` : "Approved, but the post couldn't be made.", review: this.reviews.get(id) };
  }

  /** The approved review's post, made once: a crash between the approval and here is finished by tick(). */
  makePost(r: Review): number | null {
    try {
      const existing = this.store.db.prepare("SELECT id FROM posts WHERE review_id = ?").get(r.id) as { id: number } | undefined;
      const postId = existing?.id ?? this.store.createPost({
        ...this.postDraft(r, r.masterPath!, r.masterSha256!), reviewId: r.id, approvedSha256: r.masterSha256, origin: "review",
      }, r.draft.accountIds);
      this.reviews.setPost(r.id, postId);
      if (r.subjectKind === "edit") this.store.approveEdit(r.subjectId!);
      if (r.subjectKind === "production") this.productions?.approve(r.subjectId!, postId);
      this.deps.runner.tick();
      this.event(r, "review.approved", `The user approved ${this.label(r).toLowerCase()} (review ${r.id}); post ${postId} is going out. get_post follows it.`, { post_id: postId });
      return postId;
    } catch (err) {
      const why = (err as Error).message;
      log(r.id, `approved, but the post failed: ${why}`);
      this.reviews.approvedButFailed(r.id, why);
      this.event(r, "review.failed", `Review ${r.id} was approved but its post couldn't be made: ${why}`, { error: why });
      return null;
    }
  }

  private resumeApproved() {
    for (const r of this.reviews.inState("approved")) if (r.postId === null) this.makePost(r);
  }

  async reject(id: number, d: Decision): Promise<Outcome> {
    const r = this.reviews.get(id);
    if (!r || r.state !== "pending") return this.settled(r);
    const refused = await this.stillDecidable(r);
    if (refused) return { ok: false, message: refused, review: this.reviews.get(id) };
    if (!this.reviews.decide(r.id, "rejected", d)) return this.settled(this.reviews.get(id));
    if (r.subjectKind === "edit") this.store.closeEdit(r.subjectId!, "rejected");
    if (r.subjectKind === "production") this.productions?.reject(r.subjectId!, r.revision);
    log(r.id, `rejected (${d.via}${d.reason ? `, ${d.reason}` : ""})`);
    const why = [d.reason && d.reason !== "none" ? d.reason : "", d.note ?? ""].filter(Boolean).join(": ");
    this.event(r, "review.rejected", `The user rejected ${this.label(r).toLowerCase()} (review ${r.id})${why ? ` (${why})` : ""}. Nothing was posted.`,
      { reason: d.reason ?? null, note: d.note ?? null });
    this.onChange();
    return { ok: true, message: "Rejected. Nothing was posted.", review: this.reviews.get(id) };
  }

  async redo(id: number, d: Decision): Promise<Outcome> {
    const r = this.reviews.get(id);
    if (!r || r.state !== "pending") return this.settled(r);
    const refused = await this.stillDecidable(r);
    if (refused) return { ok: false, message: refused, review: this.reviews.get(id) };
    const atSec = d.atSec ?? (d.note ? parseTime(d.note) : null);
    if (!this.reviews.decide(r.id, "redo", { ...d, atSec })) return this.settled(this.reviews.get(id));
    const decided = this.reviews.get(id)!;
    const context = this.redoContext(decided);
    log(r.id, `redo asked (${d.via}${d.reason ? `, ${d.reason}` : ""})`);
    let done: string | null = null;
    try {
      done = this.autoRedo(decided);
    } catch (err) {
      log(r.id, `couldn't redo it automatically: ${(err as Error).message}`);
    }
    const asked = `The user wants ${this.label(r).toLowerCase()} redone (review ${r.id})${d.reason ? `: ${d.reason}` : ""}${d.note ? `. Note: "${d.note}"` : ""}.`;
    if (done) {
      log(r.id, done);
      this.event(decided, "review.redo", `${asked} FreePoster is redoing it itself (${done}); the new version comes back to them for review. Nothing for you to do.`,
        { reason: d.reason ?? null, note: d.note ?? null, at_sec: atSec, context, handled_by: "freeposter" });
    } else {
      const tool = r.subjectKind === "edit" ? "revise_edit" : r.subjectKind === "production" ? "revise_production" : "a new edit or production";
      const next = r.requestedVia === "drive"
        ? "the new edit goes back to them for review by itself (it's a Drive video), so don't call request_review"
        : "the new version comes back for review";
      this.event(decided, "review.redo", `${asked} Call get_review, make the change with ${tool}, and tell them what you changed; ${next}.`,
        { reason: d.reason ?? null, note: d.note ?? null, at_sec: atSec, context, handled_by: "agent" });
    }
    this.onChange();
    return { ok: true, message: done ? `Sent back for a redo: ${done}. The new version will come to you for review.` : "Sent back for a redo. The new version will come to you for review.", review: decided };
  }

  // ---- what an agent needs to act on a redo ----

  redoContext(r: Review): Record<string, unknown> | null {
    const at = r.atSec;
    if (r.subjectKind === "edit") {
      const edit = this.store.edit(r.subjectId!);
      if (!edit) return null;
      const out: Record<string, unknown> = { edit_id: edit.id, settings: edit.settings };
      if (r.reason && SUGGESTED[r.reason]) out.suggested_settings = SUGGESTED[r.reason];
      if (at !== null && edit.cutsPath && existsSync(edit.cutsPath)) {
        const segs = JSON.parse(readFileSync(edit.cutsPath, "utf8")) as Segment[];
        const src = sourceTime(segs, at);
        out.source_sec = src === null ? null : Math.round(src * 100) / 100;
        if (src !== null) {
          const words = this.wordsNear(edit.transcriptPath, src);
          if (words) out.words_near = words;
          out.hint = "keep / drop ranges and captionFixes are in source seconds; use source_sec";
        }
      }
      return out;
    }
    if (r.subjectKind === "production") {
      const ps = this.productions;
      const p = ps?.get(r.subjectId!);
      if (!p || !ps) return null;
      const out: Record<string, unknown> = { production_id: p.id, revision: r.revision };
      if (at !== null) {
        const shots = ps.shots(p.id, r.revision);
        let start = 0;
        for (const [i, s] of shots.entries()) {
          const spec = p.spec.shots[i];
          const next = p.spec.shots[i + 1];
          const t = (spec && next && p.spec.transitions[`${spec.id}->${next.id}`]) || p.spec.transitions.default;
          const len = s.durationSec ?? 0;
          if (at < start + len || i === shots.length - 1) {
            out.shot = { id: s.shotId, kind: s.kind, starts_at_sec: Math.round(start * 100) / 100, spec };
            break;
          }
          start += len - (t?.type === "crossfade" ? t.sec : 0);
        }
      }
      return out;
    }
    return null;
  }

  /** The words said around a source time; the speech-only transcript (no lyrics or sound tags) when there is one. */
  private wordsNear(transcriptPath: string | null, at: number): string | null {
    const spoken = transcriptPath?.replace(/\.words\.json$/, ".spoken.json");
    const path = spoken && existsSync(spoken) ? spoken : transcriptPath;
    if (!path || !existsSync(path)) return null;
    try {
      const words = (JSON.parse(readFileSync(path, "utf8")) as Transcript).words.filter((w: Word) => w.end >= at - 2 && w.start <= at + 2);
      return words.map((w) => w.text).join(" ") || null;
    } catch {
      return null;
    }
  }

  // ---- what agents and the window see ----

  view(r: Review) {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      id: r.id,
      state: r.state,
      waiting_for: r.state === "pending" ? (r.step === "redo_note" ? "the user's redo note" : "the user's decision") : null,
      subject: this.subjectView(r),
      label: this.label(r),
      accounts: r.draft.accountIds.map((id) => {
        const a = this.store.account(id);
        return { id, platform: a?.platform ?? null, name: a?.name ?? "(disconnected)" };
      }),
      caption: r.draft.captionTopic ? null : r.draft.caption,
      caption_pending: Boolean(r.draft.captionTopic),
      title: r.draft.title,
      schedule_at: iso(r.draft.scheduledAt),
      duration_sec: r.durationSec,
      master_sha256: r.masterSha256,
      expires_at: iso(r.expiresAt),
      requested_via: r.requestedVia,
      sent_to_telegram: r.cardMessageId !== null,
      decided_at: iso(r.decidedAt),
      decided_via: r.decidedVia,
      reason: r.reason,
      note: r.note,
      at_sec: r.atSec,
      redo: r.state === "redo" ? this.redoContext(r) : null,
      post_id: r.postId,
      error: r.error,
      created_at: iso(r.createdAt),
    };
  }

  // ---- the audit: did what posted match what was approved? ----

  audit() {
    type Problem = { post_id: number; job_id?: number; problem: string };
    const problems: Problem[] = [];
    const rows = this.store.db.prepare("SELECT DISTINCT post_id FROM jobs WHERE state = 'published' ORDER BY post_id").all() as { post_id: number }[];
    const counts = { review: 0, window: 0, drive: 0, legacy: 0 };
    for (const { post_id } of rows) {
      const post = this.store.post(post_id);
      if (!post) continue;
      const origin = (post.origin ?? "legacy") as keyof typeof counts;
      counts[origin] = (counts[origin] ?? 0) + 1;
      const published = this.store.jobsForPost(post_id).filter((j) => j.state === "published");
      if (origin !== "review") {
        for (const j of published) if (!j.uploadedSha256 && origin !== "legacy") problems.push({ post_id, job_id: j.id, problem: "the upload's hash wasn't recorded" });
        continue;
      }
      const r = this.reviews.forPost(post_id);
      if (!r) { problems.push({ post_id, problem: "made by a review that doesn't exist" }); continue; }
      if (!r.decidedAt || r.decidedAt > post.createdAt) problems.push({ post_id, problem: `review ${r.id} wasn't decided before the post was made` });
      if (!r.decidedVia) problems.push({ post_id, problem: `review ${r.id} doesn't say where it was approved` });
      if (r.masterSha256 !== post.approvedSha256) problems.push({ post_id, problem: `review ${r.id} approved a different file than the post names` });
      for (const j of published) {
        if (!j.uploadedSha256) problems.push({ post_id, job_id: j.id, problem: "the upload's hash wasn't recorded" });
        else if (j.uploadedSha256 !== post.approvedSha256) problems.push({ post_id, job_id: j.id, problem: `uploaded ${j.uploadedSha256.slice(0, 16)}…, approved ${post.approvedSha256?.slice(0, 16)}…` });
      }
    }
    return {
      ok: problems.length === 0,
      published_posts: rows.length,
      by_origin: counts,
      problems,
      note: "Posts from the window and Drive weren't reviewed by design; legacy posts were made before uploads were recorded.",
    };
  }
}
