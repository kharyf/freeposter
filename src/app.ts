import { basename, join } from "node:path";
import { AiService, setAi } from "./ai/router.ts";
import { config, dataDir, isConfigured, isLocalUrl } from "./config.ts";
import { loadKey } from "./crypto.ts";
import { Store } from "./db.ts";
import { writeCaption } from "./caption.ts";
import { Captioner } from "./captioner.ts";
import { downloadFile } from "./drive/client.ts";
import { Intake } from "./drive/intake.ts";
import { DriveWatcher } from "./drive/watcher.ts";
import { EditWorker } from "./edit/worker.ts";
import { sampleFrames } from "./media.ts";
import { Notifier } from "./notify.ts";
import { publishers } from "./platforms/index.ts";
import { adapters } from "./produce/adapters/index.ts";
import { ProductionStore } from "./produce/store.ts";
import { ProductionWorker } from "./produce/worker.ts";
import { Runner } from "./runner.ts";
import { buildServer, type ServerOptions } from "./server.ts";
import { PLATFORMS } from "./types.ts";

export interface RunningApp {
  stop(): Promise<void>;
  /** Posts still to go out (including scheduled ones). */
  pendingJobs(): number;
  /** Whether FreePoster should keep running in the background: posts are waiting, or a Drive folder is watched. */
  keepAlive(): boolean;
  /** Why Drive stopped (sign-in revoked, folder unreadable), for the tray to show. */
  driveError(): string | null;
}

/** Posts waiting, edits or Drive files part-way through, or a watched folder (even one needing a reconnect). */
export function keepRunning(store: Store): boolean {
  return store.pendingJobCount() > 0 || store.openEditCount() > 0 || new ProductionStore(store).openCount() > 0 || store.driveFilesIn(["queued", "downloading", "transcribing", "processing"]).length > 0
    || Boolean(store.driveConnection()?.folderId);
}

/** Opens the database, starts the HTTP server and job runner. */
export async function startApp(options: ServerOptions = {}): Promise<RunningApp> {
  if (!isLocalUrl(config.baseUrl) && !config.appPassword) {
    throw new Error(`BASE_URL ${config.baseUrl} is reachable from outside; set APP_PASSWORD so only you can post.`);
  }

  const store = new Store(join(dataDir, "freeposter.db"), loadKey(dataDir));
  // Captions, titles and lyric spotting ask the user's AI providers, in their order for each job.
  const ai = new AiService(store);
  setAi(ai);
  const runner = new Runner(store, publishers);
  const editor = new EditWorker(store);
  const notifier = new Notifier(store);
  // Inputs are stored by content hash, so a file's name is its hash: the edit pipeline's transcript cache key.
  const speech = (path: string) => editor.speechFor({ sourcePath: path, sha256: basename(path).replace(/\.[^.]+$/, "") });
  const producer = new ProductionWorker(store, {
    adapters: adapters({ speechFor: (src) => editor.speechFor(src) }),
    transcribe: speech,
  });
  // Drive: the watcher finds new videos, the intake edits, captions and schedules them.
  let watcher: DriveWatcher;
  const intake = new Intake(store, publishers, {
    download: async (id) => {
      const token = await watcher.token();
      if (!token) throw new Error("Google Drive isn't connected");
      return downloadFile(token, id);
    },
    transcribe: (sourcePath, sha256) => editor.speechFor({ sourcePath, sha256 }),
    writeCaption: (input) => writeCaption(input, publishers),
    frames: (sourcePath) => sampleFrames(sourcePath),
  });
  watcher = new DriveWatcher(store, (f) => void intake.handle(f).catch((err) => console.error(`drive intake: ${(err as Error).message}`)));
  // Posts made on the page or through MCP with a blank caption get one written the same way.
  const captioner = new Captioner(store, {
    transcribe: (sourcePath, sha256) => editor.speechFor({ sourcePath, sha256 }),
    writeCaption: (input) => writeCaption(input, publishers),
    frames: (sourcePath) => sampleFrames(sourcePath),
  });
  const app = buildServer(store, runner, publishers, options, { intake, poll: () => watcher.poll(), sync: () => watcher.sync() }, ai);

  try {
    await app.listen({ port: config.port, host: "127.0.0.1" });
  } catch (err) {
    setAi(undefined);
    store.close();
    throw err;
  }
  runner.start();
  editor.start();
  notifier.start();
  producer.start();
  captioner.start();
  void intake.resume().catch((err) => console.error(`drive resume: ${(err as Error).message}`));
  const intakeTimer = setInterval(() => void intake.tick().catch((err) => console.error(`drive tick: ${(err as Error).message}`)), 10_000);
  watcher.start();

  console.log(`FreePoster running at ${config.baseUrl}`);
  for (const p of PLATFORMS) {
    console.log(`  ${p.padEnd(9)} ${isConfigured(p) ? "configured" : "not set up yet"}`);
  }

  return {
    async stop() {
      runner.stop();
      editor.stop();
      notifier.stop();
      producer.stop();
      captioner.stop();
      watcher.stop();
      clearInterval(intakeTimer);
      await app.close();
      setAi(undefined);
      store.close();
    },
    pendingJobs: () => store.pendingJobCount(),
    keepAlive: () => keepRunning(store),
    driveError: () => store.driveConnection()?.error ?? null,
  };
}
