import { join } from "node:path";
import { config, dataDir, isConfigured, isLocalUrl } from "./config.ts";
import { loadKey } from "./crypto.ts";
import { Store } from "./db.ts";
import { publishers } from "./platforms/index.ts";
import { Runner } from "./runner.ts";
import { buildServer, type ServerOptions } from "./server.ts";
import { PLATFORMS } from "./types.ts";

export interface RunningApp {
  stop(): Promise<void>;
  /** Posts still to go out (including scheduled ones). */
  pendingJobs(): number;
}

/** Opens the database, starts the HTTP server and job runner. */
export async function startApp(options: ServerOptions = {}): Promise<RunningApp> {
  if (!isLocalUrl(config.baseUrl) && !config.appPassword) {
    throw new Error(`BASE_URL ${config.baseUrl} is reachable from outside; set APP_PASSWORD so only you can post.`);
  }

  const store = new Store(join(dataDir, "freeposter.db"), loadKey(dataDir));
  const runner = new Runner(store, publishers);
  const app = buildServer(store, runner, publishers, options);

  try {
    await app.listen({ port: config.port, host: "127.0.0.1" });
  } catch (err) {
    store.close();
    throw err;
  }
  runner.start();

  console.log(`FreePoster running at ${config.baseUrl}`);
  for (const p of PLATFORMS) {
    console.log(`  ${p.padEnd(9)} ${isConfigured(p) ? "configured" : "not set up yet"}`);
  }

  return {
    async stop() {
      runner.stop();
      await app.close();
      store.close();
    },
    pendingJobs: () => store.pendingJobCount(),
  };
}
