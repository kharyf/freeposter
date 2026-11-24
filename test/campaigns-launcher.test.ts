import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ProgramRun } from "../src/ai/cli.ts";
import { LEASE_MINUTES, buildBrief, claimBrief, openBriefs } from "../src/campaigns/briefs.ts";
import { AgentLauncher, abortOnRetire, abortOnStop, agentFor, findLemoSkill } from "../src/campaigns/launcher.ts";
import type { Look } from "../src/campaigns/looks.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import type { TaskChoices } from "../src/campaigns/worker.ts";
import { config } from "../src/config.ts";
import { newStore, tmp } from "./helpers.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 19, 8, 0);
const look: Look = { key: "lemo:ukiyo-e", producer: "lemo-opuscar", name: "Ukiyo-e", description: "", needsImageGen: false, libraryVersion: "1", category: null, hidden: false };

interface Call { cmd: string; args: string[]; opts?: Parameters<ProgramRun>[3] }

/** Connects Claude under AI Providers: that alone has FreePoster start Claude Code for open briefs. */
const connectClaude = (store: { setPref(k: string, v: unknown): void }) => store.setPref("ai.providers", { claude: { plan: null, connectedAt: 1 } });

function setup(opts: { enabled?: boolean; claude?: string; agy?: string; skill?: string; home?: string } = {}) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const campaignId = cs.create({ name: "Films", text: "x", accountSetId: null, defaultPostTimes: [] });
  const choices = {
    instruction: { kind: "make", count: 1, style: null, look: look.key, sec: 30, hook: { kind: "random" }, angle: { kind: "random" }, cta: { kind: "random" }, types: [], post: null, source: "" },
    campaignName: "Films", day: "Thu", style: null, types: [], postTime: null, accountSetId: null,
  } as unknown as TaskChoices;
  const brief = buildBrief(store, choices, look, T0 + 10 * 3_600_000, T0);
  const add = (n: number) => cs.addTask({ campaignId, date: "2026-11-19", dayIndex: 4, instructionIndex: n, kind: "make", choices: { ...choices, brief }, state: "awaiting_agent" })!;
  if (opts.enabled !== false) connectClaude(store);
  const calls: Call[] = [];
  let finish: (r: { code: number | null; stdout: string; stderr: string }) => void = () => {};
  const run: ProgramRun = (cmd, args, _stdin, o) => {
    calls.push({ cmd, args, opts: o });
    return new Promise((resolve) => (finish = resolve));
  };
  const gpu: string[] = [];
  const borrowGpu = async <T>(fn: () => Promise<T>) => { gpu.push("borrowed"); return { value: await fn() }; };
  const clock = { now: T0 };
  const dir = tmp();
  const launcher = new AgentLauncher({
    store, campaigns: cs, run, borrowGpu, now: () => clock.now, dataDir: dir,
    find: () => opts.claude ?? "C:\\bin\\claude.exe",
    findAgy: () => opts.agy ?? "C:\\bin\\agy.exe", lemoSkill: () => opts.skill ?? "", home: opts.home ?? tmp(),
  });
  return { store, cs, add, campaignId, launcher, calls, gpu, clock, dir, finish: (r: { code: number | null; stdout: string; stderr: string }) => finish(r) };
}

/** A launcher whose Claude runs until it's aborted, and what it was given. */
function abortable(s: ReturnType<typeof setup>) {
  const seen: { signal?: AbortSignal } = {};
  const launcher = new AgentLauncher({
    store: s.store, campaigns: s.cs, now: () => s.clock.now, dataDir: s.dir, find: () => "claude",
    borrowGpu: async (fn) => ({ value: await fn() }),
    run: (_c, _a, _s, o) => new Promise((_resolve, reject) => {
      seen.signal = o?.signal;
      o?.signal?.addEventListener("abort", () => reject(new Error("claude was stopped")));
    }),
  });
  return { launcher, seen };
}

test("the kill switch aborts a running launch", async () => {
  const s = setup();
  s.add(1);
  const { launcher, seen } = abortable(s);
  const onStop = abortOnStop(launcher);
  const running = launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.signal?.aborted, false);
  onStop(null);
  await running;
  assert.equal(seen.signal?.aborted, true);
  assert.match(String(s.store.pref("agent.launch.status")), /^stopped: /);
});

test("Stop Campaign aborts a running launch only for its own campaign", async () => {
  const s = setup();
  s.add(1);
  const { launcher, seen } = abortable(s);
  const onStop = abortOnStop(launcher);
  const running = launcher.tick();
  await new Promise((r) => setImmediate(r));
  onStop(s.campaignId + 1);
  assert.equal(seen.signal?.aborted, false, "another campaign's stop leaves it running");
  onStop(s.campaignId);
  await running;
  assert.equal(seen.signal?.aborted, true);
  assert.equal(launcher.abort("nothing running"), false);
});

test("abortOnRetire stops the run only for its own task", async () => {
  const s = setup();
  const id = s.add(1);
  const { launcher, seen } = abortable(s);
  const onRetire = abortOnRetire(launcher);
  const running = launcher.tick();
  await new Promise((r) => setImmediate(r));
  onRetire(id + 1);
  assert.equal(seen.signal?.aborted, false, "another task's retirement leaves it running");
  onRetire(id);
  await running;
  assert.equal(seen.signal?.aborted, true);
  assert.equal(s.store.pref("agent.launch.status"), "stopped: its row was changed");
  onRetire(id); // nothing running: nothing happens
});

test("a launch that ends without a film releases the lease it took, and gives the offer back", async () => {
  const s = setup();
  const id = s.add(1);
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  // Claude claims the brief, then stops without delivering.
  s.clock.now += MIN;
  const lease = claimBrief(s.cs, id, "claude-code", s.clock.now);
  assert.ok(lease.ok);
  assert.equal((s.cs.task(id)!.choices as any).offers, 1);
  s.clock.now += MIN;
  s.finish({ code: 0, stdout: "I couldn't", stderr: "" });
  await running;
  const c = s.cs.task(id)!.choices as any;
  assert.equal(c.lease, undefined, "the run's lease is released");
  assert.equal(c.offers, 0, "the run's claim didn't use up an offer");
  assert.deepEqual(openBriefs(s.cs, s.clock.now).map((t) => t.id), [id]);
  assert.equal(s.store.pref("agent.launch.status"), `finished without a film (task ${id})`);
});

test("a launch's timeout is the time left to the brief's deadline, at least 5 minutes", async () => {
  const s = setup();
  s.add(1);
  s.clock.now = T0 + 10 * 60 * MIN - 30 * MIN - 2 * MIN; // 2 minutes before the deadline
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls[0].opts?.timeoutMs, 5 * MIN);
  s.finish({ code: 0, stdout: "", stderr: "" });
  await running;
});

test("does nothing while Claude isn't connected", async () => {
  const s = setup({ enabled: false });
  s.add(1);
  await s.launcher.tick();
  assert.equal(s.calls.length, 0);
  s.store.setPref("ai.providers", { openrouter: { plan: null, connectedAt: 1 } }); // another provider doesn't start Claude
  await s.launcher.tick();
  assert.equal(s.calls.length, 0);
  connectClaude(s.store);
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 1, "connecting Claude is all it takes");
  s.finish({ code: 0, stdout: "", stderr: "" });
  await running;
});

test("without Claude connected the launcher says so, once", async () => {
  const s = setup({ enabled: false });
  await s.launcher.tick();
  assert.equal(s.store.pref("agent.launch.status"), "Neither Claude nor Google AI is connected under AI Providers");
  let writes = 0;
  const set = s.store.setPref.bind(s.store);
  s.store.setPref = (k, v) => { if (k === "agent.launch.status") writes++; set(k, v); };
  await s.launcher.tick();
  connectClaude(s.store);
  await s.launcher.tick(); // nothing open: idle
  await s.launcher.tick();
  assert.equal(s.store.pref("agent.launch.status"), "idle");
  assert.equal(writes, 1);
});

test("stop aborts a running launch", async () => {
  const s = setup();
  s.add(1);
  let seen: AbortSignal | undefined;
  const launcher = new AgentLauncher({
    store: s.store, campaigns: s.cs, now: () => s.clock.now, dataDir: s.dir, find: () => "claude",
    borrowGpu: async (fn) => ({ value: await fn() }),
    run: (_c, _a, _s, o) => new Promise((_resolve, reject) => {
      seen = o?.signal;
      assert.equal(o?.killTree, true);
      o?.signal?.addEventListener("abort", () => reject(new Error("claude was stopped")));
    }),
  });
  const running = launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen?.aborted, false);
  launcher.stop();
  await running;
  assert.equal(seen?.aborted, true);
  assert.equal(s.store.pref("agent.launch.status"), "last run failed: claude was stopped");
});

test("a run that throws or times out is shown as failed", async () => {
  const s = setup();
  s.add(1);
  const launcher = new AgentLauncher({
    store: s.store, campaigns: s.cs, now: () => s.clock.now, dataDir: s.dir, find: () => "claude",
    borrowGpu: async (fn) => ({ value: await fn() }),
    run: async () => { throw new Error("it didn't answer within 120 minutes"); },
  });
  await launcher.tick();
  assert.equal(s.store.pref("agent.launch.status"), "last run failed: it didn't answer within 120 minutes");
  assert.ok(!existsSync(join(s.dir, "agent-mcp.json")));
});

test("skips when claude isn't installed", async () => {
  const s = setup({ claude: "" });
  s.add(1);
  await s.launcher.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.store.pref("agent.launch.status"), "Claude Code not found");
});

test("launches once for an open brief and not again while running", async () => {
  const s = setup();
  const first = s.add(1);
  const second = s.add(2);
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  await s.launcher.tick();
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.gpu, ["borrowed"]);
  const { cmd, args, opts } = s.calls[0];
  assert.equal(cmd, "C:\\bin\\claude.exe");
  assert.equal(args[0], "-p");
  const mcpPath = join(s.dir, "agent-mcp.json");
  assert.deepEqual(args.slice(2), ["--mcp-config", mcpPath, "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Write,Edit,Skill,mcp__freeposter__list_briefs,mcp__freeposter__claim_brief,mcp__freeposter__renew_brief,mcp__freeposter__submit_brief,mcp__freeposter__give_up_brief"], "a brief with a null model passes no --model");
  assert.ok(!args.join(" ").includes("mcp__freeposter__*"), "only the brief tools, never all of FreePoster's");
  assert.equal(opts?.cwd, join(s.dir, "films"));
  assert.ok(existsSync(join(s.dir, "films")));
  assert.equal(opts?.timeoutMs, 10 * 60 * MIN - 30 * MIN, "the run may last until the brief's deadline");
  assert.equal(opts?.env?.ANTHROPIC_API_KEY, undefined);
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  assert.deepEqual(mcp.mcpServers.freeposter.type, "http");
  // Always the local address the server listens on, never a public tunnel in BASE_URL.
  assert.equal(mcp.mcpServers.freeposter.url, `http://127.0.0.1:${config.port}/mcp?tools=list_briefs,claim_brief,renew_brief,submit_brief,give_up_brief`);
  assert.equal(s.store.pref("agent.launch.status"), `working on task ${first}`);

  s.finish({ code: 0, stdout: "done", stderr: "" });
  await running;
  assert.equal(s.store.pref("agent.launch.status"), "idle");
  assert.ok(!existsSync(mcpPath), "the MCP config is removed after the run");
  // The first brief isn't claimed by the stub, so it's still open: not launched again within the lease time.
  const next = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 2);
  assert.ok(s.calls[1].args[1].includes(`task ${second}`));
  s.finish({ code: 0, stdout: "", stderr: "" });
  await next;
});

test("the prompt names the task id", async () => {
  const s = setup();
  const id = s.add(1);
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  const prompt = s.calls[0].args[1];
  assert.ok(prompt.includes(`task ${id}`));
  assert.ok(!prompt.includes("{{task_id}}"));
  assert.match(prompt, /claim_brief/);
  assert.match(prompt, /lemo-opuscar/);
  assert.match(prompt, /renew_brief/);
  assert.match(prompt, /submit_brief/);
  assert.match(prompt, /give_up_brief/);
  assert.match(prompt, /claim_token/);
  assert.match(prompt, /caption must include that link/);
  assert.match(prompt, /don't call FreePoster's start_production, create_edit/);
  s.finish({ code: 0, stdout: "", stderr: "" });
  await running;
});

test("a failed run is shown and not relaunched until the lease time has passed", async () => {
  const s = setup();
  s.add(1);
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  s.finish({ code: 1, stdout: "", stderr: "line one\nauth failed" });
  await running;
  assert.equal(s.store.pref("agent.launch.status"), "last run failed: line one auth failed");
  await s.launcher.tick();
  assert.equal(s.calls.length, 1);
  s.clock.now += LEASE_MINUTES * MIN + MIN;
  const again = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 2);
  s.finish({ code: 0, stdout: "", stderr: "" });
  await again;
});

test("a busy GPU waits for the next tick", async () => {
  const s = setup();
  s.add(1);
  let busy = true;
  let ran = 0;
  const launcher = new AgentLauncher({
    store: s.store, campaigns: s.cs, run: async () => { ran++; return { code: 0, stdout: "", stderr: "" }; },
    borrowGpu: async (fn) => (busy ? null : { value: await fn() }), now: () => s.clock.now, dataDir: s.dir, find: () => "claude",
  });
  await launcher.tick();
  assert.equal(ran, 0);
  busy = false;
  await launcher.tick();
  assert.equal(ran, 1);
});

test("the MCP config carries the app password when one is set", async () => {
  const s = setup();
  s.add(1);
  const before = config.appPassword;
  config.appPassword = "s3cret";
  try {
    const running = s.launcher.tick();
    await new Promise((r) => setImmediate(r));
    const mcp = JSON.parse(readFileSync(join(s.dir, "agent-mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.freeposter.headers.Authorization, `Basic ${Buffer.from("freeposter:s3cret").toString("base64")}`);
    s.finish({ code: 0, stdout: "", stderr: "" });
    await running;
  } finally {
    config.appPassword = before;
  }
});

test("starts Claude Code with the brief's model", async () => {
  const s = setup();
  const id = s.add(1);
  const t = s.cs.task(id)!;
  const c = t.choices as unknown as TaskChoices;
  s.cs.updateTask(id, { choices: { ...t.choices, brief: { ...c.brief!, model: "claude:claude-haiku-5-5" } } });
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  const args = s.calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "claude-haiku-5-5");
  s.finish({ code: 0, stdout: "", stderr: "" });
  await running;

  // With no model on the brief (or a brief made before briefs had one), no --model: Claude Code's own setting.
  const d = setup();
  const old = d.add(1);
  const o = d.cs.task(old)!;
  const { model: _gone, ...brief } = (o.choices as unknown as TaskChoices).brief!;
  d.cs.updateTask(old, { choices: { ...o.choices, brief } });
  const again = d.launcher.tick();
  await new Promise((r) => setImmediate(r));
  const plain = d.calls[0].args;
  assert.equal(plain.includes("--model"), false);
  d.finish({ code: 0, stdout: "", stderr: "" });
  await again;
});

/** Runs fn with console.log captured: the Console tab shows what this process logs. */
async function logged(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { await fn(); } finally { console.log = log; }
  return lines;
}

test("the Console is told when Claude starts a film and when it finishes it", async () => {
  const s = setup();
  const id = s.add(100_001); // the campaign table's row 1
  const t = s.cs.task(id)!;
  s.cs.updateTask(id, { choices: { ...t.choices, postTime: "09:15" } });
  const lines = await logged(async () => {
    const running = s.launcher.tick();
    await new Promise((r) => setImmediate(r));
    // Claude delivers before its run ends.
    const now = s.cs.task(id)!;
    s.cs.updateTask(id, { choices: { ...now.choices, delivery: { path: "x.mp4", hash: "h", manifest: { look: look.key, libraryVersion: "1" } } } });
    s.clock.now += 12 * 60_000;
    s.finish({ code: 0, stdout: "", stderr: "" });
    await running;
  });
  assert.deepEqual(lines.filter((l) => l.startsWith(`[campaign task ${id}]`)), [
    `[campaign task ${id}] Claude started making the ${look.key} film (campaign "Films", row 0000001 for 2026-11-19 09:15): 0% complete`,
    `[campaign task ${id}] Claude finished the film (100% complete) after 12 min; it goes to review`,
  ]);
});

test("the Console says how a run without a film ended", async () => {
  const failed = setup();
  failed.add(1);
  const a = await logged(async () => {
    const running = failed.launcher.tick();
    await new Promise((r) => setImmediate(r));
    failed.finish({ code: 1, stdout: "", stderr: "auth failed" });
    await running;
  });
  assert.ok(a.some((l) => /Claude's run ended after 1 min without a film: auth failed$/.test(l)), a.join("\n"));

  const stopped = setup();
  stopped.add(1);
  const { launcher } = abortable(stopped);
  const b = await logged(async () => {
    const running = launcher.tick();
    await new Promise((r) => setImmediate(r));
    launcher.abort("its campaign was stopped");
    await running;
  });
  assert.ok(b.some((l) => /Claude was stopped after 1 min: its campaign was stopped$/.test(l)), b.join("\n"));
});

/** Connects Google AI under AI Providers (and Claude too when asked). */
const connectGoogle = (store: { setPref(k: string, v: unknown): void }, claude = false) =>
  store.setPref("ai.providers", { google: { plan: "free", connectedAt: 2 }, ...(claude ? { claude: { plan: null, connectedAt: 1 } } : {}) });

/** A lemo-opuscar skill folder, as Claude Code's plugin holds it. */
function skillDir(root = tmp()): string {
  const dir = join(root, "lemo-opuscar");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: lemo-opuscar\ndescription: films\n---\n");
  writeFileSync(join(dir, "scripts", "setup.sh"), "echo LIB=x\n");
  return dir;
}

/** Gives a task's brief this model. */
function setModel(s: ReturnType<typeof setup>, id: number, model: string | null) {
  const t = s.cs.task(id)!;
  const c = t.choices as unknown as TaskChoices;
  s.cs.updateTask(id, { choices: { ...t.choices, brief: { ...c.brief!, model } } });
}

test("agentFor: the brief's model picks the agent, a missing one goes to Claude first", () => {
  const both = { claude: true, google: true };
  assert.equal(agentFor("claude:claude-opus-5-5", both), "claude");
  assert.equal(agentFor("google:default", both), "google");
  assert.equal(agentFor(null, both), "claude");
  assert.equal(agentFor(undefined, { claude: false, google: true }), "google");
  assert.equal(agentFor("claude:claude-opus-5-5", { claude: false, google: true }), null, "a Claude brief waits for Claude");
  assert.equal(agentFor("google:default", { claude: true, google: false }), null);
  assert.equal(agentFor(null, { claude: false, google: false }), null);
});

test("with only Google AI connected, starts the Antigravity CLI with the skill and a workspace MCP config", async () => {
  const s = setup({ enabled: false, skill: skillDir() });
  connectGoogle(s.store);
  const id = s.add(1);
  const lines = await logged(async () => {
    const running = s.launcher.tick();
    await new Promise((r) => setImmediate(r));
    const { cmd, args, opts } = s.calls[0];
    assert.equal(cmd, "C:\\bin\\agy.exe");
    assert.equal(args[0], "-p");
    assert.ok(args[1].includes(`task ${id}`));
    assert.deepEqual(args.slice(2), ["--dangerously-skip-permissions"], "no --model for a brief without one, and no Claude Code flags");
    const films = join(s.dir, "films");
    assert.equal(opts?.cwd, films);
    assert.equal(opts?.env?.GEMINI_API_KEY, undefined);
    assert.equal(opts?.env?.GOOGLE_API_KEY, undefined);
    const mcpPath = join(films, ".agents", "mcp_config.json");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    assert.deepEqual(mcp.mcpServers.freeposter, { serverUrl: `http://127.0.0.1:${config.port}/mcp?tools=list_briefs,claim_brief,renew_brief,submit_brief,give_up_brief` });
    assert.ok(existsSync(join(films, ".agents", "skills", "lemo-opuscar", "SKILL.md")), "the skill is given as a workspace skill");
    assert.ok(existsSync(join(films, ".agents", "skills", "lemo-opuscar", "scripts", "setup.sh")));
    assert.ok(!existsSync(join(s.dir, "agent-mcp.json")), "Claude Code's config isn't written");
    assert.equal(s.store.pref("agent.launch.status"), `working on task ${id}`);
    s.finish({ code: 0, stdout: "", stderr: "" });
    await running;
    assert.ok(!existsSync(mcpPath), "the MCP config is removed after the run");
  });
  assert.ok(lines.some((l) => l.startsWith(`[campaign task ${id}] Gemini started making`)), lines.join("\n"));
  assert.ok(lines.some((l) => l.startsWith(`[campaign task ${id}] Gemini's run ended`)), lines.join("\n"));
});

test("Antigravity's MCP config carries the app password when one is set", async () => {
  const s = setup({ enabled: false, skill: skillDir() });
  connectGoogle(s.store);
  s.add(1);
  const before = config.appPassword;
  config.appPassword = "s3cret";
  try {
    const running = s.launcher.tick();
    await new Promise((r) => setImmediate(r));
    const mcp = JSON.parse(readFileSync(join(s.dir, "films", ".agents", "mcp_config.json"), "utf8"));
    assert.equal(mcp.mcpServers.freeposter.headers.Authorization, `Basic ${Buffer.from("freeposter:s3cret").toString("base64")}`);
    s.finish({ code: 0, stdout: "", stderr: "" });
    await running;
  } finally {
    config.appPassword = before;
  }
});

test("a Gemini brief runs on its model; google:default on Antigravity's own", async () => {
  const s = setup({ enabled: false, skill: skillDir() });
  connectGoogle(s.store, true);
  const id = s.add(1);
  setModel(s, id, "google:gemini-4-hydrogen-high");
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls[0].cmd, "C:\\bin\\agy.exe", "a Gemini model goes to Antigravity even with Claude connected");
  const args = s.calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "gemini-4-hydrogen-high");
  s.finish({ code: 0, stdout: "", stderr: "" });
  await running;

  const d = setup({ enabled: false, skill: skillDir() });
  connectGoogle(d.store);
  setModel(d, d.add(1), "google:default");
  const again = d.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(d.calls[0].args.includes("--model"), false);
  d.finish({ code: 0, stdout: "", stderr: "" });
  await again;
});

test("a Claude brief isn't given to Gemini; a brief Gemini can make behind it is", async () => {
  const s = setup({ enabled: false, skill: skillDir() });
  connectGoogle(s.store);
  const first = s.add(1);
  setModel(s, first, "claude:claude-opus-5-5");
  await s.launcher.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.store.pref("agent.launch.status"), "idle");
  const second = s.add(2);
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls[0].args[1].includes(`task ${second}`));
  s.finish({ code: 0, stdout: "", stderr: "" });
  await running;
});

test("says so when the Antigravity CLI or the lemo-opuscar skill is missing", async () => {
  const noAgy = setup({ enabled: false, agy: "", skill: skillDir() });
  connectGoogle(noAgy.store);
  noAgy.add(1);
  await noAgy.launcher.tick();
  assert.equal(noAgy.calls.length, 0);
  assert.equal(noAgy.store.pref("agent.launch.status"), "Antigravity CLI not found");

  const noSkill = setup({ enabled: false, skill: "" });
  connectGoogle(noSkill.store);
  noSkill.add(1);
  await noSkill.launcher.tick();
  assert.equal(noSkill.calls.length, 0);
  assert.match(String(noSkill.store.pref("agent.launch.status")), /^lemo-opuscar skill not found/);
});

test("a skill already installed for Antigravity isn't copied into the films folder", async () => {
  const home = tmp();
  const installed = skillDir(join(home, ".gemini", "config", "skills"));
  const s = setup({ enabled: false, skill: installed, home });
  connectGoogle(s.store);
  s.add(1);
  const running = s.launcher.tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(!existsSync(join(s.dir, "films", ".agents", "skills")));
  s.finish({ code: 0, stdout: "", stderr: "" });
  await running;
});

test("findLemoSkill: Antigravity's own install first, then Claude Code's newest plugin copy", () => {
  const home = tmp();
  assert.equal(findLemoSkill(home), "");
  const market = skillDir(join(home, ".claude", "plugins", "marketplaces", "lemolab", "plugin", "skills"));
  assert.equal(findLemoSkill(home), market);
  const cache = join(home, ".claude", "plugins", "cache", "lemolab", "lemo-opuscar");
  const old = skillDir(join(cache, "aaa", "skills"));
  const fresh = skillDir(join(cache, "bbb", "skills"));
  utimesSync(join(old, "SKILL.md"), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(join(fresh, "SKILL.md"), new Date(2026, 10, 1), new Date(2026, 10, 1));
  assert.equal(findLemoSkill(home), fresh);
  const own = skillDir(join(home, ".gemini", "config", "skills"));
  assert.equal(findLemoSkill(home), own);
});
