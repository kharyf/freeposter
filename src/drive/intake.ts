// What happens to a video dropped in the watched Drive folder: read the posting time from its name,
// download it, transcribe it, edit it (auto-approved) while Claude writes its title and caption, then
// schedule it to the Drive accounts. A Drive video is never posted unedited: the post waits for the edit,
// even past its time. Every step is saved, so a restart picks up where it stopped.
import type { Readable } from "node:stream";
import type { Store } from "../db.ts";
import { DEFAULT_EDIT } from "../edit/settings.ts";
import type { Transcript } from "../edit/transcribe.ts";
import type { Publisher } from "../platforms/base.ts";
import { saveUpload } from "../posts.ts";
import type { Account, DriveFileRecord, Platform, TikTokOptions } from "../types.ts";
import type { DriveFile } from "./client.ts";
import { parseDriveName } from "./filename.ts";

export interface IntakeDeps {
  download: (driveId: string) => Promise<Readable>;
  /** shared with the edit, so each video is transcribed once */
  transcribe: (sourcePath: string, sha256: string) => Promise<Transcript>;
  writeCaption: (input: { topic: string; transcript: string; accounts: Account[] }) => Promise<{ title: string; caption: string }>;
  now?: () => number;
}

/** Drive settings kept in prefs. Privacy is not among them: Drive posts go to TikTok as "Only me". */
export interface DriveTikTokPrefs {
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
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
    if (!this.store.driveFile(f.id)) this.store.upsertDriveFile(f.id, { name: f.name, state: "queued", size: f.size });
    await this.advance(f.id);
  }

  /** After a restart: carry on with every file that was part-way through. */
  async resume() {
    const open = this.store.driveFilesIn(["queued", "downloading", "transcribing"]);
    // A caption that was being written when FreePoster stopped is written again.
    const uncaptioned = this.store.driveFilesIn(["processing"]).filter((f) => f.caption === null);
    await Promise.all([...open, ...uncaptioned].map((f) => this.advance(f.driveId)));
  }

  /** Runs every few seconds: posts files whose edit and caption are both ready, and retries failed downloads. */
  async tick() {
    for (const f of this.store.driveFilesIn(["downloading"])) {
      if (!this.busy.has(f.driveId) && this.now() - f.updatedAt > DOWNLOAD_RETRY_MS) void this.advance(f.driveId);
    }
    for (const f of this.store.driveFilesIn(["processing", "needs_caption"])) {
      if (this.busy.has(f.driveId)) continue;
      const edit = f.editId ? this.store.edit(f.editId) : undefined;
      if (!edit || edit.state === "failed") {
        this.store.upsertDriveFile(f.driveId, { state: "edit_failed", note: `the edit failed: ${edit?.error ?? "it is missing"}` });
        continue;
      }
      if (f.state === "processing" && f.caption !== null && edit.state === "ready") this.schedule(f);
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
      const edit = this.store.createEdit(f.sourcePath, f.sha256, DEFAULT_EDIT);
      this.store.upsertDriveFile(driveId, { state: f.caption === null ? "needs_caption" : "processing", editId: edit.id, note: f.caption === null ? "needs a caption" : null });
      return;
    }
    await this.advance(driveId);
  }

  /** The user's own title and caption for a file that couldn't get one written. */
  async releaseCaption(driveId: string, title: string, caption: string) {
    const f = this.store.driveFile(driveId);
    if (!f || f.state !== "needs_caption") throw new Error("this file isn't waiting for a caption");
    const problems = this.captionProblems({ title, caption });
    if (problems.length) throw new Error(problems.join("\n"));
    this.store.upsertDriveFile(driveId, { state: "processing", title, caption, note: null });
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
        const parsed = parseDriveName(f.name);
        if (!parsed.ok) {
          this.store.upsertDriveFile(id, { state: "invalid", note: parsed.reason });
          return false;
        }
        const now = this.now();
        if (parsed.at < now - GRACE_MS) {
          this.store.upsertDriveFile(id, { state: "late", scheduledAt: parsed.at, note: `its time (${new Date(parsed.at).toLocaleString()}) had already passed when it reached the folder` });
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
          this.store.upsertDriveFile(id, { state: "edit_failed", note: (err as Error).message });
          return false;
        }
        // The edit worker picks this up and runs alongside the caption writing below.
        const edit = this.store.createEdit(f.sourcePath!, f.sha256!, DEFAULT_EDIT);
        this.store.upsertDriveFile(id, { state: "processing", editId: edit.id });
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

  private async caption(f: DriveFileRecord, transcript: Transcript) {
    const text = transcript.words.map((w) => w.text).join(" ").trim();
    if (!text) {
      this.store.upsertDriveFile(f.driveId, { state: "needs_caption", note: "no speech to write a caption from; add a title and caption" });
      return;
    }
    try {
      log(f, "writing the caption");
      const topic = (parseDriveName(f.name) as { name?: string }).name ?? f.name;
      const { title, caption } = await this.deps.writeCaption({ topic, transcript: text, accounts: this.accounts() });
      this.store.upsertDriveFile(f.driveId, { title, caption });
    } catch (err) {
      this.store.upsertDriveFile(f.driveId, { state: "needs_caption", note: `${(err as Error).message}; add a title and caption` });
    }
  }

  /** The accounts Drive videos go to (Drive settings). */
  accounts(): Account[] {
    return (this.store.pref<number[]>("drive.accounts") ?? []).map((id) => this.store.account(id)).filter((a): a is Account => Boolean(a));
  }

  private tiktok(): TikTokOptions {
    const t = this.store.pref<DriveTikTokPrefs>("drive.tiktok") ?? {};
    return {
      privacyLevel: "SELF_ONLY",
      disableComment: t.allowComment === false,
      disableDuet: t.allowDuet === false,
      disableStitch: t.allowStitch === false,
      brandContent: false,
      brandOrganic: false,
    };
  }

  private captionProblems(text: { title: string; caption: string }): string[] {
    const post = { id: 0, createdAt: 0, sourcePath: "", sha256: "", tiktok: this.tiktok(), ...text };
    return this.accounts().flatMap((a) => {
      const reason = this.publishers[a.platform].validate(post, a);
      return reason ? [`${this.publishers[a.platform].label} (${a.name}): ${reason}`] : [];
    });
  }

  /** Creates the post: the edit is ready and approved, never the original. */
  private schedule(f: DriveFileRecord) {
    const edit = this.store.edit(f.editId!)!;
    this.store.approveEdit(edit.id); // Drive videos go out without the user's preview (their decision)
    const sec = edit.durationSec ?? 0;
    const notes: string[] = [];
    const to = this.accounts().filter((a) => {
      const p = this.publishers[a.platform];
      if (this.store.alreadyPublished(f.sha256!, a.id)) {
        notes.push(`${p.label} (${a.name}): this video was already posted there`);
        return false;
      }
      if (sec > p.maxDurationSec(a) + 0.05 || sec < p.minDurationSec) {
        notes.push(`${p.label} (${a.name}): takes ${p.minDurationSec}–${p.maxDurationSec(a)}s; the edited video is ${sec.toFixed(1)}s`);
        return false;
      }
      return true;
    });
    if (!to.length) {
      this.store.upsertDriveFile(f.driveId, { state: "failed", note: notes.length ? `no account could take it. ${notes.join("; ")}` : "choose the accounts Drive videos go to in Settings" });
      return;
    }
    const now = this.now();
    const at = Math.max(f.scheduledAt ?? now, now);
    if (f.scheduledAt !== null && now - f.scheduledAt > 60_000) notes.unshift("the edit finished after the scheduled time; posted late");
    const postId = this.store.createDrivePost(f.driveId, {
      caption: f.caption!,
      title: f.title ?? "",
      sourcePath: f.sourcePath!,
      sha256: f.sha256!,
      tiktok: to.some((a) => a.platform === "tiktok") ? this.tiktok() : null,
      scheduledAt: at,
      editId: edit.id,
      requireEdit: true,
    }, to.map((a) => a.id), notes.join("; ") || null);
    if (postId) log(f, `scheduled as post ${postId} for ${new Date(at).toLocaleString()}`);
  }
}
