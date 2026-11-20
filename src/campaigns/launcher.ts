// The local launcher: while a film brief is open and the user has turned it on, FreePoster starts Claude Code
// headless on this computer to claim the brief through FreePoster's own MCP tools, make the film with the
// lemo-opuscar skill and submit it. One launch at a time, on the GPU lane. A run that fails isn't retried here:
// the brief's lease runs out and offers it again, and only then may the same task be launched again.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastWords, planEnv, type ProgramRun } from "../ai/cli.ts";
import { findClaude } from "../claude.ts";
import { codeDir, config, dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { LAUNCH_PREF, LEASE_MINUTES, openBriefs } from "./briefs.ts";
import type { CampaignStore } from "./store.ts";
import type { Productions } from "./worker.ts";

export const ENABLED_PREF = LAUNCH_PREF;
export const STATUS_PREF = "agent.launch.status";
const MIN = 60_000;

/** Where the prompt ships: templates/, unpacked beside the bundle in the installed app. */
const promptFile = () => join(codeDir.replace(/app\.asar$/, "app.asar.unpacked"), "templates", "agent", "brief-prompt.md");

export interface AgentLauncherDeps {
  store: Store;
  campaigns: CampaignStore;
  run: ProgramRun;
  borrowGpu: Productions["borrowGpu"];
  now?: () => number;
  /** where agent-mcp.json and films/ go (FreePoster's data folder) */
  dataDir?: string;
  /** Claude Code's path, "" when it isn't installed (as the setup screen finds it) */
  find?: () => string;
}

export class AgentLauncher {
  private store: Store;
  private campaigns: CampaignStore;
  private run: ProgramRun;
  private borrowGpu: Productions["borrowGpu"];
  private now: () => number;
  private dir: string;
  private find: () => string;
  private running = false;
  /** When each task was last launched, so a failing Claude isn't started again every tick. */
  private launched = new Map<number, number>();
  private timer?: ReturnType<typeof setTimeout>;
  /** Stops the running launch's Claude, and everything it started. */
  private abort?: AbortController;

  constructor(deps: AgentLauncherDeps) {
    this.store = deps.store;
    this.campaigns = deps.campaigns;
    this.run = deps.run;
    this.borrowGpu = deps.borrowGpu;
    this.now = deps.now ?? Date.now;
    this.dir = deps.dataDir ?? dataDir;
    this.find = deps.find ?? findClaude;
  }

  /** Ticks at the campaign worker's cadence. A launch runs on past the tick that started it. */
  start(intervalMs = 15_000) {
    const tick = () => {
      void this.tick().catch((err) => console.error(`agent launcher: ${(err as Error).message}`));
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  /** Stops ticking and ends a launch that's running (its brief's lease offers it again later). */
  stop() {
    clearTimeout(this.timer);
    this.abort?.abort();
  }

  /** Written only when it changes, since this runs every tick. */
  private status(text: string) {
    if (this.store.pref<string>(STATUS_PREF) !== text) this.store.setPref(STATUS_PREF, text);
  }

  /** Starts Claude for the oldest open brief when it's turned on, installed, and nothing is running. Resolves when that run ends. */
  async tick(): Promise<void> {
    if (this.running) return;
    if (this.store.pref<boolean>(ENABLED_PREF) !== true) return this.status("off");
    const claude = this.find();
    if (!claude) return this.status("Claude Code not found");
    const now = this.now();
    for (const [id, at] of this.launched) if (now - at >= LEASE_MINUTES * MIN) this.launched.delete(id);
    const task = openBriefs(this.campaigns, now).sort((a, b) => a.id - b.id).find((t) => !this.launched.has(t.id));
    if (!task) {
      // A failure stays shown until the next run; anything else settles to idle.
      if (!this.store.pref<string>(STATUS_PREF)?.startsWith("last run failed")) this.status("idle");
      return;
    }
    this.running = true;
    const abort = (this.abort = new AbortController());
    const mcpConfig = join(this.dir, "agent-mcp.json");
    try {
      const films = join(this.dir, "films");
      mkdirSync(films, { recursive: true });
      this.writeMcpConfig(mcpConfig);
      const prompt = readFileSync(promptFile(), "utf8").replaceAll("{{task_id}}", String(task.id));
      const args = ["-p", prompt, "--mcp-config", mcpConfig, "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Write,Edit,Skill,mcp__freeposter__*"];
      const done = await this.borrowGpu(async () => {
        this.launched.set(task.id, this.now());
        this.status(`working on task ${task.id}`);
        // Without an API key in its environment, Claude Code runs on the user's plan.
        return this.run(claude, args, "", {
          env: planEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]), cwd: films, timeoutMs: LEASE_MINUTES * MIN,
          signal: abort.signal, killTree: true,
        });
      });
      if (!done) return; // a GPU shot is running: next tick
      const { code, stdout, stderr } = done.value;
      if (code === 0) return this.status("idle");
      const words = lastWords(stdout, stderr) || `exit code ${code}`;
      console.error(`agent launcher: task ${task.id}: Claude Code failed: ${words}`);
      this.status(`last run failed: ${words}`);
    } catch (err) {
      console.error(`agent launcher: task ${task.id}: ${(err as Error).message}`);
      this.status(`last run failed: ${(err as Error).message}`);
    } finally {
      // It may hold the app password, so it's only on disk while Claude runs.
      rmSync(mcpConfig, { force: true });
      this.abort = undefined;
      this.running = false;
    }
  }

  /** FreePoster's MCP server as Claude Code reads it, with the app password when one is set. */
  private writeMcpConfig(path: string) {
    // The address the server listens on, so nothing goes through a public tunnel set as BASE_URL.
    const server: Record<string, unknown> = { type: "http", url: `http://127.0.0.1:${config.port}/mcp` };
    // The server takes the password as Basic auth with any user name, as the browser sends it.
    if (config.appPassword) server.headers = { Authorization: `Basic ${Buffer.from(`freeposter:${config.appPassword}`).toString("base64")}` };
    writeFileSync(path, JSON.stringify({ mcpServers: { freeposter: server } }, null, 2), { mode: 0o600 });
  }
}
