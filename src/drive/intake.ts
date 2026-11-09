// What happens to a video dropped in the watched Drive folder: read the posting time from its name (or its upload day),
// download it, transcribe it, edit it while the AI providers write its title and caption, then send the edit to the
// user for review (on Telegram, through Hermes's bot or FreePoster's own, and in the window). Approve schedules it to
// FreePoster's default accounts at the time in its name (at once if that has passed); Reject posts nothing; Redo
// makes a new edit (FreePoster does it when the reason is one setting and there's no note, Hermes otherwise, with
// revise_edit) and the new edit comes back for review. A name ending in _RAW was already edited elsewhere: it
// skips the edit and the review, and posts as uploaded (still transcribed for its caption). A video with no speech
// is captioned from its frames, and when that (or the AI) fails it gets the caption #fyp. Every step is saved, so a
// restart picks up where it stopped.
import type { Readable } from "node:stream";
import { defaultAccounts, defaultTikTok } from "../accounts.ts";
import { captionVideo, transcriptText, type CaptionDeps } from "../caption.ts";
import type { Store } from "../db.ts";
import { DEFAULT_EDIT } from "../edit/settings.ts";
import type { Transcript } from "../edit/transcribe.ts";
import { probe } from "../media.ts";
import type { Publisher } from "../platforms/base.ts";
import { saveUpload } from "../posts.ts";
import { SUGGESTED, type ReviewService } from "../review/service.ts";
import type { Review } from "../review/store.ts";
import type { Account, DriveFileRecord, Platform } from "../types.ts";
import { uploadedAt, type DriveFile } from "./client.ts";
import { parseDriveName } from "./filename.ts";

export interface IntakeDeps extends CaptionDeps {
  download: (driveId: string) => Promise<Readable>;
  /** shared with the edit, so each video is transcribed once */
  transcribe: (sourcePath: string, sha256: string) => Promise<Transcript>;
  /** where an edit waits for the user's decision before anything posts */
  reviews: ReviewService;
  now?: () => number;
}

/** "punch-in zooms off" for the settings change a redo makes. */
const SETTING_NAMES: Record<string, string> = { punchIn: "punch-in zooms", reframe: "speaker framing", audio: "sound clean-up", tighten: "tightening", captions: "captions" };
const describeChange = (change: Record<string, unknown>) =>
  Object.entries(change).map(([k, v]) => `${SETTING_NAMES[k] ?? k} ${v ? "on" : "off"}`).join(", ");

const GRACE_MS = 30 * 60_000;
const YEAR_MS = 365 * 86_400_000;
const DOWNLOAD_RETRY_MS = 5 * 60_000;

const log = (f: Pick<DriveFileRecord, "name">, msg: string) => console.log(`[drive ${f.name}] ${msg}`);

export class Intake {
  store: Store;
  publishers: Record<Platform, Publisher>;
  deps: IntakeDeps;
  now: () => number;
  /** files being worked on in this process, so overlapping calls don't repeat a step */
  busy = new Set<string>();

  constructor(store: Store, publishers: Record<Platform, Publisher>, deps: IntakeDeps) {
    this.store = store;
    this.publishers = publishers;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    deps.reviews.autoRedo = (r) => this.applyRedo(r);
  }

  /** A new file from the watcher (already recorded as "queued"). */
  async handle(f: DriveFile) {
    if (!this.store.driveFile(f.id)) this.store.upsertDriveFile(f.id, { name: f.name, state: "queued", size: f.size, uploadedAt: uploadedAt(f) });
    await this.advance(f.id);
  }

  /** After a restart: carry on with every file that was part-way through. */
  async resume() {
    // Older versions held files without a caption for the user to write one; caption them now instead.
    for (const f of this.store.driveFilesIn(["needs_caption"])) this.store.upsertDriveFile(f.driveId, { state: "processing", caption: null, title: null, note: null });
    const open = this.store.driveFilesIn(["queued", "downloading", "transcribing"]);
    // A caption that was being written when FreePoster stopped is written again.
    const uncaptioned = this.store.driveFilesIn(["processing"]).filter((f) => f.caption === null);
    await Promise.all([...open, ...uncaptioned].map((f) => this.advance(f.driveId)));
  }

  /**
   * Runs every few seconds: sends files whose edit and caption are ready for review, follows reviews to their
   * decision, posts _RAW files once captioned, and retries failed downloads.
   */
  async tick() {
    for (const f of this.store.driveFilesIn(["downloading"])) {
      if (!this.busy.has(f.driveId) && this.now() - f.updatedAt > DOWNLOAD_RETRY_MS) void this.advance(f.driveId);
    }
    for (const f of this.store.driveFilesIn(["processing"])) {
      if (this.busy.has(f.driveId)) continue;
      if (this.isRaw(f)) {
        if (f.caption !== null) await this.schedule(f);
        continue;
      }
      const edit = f.editId ? this.store.edit(this.follow(f)) : undefined;
      if (!edit || edit.state === "failed") {
        this.store.upsertDriveFile(f.driveId, { state: "edit_failed", note: `the edit failed: ${edit?.error ?? "it is missing"}` });
        continue;
      }
      if (f.caption !== null && edit.state === "ready") await this.requestReview(this.store.driveFile(f.driveId)!);
    }
    for (const f of this.store.driveFilesIn(["reviewing"])) {
      if (!this.busy.has(f.driveId)) this.followReview(f);
    }
  }

  /** The file's edit, moved on to its newest revision (revise_edit, after a redo); returns its id. */
  private follow(f: DriveFileRecord): number {
    const latest = this.store.latestRevision(f.editId!);
    if (latest !== f.editId) this.store.upsertDriveFile(f.driveId, { editId: latest });
    return latest;
  }

  /** "Send for review again": a new review of the same edit, after the last one expired or couldn't be made. */
  async reviewAgain(driveId: string) {
    const f = this.store.driveFile(driveId);
    if (!f || f.state !== "unreviewed") return;
    this.store.upsertDriveFile(driveId, { state: "processing", reviewId: null, note: null });
    await this.tick();
  }

  /** Where the file's review got to: the post it made, a rejection, a redo, or a review that ended undecided. */
  private followReview(f: DriveFileRecord) {
    const r = f.reviewId === null ? undefined : this.deps.reviews.reviews.get(f.reviewId);
    if (!r) {
      this.store.upsertDriveFile(f.driveId, { state: "processing", reviewId: null });
      return;
    }
    switch (r.state) {
      case "preparing":
      case "pending":
        return;
      case "approved": {
        if (r.postId === null) return; // the review service finishes making the post
        // A name with no time is on time until its day ends.
        const parsed = this.parse(f);
        const latest = parsed.ok ? parsed.latest : f.scheduledAt;
        const late = latest !== null && r.decidedAt !== null && r.decidedAt - latest > 60_000;
        const note = [late ? "approved after its scheduled time; posted at once" : "", f.note ?? ""].filter(Boolean).join("; ") || null;
        this.store.linkDrivePost(f.driveId, r.postId, note);
        log(f, `approved; post ${r.postId}`);
        return;
      }
      case "rejected": {
        const why = [r.reason && r.reason !== "none" ? r.reason : "", r.note ?? ""].filter(Boolean).join(": ");
        this.store.upsertDriveFile(f.driveId, { state: "rejected", note: `you rejected it${why ? ` (${why})` : ""}; nothing was posted` });
        log(f, "rejected");
        return;
      }
      case "redo":
      case "superseded": {
        // A redo (or a revise_edit on its own) makes a newer edit: wait for that one, then review it.
        const latest = f.editId === null ? null : this.store.latestRevision(f.editId);
        if (latest !== null && latest !== f.editId) {
          this.store.upsertDriveFile(f.driveId, { state: "processing", editId: latest, reviewId: null, note: `redoing it (edit ${latest}); it comes back for review` });
          return;
        }
        if (r.state === "superseded") {
          // Replaced by another review of the same edit (an agent asked as well): follow that one.
          const other = this.openReviewFor(f.editId);
          if (other) this.store.upsertDriveFile(f.driveId, { reviewId: other.id });
          else this.store.upsertDriveFile(f.driveId, { state: "unreviewed", note: `its review was closed: ${r.error ?? "the edit changed"}` });
          return;
        }
        const waiting = "Waiting for Hermes to make the change you asked for";
        if (!f.note?.startsWith(waiting)) this.store.upsertDriveFile(f.driveId, { note: `${waiting}${r.note ? `: "${r.note}"` : ""}` });
        return;
      }
      case "expired":
      case "failed":
        this.store.upsertDriveFile(f.driveId, {
          state: "unreviewed",
          note: r.state === "expired" ? "its review ended without a decision; send it for review again" : `its review couldn't be made: ${r.error ?? "unknown error"}`,
        });
        return;
    }
  }

  private openReviewFor(editId: number | null): Review | undefined {
    if (editId === null) return undefined;
    return this.deps.reviews.reviews.inState("preparing", "pending").find((x) => x.subjectKind === "edit" && x.subjectId === editId);
  }

  /**
   * A redo of a Drive video's review. With no note and a reason that means one setting (zooms, framing, sound),
   * FreePoster makes the new edit itself; anything else is Hermes's to change (revise_edit, from the redo event),
   * and tick() picks up the edit it makes. Returns what FreePoster did, or null.
   */
  applyRedo(r: Review): string | null {
    if (r.subjectKind !== "edit") return null;
    const f = this.store.driveFileForReview(r.id);
    if (!f) return null;
    const edit = this.store.edit(r.subjectId!);
    const change = !r.note && r.reason ? SUGGESTED[r.reason] : undefined;
    if (!edit || !change) return null;
    const next = this.store.createEdit(edit.sourcePath, edit.sha256, { ...edit.settings, ...change }, edit.id);
    if (next.id === edit.id) return null; // already that way: Hermes decides what else to change
    this.store.closeEdit(edit.id, "superseded");
    const what = `${describeChange(change)}, edit ${next.id}`;
    this.store.upsertDriveFile(f.driveId, { state: "processing", editId: next.id, reviewId: null, note: `redoing it with ${what}; it comes back for review` });
    log(f, `redo: ${what}`);
    return what;
  }

  /** Makes a new edit after a failed one; the transcript is redone too if that was what failed. */
  async retryEdit(driveId: string) {
    const f = this.store.driveFile(driveId);
    if (!f || f.state !== "edit_failed") return;
    if (!f.sourcePath || !f.sha256) {
      this.store.upsertDriveFile(driveId, { state: "downloading", note: null });
    } else if (f.editId === null) {
      this.store.upsertDriveFile(driveId, { state: "transcribing", note: null });
    } else {
      // "processing" writes the caption too, if it was never written.
      const edit = this.store.createEdit(f.sourcePath, f.sha256, DEFAULT_EDIT);
      this.store.upsertDriveFile(driveId, { state: "processing", editId: edit.id, note: null });
    }
    await this.advance(driveId);
  }

  private async advance(driveId: string) {
    if (this.busy.has(driveId)) return;
    this.busy.add(driveId);
    try {
      for (;;) {
        const f = this.store.driveFile(driveId);
        if (!f) return;
        const next = await this.step(f);
        if (!next) return;
      }
    } finally {
      this.busy.delete(driveId);
    }
  }

  /** Does one step; true when there's another to do right away. */
  private async step(f: DriveFileRecord): Promise<boolean> {
    const id = f.driveId;
    switch (f.state) {
      case "queued": {
        const parsed = this.parse(f);
        if (!parsed.ok) {
          this.store.upsertDriveFile(id, { state: "invalid", note: parsed.reason });
          return false;
        }
        const now = this.now();
        if (parsed.latest < now - GRACE_MS) {
          const when = parsed.latest === parsed.at ? `its time (${new Date(parsed.at).toLocaleString()})` : `its date (${new Date(parsed.at).toLocaleDateString()})`;
          this.store.upsertDriveFile(id, { state: "late", scheduledAt: parsed.at, note: `${when} had already passed when it reached the folder` });
          return false;
        }
        if (parsed.at > now + YEAR_MS) {
          this.store.upsertDriveFile(id, { state: "invalid", scheduledAt: parsed.at, note: "posts can be scheduled up to a year ahead" });
          return false;
        }
        this.store.upsertDriveFile(id, { state: "downloading", scheduledAt: Math.max(parsed.at, now), note: null });
        return true;
      }
      case "downloading": {
        try {
          log(f, "downloading");
          const saved = await saveUpload(await this.deps.download(id), f.name);
          this.store.upsertDriveFile(id, { state: "transcribing", sourcePath: saved.path, sha256: saved.sha256, note: null });
          return true;
        } catch (err) {
          // Stays "downloading"; tick() tries again in a few minutes.
          this.store.upsertDriveFile(id, { note: `download failed, will try again: ${(err as Error).message}` });
          return false;
        }
      }
      case "transcribing": {
        let transcript: Transcript;
        try {
          log(f, "transcribing");
          transcript = await this.deps.transcribe(f.sourcePath!, f.sha256!);
        } catch (err) {
          // The edit needs the transcript; a _RAW video only wanted it for the caption, so it goes on without.
          if (!this.isRaw(f)) {
            this.store.upsertDriveFile(id, { state: "edit_failed", note: (err as Error).message });
            return false;
          }
          log(f, `transcription failed, captioning from frames: ${(err as Error).message}`);
          transcript = { words: [], language: null };
        }
        // The edit worker picks this up and runs alongside the caption writing below. A _RAW video gets no edit.
        const editId = this.isRaw(f) ? null : this.store.createEdit(f.sourcePath!, f.sha256!, DEFAULT_EDIT).id;
        this.store.upsertDriveFile(id, { state: "processing", editId });
        await this.caption(this.store.driveFile(id)!, transcript);
        return false;
      }
      case "processing":
        if (f.caption === null) await this.caption(f, await this.deps.transcribe(f.sourcePath!, f.sha256!).catch(() => ({ words: [], language: null })));
        return false;
      default:
        return false;
    }
  }

  /**
   * Always ends with a title and caption: from the speech, or from the frames when nobody speaks, or else the
   * fallback (#fyp), with a note saying why. The text can still be changed under Upcoming before it posts.
   */
  private async caption(f: DriveFileRecord, transcript: Transcript) {
    const parsed = this.parse(f);
    const text = await captionVideo(
      { topic: parsed.ok ? parsed.name : f.name, transcript: transcriptText(transcript), sourcePath: f.sourcePath!, accounts: this.accounts() },
      this.deps,
      (m) => log(f, m),
    );
    this.store.upsertDriveFile(f.driveId, text);
  }

  /** The posting time in the name; a name without a date posts on the day it was uploaded. */
  private parse(f: DriveFileRecord) {
    return parseDriveName(f.name, f.uploadedAt ?? f.createdAt);
  }

  /** The name ends in _RAW: already edited elsewhere, so it posts as uploaded. */
  private isRaw(f: DriveFileRecord) {
    const parsed = this.parse(f);
    return parsed.ok && parsed.raw;
  }

  /** Where FreePoster posts Drive videos: its default accounts. */
  accounts(): Account[] {
    return defaultAccounts(this.store);
  }

  /** The default accounts that can take a video this long, with a note for each that can't; null when there are none. */
  private targets(f: DriveFileRecord, sec: number, edited: boolean): { to: Account[]; notes: string[] } | null {
    const chosen = this.accounts();
    if (!chosen.length) {
      // Not set up yet: wait, and go on as soon as default accounts are chosen.
      this.store.upsertDriveFile(f.driveId, { note: "Choose default accounts in FreePoster" });
      return null;
    }
    const notes: string[] = [];
    const to = chosen.filter((a) => {
      const p = this.publishers[a.platform];
      if (this.store.alreadyPublished(f.sha256!, a.id)) {
        notes.push(`${p.label} (${a.name}): this video was already posted there`);
        return false;
      }
      if (sec > p.maxDurationSec(a) + 0.05 || sec < p.minDurationSec) {
        notes.push(`${p.label} (${a.name}): takes ${p.minDurationSec}–${p.maxDurationSec(a)}s; the ${edited ? "edited " : ""}video is ${sec.toFixed(1)}s`);
        return false;
      }
      return true;
    });
    if (!to.length) {
      this.store.upsertDriveFile(f.driveId, { state: "failed", note: `no account could take it. ${notes.join("; ")}` });
      return null;
    }
    return { to, notes };
  }

  /**
   * Sends the ready edit to the user. The review covers the exact file, the accounts, the caption and the time;
   * only their approval makes the post (the review service makes it, and followReview() records it here).
   */
  private async requestReview(f: DriveFileRecord) {
    const edit = this.store.edit(f.editId!)!;
    const open = this.openReviewFor(edit.id);
    if (open) {
      // An agent already asked about this edit: that review is the one the user answers.
      this.store.upsertDriveFile(f.driveId, { state: "reviewing", reviewId: open.id });
      return;
    }
    const target = this.targets(f, edit.durationSec ?? 0, true);
    if (!target) return;
    this.busy.add(f.driveId);
    try {
      const review = await this.deps.reviews.request({
        subject: { kind: "edit", id: edit.id },
        accountIds: target.to.map((a) => a.id),
        caption: f.caption!,
        title: f.title ?? "",
        // A time still ahead posts then; one already reached (a name with no time, or a slow edit) posts on approval.
        scheduledAt: f.scheduledAt !== null && f.scheduledAt > this.now() ? f.scheduledAt : null,
        tiktok: target.to.some((a) => a.platform === "tiktok") ? defaultTikTok(this.store) : null,
        allowDuplicate: false,
        via: "drive",
        expireAtSchedule: false,
      });
      this.store.upsertDriveFile(f.driveId, { state: "reviewing", reviewId: review.id, note: target.notes.join("; ") || null });
      log(f, `edit ${edit.id} sent for review (review ${review.id})`);
    } catch (err) {
      this.store.upsertDriveFile(f.driveId, { state: "unreviewed", note: `it couldn't be sent for review: ${(err as Error).message}` });
    } finally {
      this.busy.delete(f.driveId);
    }
  }

  /** A _RAW name: the video posts as uploaded, with no edit or review (it was edited, and seen, elsewhere). */
  private async schedule(f: DriveFileRecord) {
    if (!this.accounts().length) {
      this.store.upsertDriveFile(f.driveId, { note: "Choose default accounts in FreePoster" });
      return;
    }
    let sec: number;
    this.busy.add(f.driveId);
    try {
      sec = (await probe(f.sourcePath!)).durationSec;
    } catch (err) {
      this.store.upsertDriveFile(f.driveId, { state: "failed", note: (err as Error).message });
      return;
    } finally {
      this.busy.delete(f.driveId);
    }
    const target = this.targets(f, sec, false);
    if (!target) return;
    const { to, notes } = target;
    const now = this.now();
    const at = Math.max(f.scheduledAt ?? now, now);
    // A name with no time is on time until its day ends.
    const parsed = this.parse(f);
    const latest = parsed.ok ? parsed.latest : f.scheduledAt;
    if (latest !== null && now - latest > 60_000) notes.unshift("the caption finished after the scheduled time; posted late");
    const postId = this.store.createDrivePost(f.driveId, {
      caption: f.caption!,
      title: f.title ?? "",
      sourcePath: f.sourcePath!,
      sha256: f.sha256!,
      tiktok: to.some((a) => a.platform === "tiktok") ? defaultTikTok(this.store) : null,
      scheduledAt: at,
      editId: null,
      requireEdit: false,
      origin: "drive",
    }, to.map((a) => a.id), notes.join("; ") || null);
    if (postId) log(f, `scheduled as post ${postId} for ${new Date(at).toLocaleString()}`);
  }
}
