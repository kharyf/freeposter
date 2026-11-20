import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ProgramRun } from "../src/ai/cli.ts";
import { LEASE_MINUTES, buildBrief } from "../src/campaigns/briefs.ts";
import { AgentLauncher } from "../src/campaigns/launcher.ts";
import type { Look } from "../src/campaigns/looks.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import type { TaskChoices } from "../src/campaigns/worker.ts";
import { config } from "../src/config.ts";
import { newStore, tmp } from "./helpers.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 19, 8, 0);
const look: Look = { key: "lemo:ukiyo-e", producer: "lemo-opuscar", name: "Ukiyo-e", description: "", needsImageGen: false, libraryVersion: "1", hidden: false };

interface Call { cmd: string; args: string[]; opts?: Parameters<ProgramRun>[3] }

function setup(opts: { enabled?: boolean; claude?: string } = {}) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const campaignId = cs.create({ name: "Films", text: "x", accountSetId: null, defaultPostTimes: [] });
  const choices = {
    instruction: { kind: "make", count: 1, style: null, look: look.key, sec: 30, hook: { kind: "random" }, angle: { kind: "random" }, cta: { kind: "random" }, types: [], post: null, source: "" },
    campaignName: "Films", day: "Thu", style: null, types: [], postTime: null, accountSetId: null,
  } as unknown as TaskChoices;
  const brief = buildBrief(store, choices, look, T0 + 10 * 3_600_000, T0);
  const add = (n: number) => cs.addTask({ campaignId, date: "2026-11-19", dayIndex: 4, instructionIndex: n, kind: "make", choices: { ...choices, brief }, state: "awaiting_agent" })!;
  if (opts.enabled !== false) store.setPref("agent.launch.enabled", true);
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
  });
  return { store, cs, add, launcher, calls, gpu, clock, dir, finish: (r: { code: number | null; stdout: string; stderr: string }) => finish(r) };
}

test("does nothing when disabled", async () => {
  const s = setup({ enabled: false });
  s.add(1);
  await s.launcher.tick();
  assert.equal(s.calls.length, 0);
  s.store.setPref("agent.launch.enabled", "yes"); // only true turns it on
  await s.launcher.tick();
  assert.equal(s.calls.length, 0);
});

test("a disabled launcher says it's off, once", async () => {
  const s = setup({ enabled: false });
  await s.launcher.tick();
  assert.equal(s.store.pref("agent.launch.status"), "off");
  let writes = 0;
  const set = s.store.setPref.bind(s.store);
  s.store.setPref = (k, v) => { if (k === "agent.launch.status") writes++; set(k, v); };
  await s.launcher.tick();
  s.store.setPref("agent.launch.enabled", true);
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
  assert.deepEqual(args.slice(2), ["--mcp-config", mcpPath, "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Write,Edit,Skill,mcp__freeposter__*"]);
  assert.equal(opts?.cwd, join(s.dir, "films"));
  assert.ok(existsSync(join(s.dir, "films")));
  assert.equal(opts?.timeoutMs, LEASE_MINUTES * MIN);
  assert.equal(opts?.env?.ANTHROPIC_API_KEY, undefined);
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  assert.deepEqual(mcp.mcpServers.freeposter.type, "http");
  // Always the local address the server listens on, never a public tunnel in BASE_URL.
  assert.equal(mcp.mcpServers.freeposter.url, `http://127.0.0.1:${config.port}/mcp`);
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
