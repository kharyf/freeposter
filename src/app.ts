import { consoleBuffer, installConsoleCapture } from "./console-buffer.ts";
import { basename, join } from "node:path";
import { runProgram } from "./ai/cli.ts";
import { AiService, setAi } from "./ai/router.ts";
import { config, dataDir, isConfigured, isLocalUrl } from "./config.ts";
import { loadKey } from "./crypto.ts";
import { Store } from "./db.ts";
import { migrateFancyStyle } from "./edit/styles.ts";
import { writeCaption } from "./caption.ts";
import { Captioner } from "./captioner.ts";
import { downloadFile } from "./drive/client.ts";
import { Intake } from "./drive/intake.ts";
import { DriveWatcher } from "./drive/watcher.ts";
import { EditWorker } from "./edit/worker.ts";
import { sampleFrames } from "./media.ts";
import { MetricsPoller } from "./analytics/poller.ts";
import { backfillLabels, onPublished } from "./analytics/labels.ts";
import { syncLemoLibrary } from "./campaigns/lemo-library.ts";
import { evaluateRules } from "./campaigns/rules.ts";
import { AgentLauncher, abortOnRetire, abortOnStop } from "./campaigns/launcher.ts";
import { CampaignWorker } from "./campaigns/worker.ts";
import { Notifier } from "./notify.ts";
import { publishers } from "./platforms/index.ts";
import { adapters } from "./produce/adapters/index.ts";
import { ProductionStore } from "./produce/store.ts";
import { ProductionWorker } from "./produce/worker.ts";
import { ReviewService } from "./review/service.ts";
import { ReviewStore } from "./review/store.ts";
import { TelegramReview } from "./review/telegram.ts";
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
  return store.pendingJobCount() > 0 || store.openEditCount() > 0 || new ReviewStore(store).inState("preparing", "pending").length > 0 || new ProductionStore(store).openCount() > 0 || store.driveFilesIn(["queued", "downloading", "transcribing", "processing"]).length > 0
    || Boolean(store.driveConnection()?.folderId);
}

/** Opens the database, starts the HTTP server and job runner. */
export async function startApp(options: ServerOptions = {}): Promise<RunningApp> {
  installConsoleCapture(consoleBuffer); // after desktop.ts swapped console.* for its file writer, so we chain onto it
  if (!isLocalUrl(config.baseUrl) && !config.appPassword) {
    throw new Error(`BASE_URL ${config.baseUrl} is reachable from outside; set APP_PASSWORD so only you can post.`);
  }

  const store = new Store(join(dataDir, "freeposter.db"), loadKey(dataDir));
  migrateFancyStyle(store);
  // Captions, titles and lyric spotting ask the user's AI providers, in their order for each job.
  const ai = new AiService(store);
  setAi(ai);
  const runner = new Runner(store, publishers);
  const poller = new MetricsPoller(store, publishers, { freshAccount: (a, force) => runner.freshAccount(a, force) });
  // A published job starts its metrics polling and, for a recorded video, its labels (never affecting publishing,
  // and neither stopping the other).
  runner.onPublished = (jobId) => { void onPublished({ store, ai, schedule: (id) => poller.schedule(id) }, jobId); };
  // Posts published before labels existed (or whose labelling never finished) get a bare row, so Analytics shows them.
  try {
    const added = backfillLabels(store);
    if (added) console.log(`labels: ${added} published post${added === 1 ? "" : "s"} given bare labels`);
  } catch (err) {
    console.error(`labels: backfill: ${(err as Error).message}`);
  }
  // The Lemo-Opuscar film styles come from the library on this computer; a broken library never stops startup.
  try {
    const r = syncLemoLibrary(store);
    if (r.installed) console.log(`lemo: ${r.added} styles added, ${r.updated} updated, ${r.hidden} hidden`);
  } catch (err) {
    console.error(`lemo: sync: ${(err as Error).message}`);
  }
  const editor = new EditWorker(store);
  const notifier = new Notifier(store);
  // Inputs are stored by content hash, so a file's name is its hash: the edit pipeline's transcript cache key.
  const speech = (path: string) => editor.speechFor({ sourcePath: path, sha256: basename(path).replace(/\.[^.]+$/, "") });
  const producer = new ProductionWorker(store, {
    adapters: adapters({ speechFor: (src) => editor.speechFor(src) }),
    transcribe: speech,
    speechFor: (src) => editor.speechFor(src),
  });
  // Reviews: the only way an edited video gets posted (an agent's, or a Drive video's). The user decides on
  // Telegram or in the window.
  const reviews = new ReviewService(store, {
    publishers,
    runner,
    productions: () => producer.productions,
    transcribe: (path, sha256) => editor.speechFor({ sourcePath: path, sha256 }),
    caption: { writeCaption: (input) => writeCaption(input, publishers), frames: (sourcePath) => sampleFrames(sourcePath) },
  });
  // Drive: the watcher finds new videos; the intake edits and captions them and sends them for review.
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
    reviews,
  });
  watcher = new DriveWatcher(store, (f) => void intake.handle(f).catch((err) => console.error(`drive intake: ${(err as Error).message}`)));
  // Posts made on the page or through MCP with a blank caption get one written the same way.
  const captioner = new Captioner(store, {
    transcribe: (sourcePath, sha256) => editor.speechFor({ sourcePath, sha256 }),
    writeCaption: (input) => writeCaption(input, publishers),
    frames: (sourcePath) => sampleFrames(sourcePath),
  });
  // Campaigns: today's instructions become tasks, made by plain code and sent for review like everything else.
  const campaigns = new CampaignWorker({ store, productions: producer, reviews, ai });
  // Agent films: when the user turns it on, FreePoster starts Claude Code here for each open brief, on the GPU lane.
  const launcher = new AgentLauncher({ store, campaigns: campaigns.campaigns, run: runProgram, borrowGpu: (fn) => producer.borrowGpu(fn) });
  // Stop Campaign (for the launch's own campaign) and the kill switch end a running launch.
  campaigns.onStop = abortOnStop(launcher);
  campaigns.onRetire = abortOnRetire(launcher);
  // After each analytics refresh, campaign rules are checked against the new scores (plain code, no AI).
  poller.onRefresh = () => {
    try {
      evaluateRules({ store, analytics: campaigns.analytics, campaigns: campaigns.campaigns, worker: campaigns, now: Date.now() });
    } catch (err) {
      console.error(`campaign rules: ${(err as Error).message}`);
    }
  };
  // /stop from the paired Telegram user is the campaigns' kill switch.
  const telegram = new TelegramReview(store, reviews, { stopCampaigns: () => campaigns.stopAll() });
  const app = buildServer(store, runner, publishers, options, { intake, poll: () => watcher.poll(), sync: () => watcher.sync() }, ai, producer, { service: reviews, telegram }, campaigns);

  try {
    await app.listen({ port: config.port, host: "127.0.0.1" });
  } catch (err) {
    setAi(undefined);
    store.close();
    throw err;
  }
  runner.start();
  poller.start();
  editor.start();
  notifier.start();
  producer.start();
  captioner.start();
  reviews.start();
  telegram.start();
  campaigns.start();
  launcher.start();
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
      poller.stop();
      editor.stop();
      notifier.stop();
      producer.stop();
      captioner.stop();
      reviews.stop();
      telegram.stop();
      campaigns.stop();
      launcher.stop();
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
