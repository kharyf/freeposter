// The local launcher: while a film brief is open and Claude is connected under AI Providers, FreePoster starts Claude Code
// headless on this computer to claim the brief through FreePoster's own MCP tools, make the film with the
// lemo-opuscar skill and submit it. One launch at a time, on the GPU lane. A run that fails isn't retried here:
// the brief's lease runs out and offers it again, and only then may the same task be launched again.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastWords, planEnv, type ProgramRun } from "../ai/cli.ts";
import { claudeConnected } from "../ai/router.ts";
import { findClaude } from "../claude.ts";
import { codeDir, config, dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { LEASE_MINUTES, openBriefs } from "./briefs.ts";
import { ROW_INSTRUCTION_BASE, rowIdHex } from "./rows.ts";
import type { CampaignStore } from "./store.ts";
import type { Productions, TaskChoices } from "./worker.ts";

export const STATUS_PREF = "agent.launch.status";
/** The status while Claude isn't connected: no campaign film can be made. */
export const NOT_CONNECTED = "Claude isn't connected under AI Providers";
const MIN = 60_000;
/** The least time a launch is given, however close its brief's deadline. */
const MIN_RUN_MINUTES = 5;
/**
 * The only FreePoster tools the launched Claude may use: the brief ones, never posting, campaigns or the kill
 * switch. Bash stays open, since the lemo-opuscar skill runs sh, git, node, npm, ffmpeg and python.
 */
const BRIEF_TOOLS = ["list_briefs", "claim_brief", "renew_brief", "submit_brief", "give_up_brief"];
const ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Skill", ...BRIEF_TOOLS.map((t) => `mcp__freeposter__${t}`)].join(",");

/**
 * The `--model` Claude Code runs on: the brief's (its `claude:` id, which the row's checks keep to a Claude model).
 * A brief with none (or one made before briefs had one) passes no flag, so Claude Code uses the user's own setting.
 */
const modelArgs = (model: string | null | undefined): string[] => (model?.startsWith("claude:") ? ["--model", model.slice("claude:".length)] : []);

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
  private controller?: AbortController;
  /** The running launch's task and campaign. */
  private current?: { taskId: number; campaignId: number };
  /** Why the running launch was stopped by abort(), shown once it has ended. */
  private stoppedFor?: string;

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
    this.controller?.abort();
  }

  /** The task and campaign of the launch that's running, if any. */
  runningFor(): { taskId: number; campaignId: number } | undefined {
    return this.current;
  }

  /**
   * Ends the running launch (Claude and everything it started), for the reason given; the launch's lease is then
   * released as for any run that ends without a film. Returns whether one was running.
   */
  abort(reason: string): boolean {
    if (!this.controller || !this.current) return false;
    console.log(`agent launcher: stopping the run for task ${this.current.taskId}: ${reason}`);
    this.stoppedFor = reason;
    this.controller.abort();
    return true;
  }

  /**
   * A run that ended while its task still waits for a film, with no delivery: a lease claimed during the run is
   * released and its offer given back, so only a lease the worker sees expire uses one up. Returns whether it did.
   */
  private release(taskId: number, since: number): boolean {
    const t = this.campaigns.task(taskId);
    if (!t || t.state !== "awaiting_agent") return false;
    const c = t.choices as unknown as TaskChoices;
    if (c.delivery || !c.lease || !(typeof c.lease.claimedAt === "number" && c.lease.claimedAt >= since)) return false;
    const { lease: _released, ...rest } = t.choices as Record<string, unknown>;
    this.campaigns.updateTask(taskId, { choices: { ...rest, offers: Math.max(0, (c.offers ?? 0) - 1) } });
    console.log(`agent launcher: task ${taskId}: the run ended without a film; its lease was released`);
    return true;
  }

  /** Written only when it changes, since this runs every tick. */
  private status(text: string) {
    if (this.store.pref<string>(STATUS_PREF) !== text) this.store.setPref(STATUS_PREF, text);
  }

  /** Starts Claude for the oldest open brief when Claude is connected, installed, and nothing is running. Resolves when that run ends. */
  async tick(): Promise<void> {
    if (this.running) return;
    if (!claudeConnected(this.store)) return this.status(NOT_CONNECTED);
    const claude = this.find();
    if (!claude) return this.status("Claude Code not found");
    const now = this.now();
    for (const [id, at] of this.launched) if (now - at >= LEASE_MINUTES * MIN) this.launched.delete(id);
    const task = openBriefs(this.campaigns, now).sort((a, b) => a.id - b.id).find((t) => !this.launched.has(t.id));
    if (!task) {
      // How the last run ended (failed, stopped, or no film) stays shown until the next run; anything else settles to idle.
      if (!/^(last run failed|stopped: |finished without a film)/.test(this.store.pref<string>(STATUS_PREF) ?? "")) this.status("idle");
      return;
    }
    this.running = true;
    const abort = (this.controller = new AbortController());
    this.current = { taskId: task.id, campaignId: task.campaignId };
    this.stoppedFor = undefined;
    const mcpConfig = join(this.dir, "agent-mcp.json");
    let startedAt: number | undefined;
    let outcome: string | undefined;
    try {
      const films = join(this.dir, "films");
      mkdirSync(films, { recursive: true });
      this.writeMcpConfig(mcpConfig);
      const prompt = readFileSync(promptFile(), "utf8").replaceAll("{{task_id}}", String(task.id));
      const brief = (task.choices as unknown as TaskChoices).brief!;
      const args = ["-p", prompt, "--mcp-config", mcpConfig, "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS, ...modelArgs(brief.model)];
      const deadline = brief.deadline;
      const done = await this.borrowGpu(async () => {
        startedAt = this.now();
        this.launched.set(task.id, startedAt);
        this.status(`working on task ${task.id}`);
        console.log(`[campaign task ${task.id}] Claude started making ${describe(task.choices as unknown as TaskChoices, task.instructionIndex, task.date)}`);
        // Without an API key in its environment, Claude Code runs on the user's plan. It may run until the brief's
        // deadline (a few minutes at least), since past that its film can't be used.
        return this.run(claude, args, "", {
          env: planEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]), cwd: films, timeoutMs: Math.max(deadline - startedAt, MIN_RUN_MINUTES * MIN),
          signal: abort.signal, killTree: true,
        });
      });
      if (!done) return; // a GPU shot is running: next tick
      const { code, stdout, stderr } = done.value;
      if (code !== 0 && !this.stoppedFor) {
        const words = lastWords(stdout, stderr) || `exit code ${code}`;
        console.error(`agent launcher: task ${task.id}: Claude Code failed: ${words}`);
        outcome = `last run failed: ${words}`;
      }
    } catch (err) {
      if (!this.stoppedFor) {
        console.error(`agent launcher: task ${task.id}: ${(err as Error).message}`);
        outcome = `last run failed: ${(err as Error).message}`;
      }
    } finally {
      // It may hold the app password, so it's only on disk while Claude runs.
      rmSync(mcpConfig, { force: true });
      const released = startedAt !== undefined && this.release(task.id, startedAt);
      if (startedAt !== undefined) console.log(`[campaign task ${task.id}] ${this.ending(task.id, startedAt, outcome)}`);
      if (this.stoppedFor) this.status(`stopped: ${this.stoppedFor}`);
      else if (outcome) this.status(outcome);
      else if (startedAt !== undefined) this.status(released ? `finished without a film (task ${task.id})` : "idle");
      this.controller = undefined;
      this.current = undefined;
      this.stoppedFor = undefined;
      this.running = false;
    }
  }

  /** The Console's last word on a launch: finished (the film was delivered), gave up, stopped, failed, or no film. */
  private ending(taskId: number, startedAt: number, outcome: string | undefined): string {
    const took = `after ${Math.max(1, Math.round((this.now() - startedAt) / MIN))} min`;
    const t = this.campaigns.task(taskId);
    const c = t?.choices as unknown as TaskChoices | undefined;
    if (c?.delivery || (t && ["editing", "reviewing", "scheduled", "posted", "kept"].includes(t.state))) {
      return `Claude finished the film (100% complete) ${took}; it goes to review`;
    }
    if (t?.state === "failed") return `Claude stopped ${took} without a film: ${t.error ?? "it gave up"}`;
    if (this.stoppedFor) return `Claude was stopped ${took}: ${this.stoppedFor}`;
    if (outcome) return `Claude's run ended ${took} without a film: ${outcome.replace(/^last run failed: /, "")}`;
    return `Claude's run ended ${took} without a film; the brief is offered again`;
  }

  /** FreePoster's MCP server as Claude Code reads it, with the app password when one is set. */
  private writeMcpConfig(path: string) {
    // The address the server listens on, so nothing goes through a public tunnel set as BASE_URL.
    const server: Record<string, unknown> = { type: "http", url: `http://127.0.0.1:${config.port}/mcp?tools=${BRIEF_TOOLS.join(",")}` };
    // The server takes the password as Basic auth with any user name, as the browser sends it.
    if (config.appPassword) server.headers = { Authorization: `Basic ${Buffer.from(`freeposter:${config.appPassword}`).toString("base64")}` };
    writeFileSync(path, JSON.stringify({ mcpServers: { freeposter: server } }, null, 2), { mode: 0o600 });
  }
}

/** A launch's film as the Console names it: its look, campaign, table row and slot. */
function describe(c: TaskChoices, instructionIndex: number, date: string): string {
  const look = c.brief?.look ?? "film";
  const row = instructionIndex >= ROW_INSTRUCTION_BASE ? `, row ${rowIdHex(instructionIndex - ROW_INSTRUCTION_BASE)}` : "";
  const slot = c.postTime ? ` for ${date} ${c.postTime}` : "";
  return `the ${look} film (campaign "${c.campaignName}"${row}${slot}): 0% complete`;
}

/**
 * What the campaign worker calls when campaigns stop: the kill switch (null) ends any running launch, and Stop
 * Campaign ends it only when its task is that campaign's.
 */
export function abortOnStop(launcher: AgentLauncher): (campaignId: number | null) => void {
  return (campaignId) => {
    const running = launcher.runningFor();
    if (!running) return;
    if (campaignId === null) launcher.abort("campaigns were stopped");
    else if (running.campaignId === campaignId) launcher.abort("its campaign was stopped");
  };
}

/** What the campaign worker calls for each task its changed row replaced: a launch running for that task is ended. */
export function abortOnRetire(launcher: AgentLauncher): (taskId: number) => void {
  return (taskId) => {
    if (launcher.runningFor()?.taskId === taskId) launcher.abort("its row was changed");
  };
}
