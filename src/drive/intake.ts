// What happens to a video dropped in the watched Drive folder: read the posting time from its name (or its upload day),
// download it, transcribe it, edit it (auto-approved) while Claude writes its title and caption, then
// schedule it to FreePoster's default accounts. The post waits for the edit, even past its time. A name ending in
// _RAW was already edited elsewhere: it skips the edit and posts as uploaded (still transcribed for its caption).
// Nothing waits for the user: a video with no speech is captioned from its frames, and when that (or Claude) fails
// it gets the caption #fyp. Every step is saved, so a restart picks up where it stopped.
import type { Readable } from "node:stream";
import { defaultAccounts, defaultTikTok } from "../accounts.ts";
import { captionVideo, transcriptText, type CaptionDeps } from "../caption.ts";
import type { Store } from "../db.ts";
import { DEFAULT_EDIT } from "../edit/settings.ts";
import type { Transcript } from "../edit/transcribe.ts";
import { probe } from "../media.ts";
import type { Publisher } from "../platforms/base.ts";
import { saveUpload } from "../posts.ts";
import type { Account, DriveFileRecord, Platform } from "../types.ts";
import { uploadedAt, type DriveFile } from "./client.ts";
import { parseDriveName } from "./filename.ts";

export interface IntakeDeps extends CaptionDeps {
  download: (driveId: string) => Promise<Readable>;
  /** shared with the edit, so each video is transcribed once */
  transcribe: (sourcePath: string, sha256: string) => Promise<Transcript>;
  now?: () => number;
}

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

  /** Runs every few seconds: posts files whose edit (if they get one) and caption are ready, and retries failed downloads. */
  async tick() {
    for (const f of this.store.driveFilesIn(["downloading"])) {
      if (!this.busy.has(f.driveId) && this.now() - f.updatedAt > DOWNLOAD_RETRY_MS) void this.advance(f.driveId);
    }
    for (const f of this.store.driveFilesIn(["processing"])) {
      if (this.busy.has(f.driveId)) continue;
      if (this.isRaw(f)) {
        if (f.state === "processing" && f.caption !== null) await this.schedule(f);
        continue;
      }
      const edit = f.editId ? this.store.edit(f.editId) : undefined;
      if (!edit || edit.state === "failed") {
        this.store.upsertDriveFile(f.driveId, { state: "edit_failed", note: `the edit failed: ${edit?.error ?? "it is missing"}` });
        continue;
      }
      if (f.state === "processing" && f.caption !== null && edit.state === "ready") await this.schedule(f);
    }
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

  /** Creates the post: the ready, approved edit, or for a _RAW name the video as uploaded. */
  private async schedule(f: DriveFileRecord) {
    const chosen = this.accounts();
    if (!chosen.length) {
      // Not set up yet: wait, and post as soon as default accounts are chosen.
      this.store.upsertDriveFile(f.driveId, { note: "Choose default accounts in FreePoster" });
      return;
    }
    const raw = this.isRaw(f);
    const edit = raw ? null : this.store.edit(f.editId!)!;
    let sec: number;
    if (edit) {
      this.store.approveEdit(edit.id); // Drive videos go out without the user's preview (their decision)
      sec = edit.durationSec ?? 0;
    } else {
      this.busy.add(f.driveId);
      try {
        sec = (await probe(f.sourcePath!)).durationSec;
      } catch (err) {
        this.store.upsertDriveFile(f.driveId, { state: "failed", note: (err as Error).message });
        return;
      } finally {
        this.busy.delete(f.driveId);
      }
    }
    const notes: string[] = [];
    const to = chosen.filter((a) => {
      const p = this.publishers[a.platform];
      if (this.store.alreadyPublished(f.sha256!, a.id)) {
        notes.push(`${p.label} (${a.name}): this video was already posted there`);
        return false;
      }
      if (sec > p.maxDurationSec(a) + 0.05 || sec < p.minDurationSec) {
        notes.push(`${p.label} (${a.name}): takes ${p.minDurationSec}–${p.maxDurationSec(a)}s; the ${edit ? "edited " : ""}video is ${sec.toFixed(1)}s`);
        return false;
      }
      return true;
    });
    if (!to.length) {
      this.store.upsertDriveFile(f.driveId, { state: "failed", note: `no account could take it. ${notes.join("; ")}` });
      return;
    }
    const now = this.now();
    const at = Math.max(f.scheduledAt ?? now, now);
    // A name with no time is on time until its day ends.
    const parsed = this.parse(f);
    const latest = parsed.ok ? parsed.latest : f.scheduledAt;
    if (latest !== null && now - latest > 60_000) notes.unshift(`${edit ? "the edit" : "the caption"} finished after the scheduled time; posted late`);
    const postId = this.store.createDrivePost(f.driveId, {
      caption: f.caption!,
      title: f.title ?? "",
      sourcePath: f.sourcePath!,
      sha256: f.sha256!,
      tiktok: to.some((a) => a.platform === "tiktok") ? defaultTikTok(this.store) : null,
      scheduledAt: at,
      editId: edit?.id ?? null,
      requireEdit: !raw,
    }, to.map((a) => a.id), notes.join("; ") || null);
    if (postId) log(f, `scheduled as post ${postId} for ${new Date(at).toLocaleString()}`);
  }
}
