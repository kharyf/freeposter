// Watches the Drive folder while FreePoster runs: every ten seconds it asks Drive's change feed what's new
// (Drive's push notifications would need a public address). Every ten minutes, and while an upload is still
// finishing, it also lists the folder, to catch anything the feed missed. Each new video is handed over once,
// after its upload has finished.
import type { Store } from "../db.ts";
import { AuthError, FatalError } from "../http.ts";
import { folderChanges, listFolder, refreshDrive, startPageToken, uploadedAt, type DriveFile } from "./client.ts";

const RECONNECT = "Google Drive sign-in expired or was revoked; reconnect Google Drive in Setup";
export const POLL_MS = 10_000;
const FULL_LIST_MS = 10 * 60_000;

export class DriveWatcher {
  store: Store;
  onFile: (f: DriveFile) => void;
  timer: NodeJS.Timeout | undefined;
  polling: Promise<void> | undefined;
  lastFullList = 0;

  constructor(store: Store, onFile: (f: DriveFile) => void) {
    this.store = store;
    this.onFile = onFile;
  }

  start(intervalMs = POLL_MS) {
    const tick = () => {
      void this.poll().catch((err) => console.error(`drive poll: ${(err as Error).message}`));
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** A working access token, refreshed when it's about to expire. Records a reconnect error when Google refuses. */
  async token(force = false): Promise<string | null> {
    const conn = this.store.driveConnection();
    if (!conn || conn.error) return null;
    if (!force && conn.expiresAt !== null && conn.expiresAt - Date.now() > 60_000) return conn.accessToken;
    try {
      const fresh = await refreshDrive(conn);
      this.store.saveDriveTokens(fresh);
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof FatalError) {
        this.store.setDriveError(RECONNECT);
        return null;
      }
      throw err; // network trouble: try again next poll
    }
  }

  poll(): Promise<void> {
    // One poll at a time, even if a slow one overlaps the next tick.
    this.polling ??= this.doPoll().finally(() => (this.polling = undefined));
    return this.polling;
  }

  /** Calls Drive with a working token, signing in again once if Google says it expired. Null when Drive is disconnected. */
  private async api<T>(call: (token: string) => Promise<T>): Promise<T | null> {
    const token = await this.token();
    if (!token) return null;
    try {
      return await call(token);
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      const again = await this.token(true);
      return again ? call(again) : null;
    }
  }

  /** The whole folder. Null (with the error recorded) when it can't be opened. */
  private async listAll(folderId: string): Promise<DriveFile[] | null> {
    try {
      const files = await this.api((t) => listFolder(t, folderId));
      if (files) this.lastFullList = Date.now();
      return files;
    } catch (err) {
      // Not found / no access: the user has to fix the link or the sharing; say so instead of retrying quietly.
      if (err instanceof FatalError && !(err instanceof AuthError)) {
        this.store.setDriveError("FreePoster can't open the Drive folder. Check the folder link, and that it's shared with the Google account you connected.");
        return null;
      }
      throw err;
    }
  }

  private async doPoll() {
    const conn = this.store.driveConnection();
    if (!conn?.folderId || conn.error) return;
    const folderId = conn.folderId;

    if (!conn.baselineDone) {
      // Mark the feed before listing, so a file added in between is reported as new rather than missed.
      const start = await this.api(startPageToken);
      if (!start) return;
      const files = await this.listAll(folderId);
      if (!files) return;
      for (const f of files) {
        if (!this.store.driveFile(f.id)) {
          this.store.upsertDriveFile(f.id, { name: f.name, state: "ignored", size: f.size, md5: f.md5Checksum ?? null, note: "was already in the folder when it was connected" });
        }
      }
      this.store.setDriveChangesToken(start);
      this.store.markDriveBaseline();
      return;
    }

    const seen = new Map<string, DriveFile>();
    let fromToken = conn.changesToken;
    if (fromToken) {
      try {
        const changes = await this.api((t) => folderChanges(t, folderId, fromToken!));
        if (!changes) return;
        for (const f of changes.files) seen.set(f.id, f);
        this.store.setDriveChangesToken(changes.next);
      } catch (err) {
        if (!(err instanceof FatalError) || err instanceof AuthError) throw err;
        fromToken = null; // Drive no longer accepts the token: start the feed again, and list the folder this time
      }
    }
    if (!fromToken) {
      const start = await this.api(startPageToken);
      if (!start) return;
      this.store.setDriveChangesToken(start);
    }
    const uploading = this.store.driveFilesIn(["pending"]).length > 0;
    if (!fromToken || uploading || Date.now() - this.lastFullList >= FULL_LIST_MS) {
      const files = await this.listAll(folderId);
      if (!files) return;
      for (const f of files) seen.set(f.id, f);
    }

    for (const f of seen.values()) {
      const known = this.store.driveFile(f.id);
      if (known && known.state !== "pending") continue;
      const fields = { name: f.name, size: f.size, md5: f.md5Checksum ?? null, ...(known ? {} : { uploadedAt: uploadedAt(f) }) };
      // Drive only fills in the checksum once the upload is complete.
      if (!f.md5Checksum) {
        this.store.upsertDriveFile(f.id, { ...fields, state: "pending" });
        continue;
      }
      this.store.upsertDriveFile(f.id, { ...fields, state: "queued" });
      this.onFile(f);
    }
  }
}
