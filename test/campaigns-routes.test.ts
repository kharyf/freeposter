import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AiService } from "../src/ai/router.ts";
import { applyAgentChange, campaignVocabulary } from "../src/campaigns/autorun.ts";
import { DAYS, type CompiledCampaign } from "../src/campaigns/spec.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import type { CampaignWorker } from "../src/campaigns/worker.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { newStore, tmp } from "./helpers.ts";

const emptyDays = () => Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"];

function setup(ai: Pick<AiService, "ask"> | null = null) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const calls = { stop: 0, resume: 0 };
  const worker = {
    campaigns: cs, ai,
    stopAll() { calls.stop++; cs.setKilled(true); return 2; },
    resumeAll() { calls.resume++; cs.setKilled(false); return 3; },
  } as unknown as CampaignWorker;
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers, {}, undefined, undefined, undefined, undefined, worker);
  const hook = cs.addEntry({ kind: "hook", name: "Stop Scrolling", text: "Stop scrolling" });
  const cta = cs.addEntry({ kind: "cta", name: "Free Guide", text: "Get the guide", url: "https://example.com/guide" });
  const campaignId = cs.create({ name: "Weekday Growth", text: "On Tuesday make 1 Basic video with Stop Scrolling hook and Free Guide cta.", accountSetId: null, defaultPostTimes: ["09:00"] });
  const compiled = (entry = hook): CompiledCampaign => ({
    version: 1,
    days: { ...emptyDays(), tue: [{ kind: "make", count: 1, style: "basic", hook: { pick: "named", id: entry }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, types: [], post: { at: "default" }, source: "x" }] },
    rules: [],
  });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as "GET", url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { store, cs, app, calls, hook, cta, campaignId, compiled, send };
}

test("campaigns: create, list, and the settings routes", async () => {
  const { send, cs } = setup();
  let res = await send("POST", "/api/campaigns", { name: "Second", text: "hello", defaultPostTimes: ["18:30", "09:00"], dailyPostCap: 2 });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().id as number;
  assert.equal(cs.campaign(id)!.dailyPostCap, 2);
  assert.deepEqual(cs.campaign(id)!.defaultPostTimes, ["09:00", "18:30"]);

  res = await send("GET", "/api/campaigns");
  const body = res.json();
  assert.equal(body.killed, false);
  assert.ok(body.ai.budgeted);
  assert.equal(body.campaigns.length, 2);
  const c = body.campaigns.find((x: any) => x.id === id);
  assert.equal(c.name, "Second");
  assert.equal(c.text, "hello");
  assert.equal(c.runnable, false);
  assert.equal(c.autorun, false);
  assert.equal(c.enabled, true);
  assert.ok(c.textSha);

  assert.equal((await send("PUT", `/api/campaigns/${id}/enabled`, { on: false })).statusCode, 200);
  assert.equal(cs.campaign(id)!.enabled, false);
  assert.equal((await send("PUT", `/api/campaigns/${id}/autorun`, { on: true })).statusCode, 200);
  assert.equal(cs.campaign(id)!.autorun, true);
  assert.equal((await send("PUT", `/api/campaigns/${id}/cap`, { cap: 5 })).statusCode, 200);
  assert.equal(cs.campaign(id)!.dailyPostCap, 5);
  assert.equal((await send("PUT", `/api/campaigns/${id}/account-set`, { accountSetId: 1 })).statusCode, 200);
  assert.equal(cs.campaign(id)!.accountSetId, 1);
  assert.equal((await send("PUT", `/api/campaigns/${id}/post-times`, { times: ["07:15", "21:00"] })).statusCode, 200);
  assert.deepEqual(cs.campaign(id)!.defaultPostTimes, ["07:15", "21:00"]);

  // validation: 400 with an error; unknown ids: 404
  for (const [url, payload] of [
    ["/api/campaigns", { name: "" }], ["/api/campaigns", { name: "x", defaultPostTimes: ["25:00"] }], ["/api/campaigns", { name: "x", accountSetId: 99 }],
    [`/api/campaigns/${id}/enabled`, { on: "yes" }], [`/api/campaigns/${id}/autorun`, {}], [`/api/campaigns/${id}/cap`, { cap: 0 }],
    [`/api/campaigns/${id}/account-set`, { accountSetId: 99 }], [`/api/campaigns/${id}/post-times`, { times: ["6pm"] }], [`/api/campaigns/${id}/post-times`, { times: "09:00" }],
  ] as const) {
    res = await send(url.endsWith("campaigns") ? "POST" : "PUT", url, payload);
    assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
    assert.ok(res.json().error);
  }
  assert.equal((await send("PUT", "/api/campaigns/999/enabled", { on: true })).statusCode, 404);
  assert.equal((await send("PUT", "/api/campaigns/999/text", { text: "x" })).statusCode, 404);
  assert.equal((await send("POST", "/api/campaigns/999/confirm", { compiled: {}, textSha: "x" })).statusCode, 404);
  assert.equal((await send("GET", "/api/campaigns/999/tasks")).statusCode, 404);
});

test("text → preview (not confirmed) → confirm, refusing a stale textSha and an invalid schedule", async () => {
  const { send, cs, campaignId, compiled } = setup();
  const text = "On Tuesday make 1 Basic video with Stop Scrolling hook and Free Guide cta.\nfrobnicate the widgets";
  let res = await send("PUT", `/api/campaigns/${campaignId}/text`, { text });
  assert.equal(res.statusCode, 200, res.body);
  const preview = res.json();
  assert.equal(preview.compiled.version, 1);
  assert.equal(preview.compiled.days.tue.length, 1);
  assert.deepEqual(preview.couldNotUnderstand, ["frobnicate the widgets"]);
  assert.equal(preview.textSha, cs.campaign(campaignId)!.textSha);
  assert.equal(cs.campaign(campaignId)!.text, text);
  assert.equal(cs.campaign(campaignId)!.compiled, null, "previewing never confirms");
  assert.equal(cs.isRunnable(cs.campaign(campaignId)!), false);

  // a schedule compiled from older text is refused, whatever it contains
  res = await send("POST", `/api/campaigns/${campaignId}/confirm`, { compiled: preview.compiled, textSha: "0".repeat(64) });
  assert.equal(res.statusCode, 409);
  assert.ok(res.json().error);
  assert.equal(cs.campaign(campaignId)!.compiled, null);

  // the text was edited again after this preview was shown
  await send("PUT", `/api/campaigns/${campaignId}/text`, { text: `${text} more` });
  res = await send("POST", `/api/campaigns/${campaignId}/confirm`, { compiled: preview.compiled, textSha: preview.textSha });
  assert.equal(res.statusCode, 409);

  // an invalid schedule is a 400 with its problems
  const current = cs.campaign(campaignId)!.textSha;
  res = await send("POST", `/api/campaigns/${campaignId}/confirm`, { compiled: { version: 1, days: {}, rules: [], extra: 1 }, textSha: current });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json().problems.length > 0);
  assert.equal(cs.campaign(campaignId)!.compiled, null);

  // a good one confirms and the campaign becomes runnable
  res = await send("POST", `/api/campaigns/${campaignId}/confirm`, { compiled: compiled(), textSha: current });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().runnable, true);
  assert.equal(cs.isRunnable(cs.campaign(campaignId)!), true);

  assert.equal((await send("PUT", `/api/campaigns/${campaignId}/text`, { text: 5 })).statusCode, 400);
  assert.equal((await send("POST", `/api/campaigns/${campaignId}/confirm`, { compiled: compiled() })).statusCode, 400);
});

test("text falls back to the AI for lines the plain parser can't read", async () => {
  const asked: string[] = [];
  const ai = { ask: async (_job: string, req: { prompt: string }) => { asked.push(req.prompt); return { lines: [] }; } } as unknown as Pick<AiService, "ask">;
  const { send, campaignId } = setup(ai);
  const res = await send("PUT", `/api/campaigns/${campaignId}/text`, { text: "something odd" });
  assert.equal(res.statusCode, 200);
  assert.equal(asked.length, 1);
  assert.deepEqual(res.json().couldNotUnderstand, ["something odd"]);
});

test("tasks by date, the change log, and undo (refused with 409 once undone)", async () => {
  const { send, cs, store, campaignId, compiled, hook } = setup();
  cs.confirm(campaignId, compiled());
  cs.setAutorun(campaignId, true);
  cs.addTask({ campaignId, date: "2026-11-17", dayIndex: 2, instructionIndex: 0, kind: "make" });

  let res = await send("GET", `/api/campaigns/${campaignId}/tasks?date=2026-11-17`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tasks.length, 1);
  assert.equal(res.json().tasks[0].state, "queued");
  assert.equal((await send("GET", `/api/campaigns/${campaignId}/tasks?date=2026-11-18`)).json().tasks.length, 0);
  assert.equal((await send("GET", `/api/campaigns/${campaignId}/tasks`)).statusCode, 200); // today
  assert.equal((await send("GET", `/api/campaigns/${campaignId}/tasks?date=tomorrow`)).statusCode, 400);

  const r = await applyAgentChange(cs, campaignId, { dailyPostCap: 2 }, "agent-x", "fewer posts", campaignVocabulary(store, cs), { ai: null });
  assert.ok(r.ok);
  res = await send("GET", `/api/campaigns/${campaignId}/changes`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().changes.length, 1);
  assert.equal(res.json().changes[0].agent, "agent-x");
  assert.equal(res.json().changes[0].reason, "fewer posts");
  assert.equal(res.json().changes[0].undoneAt, null);
  const changeId = res.json().changes[0].id;

  res = await send("POST", `/api/campaigns/changes/${changeId}/undo`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(cs.campaign(campaignId)!.dailyPostCap, 3);
  res = await send("POST", `/api/campaigns/changes/${changeId}/undo`);
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already undone/);
  assert.equal((await send("POST", "/api/campaigns/changes/999/undo")).statusCode, 404);
  assert.ok(hook);
});

test("stop, resume and status call the worker", async () => {
  const { send, calls } = setup();
  assert.deepEqual((await send("GET", "/api/campaigns/status")).json(), { killed: false });
  let res = await send("POST", "/api/campaigns/stop");
  assert.equal(res.statusCode, 200);
  assert.equal(calls.stop, 1);
  assert.equal(res.json().held, 2);
  assert.deepEqual((await send("GET", "/api/campaigns/status")).json(), { killed: true });
  res = await send("POST", "/api/campaigns/resume");
  assert.equal(res.statusCode, 200);
  assert.equal(calls.resume, 1);
  assert.equal(res.json().released, 3);
  assert.deepEqual((await send("GET", "/api/campaigns/status")).json(), { killed: false });
});

test("library: list, add, edit, validate, and refuse deleting what is in use", async () => {
  const { send, cs, campaignId, compiled, hook, cta } = setup();
  let res = await send("GET", "/api/library");
  assert.equal(res.json().entries.length, 2);
  assert.equal((await send("GET", "/api/library?kind=cta")).json().entries[0].url, "https://example.com/guide");
  assert.equal((await send("GET", "/api/library?kind=x")).statusCode, 400);

  res = await send("POST", "/api/library", { kind: "angle", name: "Myth", text: "Myth-bust", keywords: ["myth"] });
  assert.equal(res.statusCode, 200, res.body);
  const angle = res.json().id as number;
  assert.deepEqual(cs.entry(angle)!.keywords, ["myth"]);

  for (const bad of [
    { kind: "cta", name: "x", text: "y" }, { kind: "cta", name: "x", text: "y", url: "ftp://a.b/c" }, { kind: "cta", name: "x", text: "y", url: "not a url" },
    { kind: "hook", name: "", text: "y" }, { kind: "hook", name: "x", text: "" }, { kind: "video", name: "x", text: "y" }, { kind: "hook", name: "x", text: "y", keywords: "a" },
  ]) {
    res = await send("POST", "/api/library", bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.ok(res.json().error);
  }
  assert.equal((await send("POST", "/api/library", { kind: "cta", name: "Doc", text: "Read", url: "http://example.com/doc" })).statusCode, 200);

  res = await send("PUT", `/api/library/${angle}`, { name: "Myth 2", text: "New" });
  assert.equal(res.statusCode, 200);
  assert.equal(cs.entry(angle)!.name, "Myth 2");
  assert.equal((await send("PUT", `/api/library/${cta}`, { url: "javascript:alert(1)" })).statusCode, 400);
  assert.equal((await send("PUT", `/api/library/${cta}`, { url: "https://example.com/new" })).statusCode, 200);
  assert.equal((await send("PUT", "/api/library/999", { name: "x" })).statusCode, 404);
  assert.equal((await send("DELETE", "/api/library/999")).statusCode, 404);

  // used by a confirmed schedule → 409, and still there
  cs.confirm(campaignId, compiled());
  res = await send("DELETE", `/api/library/${hook}`);
  assert.equal(res.statusCode, 409);
  assert.ok(res.json().error);
  assert.ok(cs.entry(hook));

  // used by a task in flight → 409; once the task is over it can go
  const spare = cs.addEntry({ kind: "hook", name: "Spare", text: "Spare" });
  const task = cs.addTask({ campaignId, date: "2026-11-17", dayIndex: 2, instructionIndex: 0, kind: "make", choices: { hook: { id: spare } }, state: "rendering" })!;
  assert.equal((await send("DELETE", `/api/library/${spare}`)).statusCode, 409);
  cs.updateTask(task, { state: "posted" });
  assert.equal((await send("DELETE", `/api/library/${spare}`)).statusCode, 200);
  assert.equal(cs.entry(spare), undefined);

  // unused deletes
  assert.equal((await send("DELETE", `/api/library/${angle}`)).statusCode, 200);
});

test("types: list, add, switch Post without approval", async () => {
  const { send, cs } = setup();
  let res = await send("POST", "/api/types", { name: "Promo", color: "#ff8800" });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().id as number;
  assert.equal(cs.types()[0].autoPost, false);
  res = await send("GET", "/api/types");
  assert.deepEqual(res.json().types.map((t: any) => [t.id, t.name, t.color, t.autoPost]), [[id, "Promo", "#ff8800", false]]);
  assert.equal((await send("PUT", `/api/types/${id}/auto-post`, { on: true })).statusCode, 200);
  assert.equal(cs.types()[0].autoPost, true);

  for (const bad of [{ name: "", color: "#fff000" }, { name: "x", color: "red" }, { name: "promo", color: "#000000" }]) {
    res = await send("POST", "/api/types", bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.ok(res.json().error);
  }
  assert.equal((await send("PUT", `/api/types/${id}/auto-post`, { on: "yes" })).statusCode, 400);
  assert.equal((await send("PUT", "/api/types/999/auto-post", { on: true })).statusCode, 404);
});
