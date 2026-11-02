// Polls the watched Drive folder (every two minutes while FreePoster runs; Drive's push notifications would
// need a public address). Each new video is handed over once, after its upload has finished.
import type { Store } from "../db.ts";
import { AuthError, FatalError } from "../http.ts";
import { listFolder, refreshDrive, uploadedAt, type DriveFile } from "./client.ts";

const RECONNECT = "Google Drive sign-in expired or was revoked; reconnect Google Drive in Setup";

export class DriveWatcher {
  store: Store;
  onFile: (f: DriveFile) => void;
  timer: NodeJS.Timeout | undefined;
  polling: Promise<void> | undefined;

  constructor(store: Store, onFile: (f: DriveFile) => void) {
    this.store = store;
    this.onFile = onFile;
  }

  start(intervalMs = 120_000) {
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

  private async doPoll() {
    const conn = this.store.driveConnection();
    if (!conn?.folderId || conn.error) return;
    let token = await this.token();
    if (!token) return;
    let files: DriveFile[];
    try {
      try {
        files = await listFolder(token, conn.folderId);
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        token = await this.token(true);
        if (!token) return;
        files = await listFolder(token, conn.folderId);
      }
    } catch (err) {
      // Not found / no access: the user has to fix the link or the sharing; say so instead of retrying quietly.
      if (err instanceof FatalError && !(err instanceof AuthError)) {
        this.store.setDriveError("FreePoster can't open the Drive folder. Check the folder link, and that it's shared with the Google account you connected.");
        return;
      }
      throw err;
    }

    if (!conn.baselineDone) {
      for (const f of files) {
        if (!this.store.driveFile(f.id)) {
          this.store.upsertDriveFile(f.id, { name: f.name, state: "ignored", size: f.size, md5: f.md5Checksum ?? null, note: "was already in the folder when it was connected" });
        }
      }
      this.store.markDriveBaseline();
      return;
    }

    for (const f of files) {
      const known = this.store.driveFile(f.id);
      if (!known) {
        this.store.upsertDriveFile(f.id, { name: f.name, state: "pending", size: f.size, md5: f.md5Checksum ?? null, uploadedAt: uploadedAt(f) });
        continue;
      }
      if (known.state !== "pending") continue;
      // Finished uploading: Drive has its checksum and the size held still since the last poll.
      if (f.md5Checksum && f.size === known.size) {
        this.store.upsertDriveFile(f.id, { name: f.name, state: "queued", md5: f.md5Checksum });
        this.onFile(f);
      } else {
        this.store.upsertDriveFile(f.id, { size: f.size, md5: f.md5Checksum ?? null });
      }
    }
  }
}
