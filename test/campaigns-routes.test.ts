import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { syncLooks } from "../src/campaigns/looks.ts";
import { applyAgentChange, campaignVocabulary } from "../src/campaigns/autorun.ts";
import type { Row } from "../src/campaigns/rows.ts";
import { DAYS, type CompiledCampaign } from "../src/campaigns/spec.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import type { CampaignWorker } from "../src/campaigns/worker.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { config } from "../src/config.ts";
import { AiService } from "../src/ai/router.ts";
import { DEFAULT_CLAUDE_MODEL_ID } from "../src/claude.ts";
import { newStore, tmp } from "./helpers.ts";

const OWN = { host: `localhost:${config.port}` };

const emptyDays = () => Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"];

function setup(opts: { ai?: (store: ReturnType<typeof newStore>) => AiService } = {}) {
  const store = newStore();
  const cs = new CampaignStore(store);
  const calls = { stop: 0, resume: 0, stopOne: [] as number[], startOne: [] as number[], materialize: [] as string[] };
  const worker = {
    campaigns: cs, ai: opts.ai ? opts.ai(store) : null,
    /** Records the rows the campaign had when today's tasks were made. */
    materialize() { calls.materialize.push(JSON.stringify(cs.campaigns().map((c) => c.rows?.map((r) => r.time)))); return 0; },
    stopAll() { calls.stop++; cs.setKilled(true); return 2; },
    resumeAll() { calls.resume++; cs.setKilled(false); return 3; },
    stopCampaign(id: number) { calls.stopOne.push(id); cs.setEnabled(id, false); return 4; },
    startCampaign(id: number) { calls.startOne.push(id); cs.setEnabled(id, true); return 5; },
    retryTask(id: number) {
      const t = cs.task(id);
      if (!t) return "no such task";
      if (t.state !== "failed") return "only a failed video can be retried";
      cs.updateTask(id, { state: "queued", error: null });
      return null;
    },
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
  const row = (extra: Partial<Row> = {}): Row => ({
    id: 1, quantity: 1, hook: { pick: "named", id: hook }, angle: { pick: "random" }, cta: { pick: "named", id: cta }, style: "basic",
    type: null, time: "09:00", days: ["tue"], sec: 30, origin: "create", model: null, text: "", ...extra,
  });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as "GET", url, headers: OWN, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { store, cs, app, calls, hook, cta, campaignId, compiled, row, send };
}

test("campaigns: create, list, and the settings routes", async () => {
  const { send, cs } = setup();
  let res = await send("POST", "/api/campaigns", { name: "Second" });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().id as number;
  assert.equal(cs.campaign(id)!.dailyPostCap, 100, "the cap is hidden, a safety net only");
  assert.deepEqual(cs.campaign(id)!.defaultPostTimes, []);
  assert.deepEqual(cs.campaign(id)!.rows, []);

  res = await send("GET", "/api/campaigns");
  const body = res.json();
  assert.equal(body.killed, false);
  assert.ok(body.ai.budgeted);
  assert.equal(body.ai.max.calls, 50, "the ceiling the tab shows today's use against");
  assert.equal(body.campaigns.length, 2);
  assert.equal(body.campaigns[0].today, undefined, "today's tasks only when asked for");
  const withToday = (await send("GET", "/api/campaigns?today=1")).json();
  assert.ok(withToday.campaigns.every((x: any) => Array.isArray(x.today)), "one call brings every campaign's tasks for today");
  const c = body.campaigns.find((x: any) => x.id === id);
  assert.equal(c.name, "Second");
  assert.deepEqual(c.rows, []);
  assert.equal(c.runnable, true, "a new campaign runs (an empty table makes nothing)");
  assert.equal(c.autorun, false);
  assert.equal(c.enabled, true);
  assert.equal(c.text, undefined);
  assert.equal(c.dailyPostCap, undefined);

  assert.equal((await send("PUT", `/api/campaigns/${id}/autorun`, { on: true })).statusCode, 200);
  assert.equal(cs.campaign(id)!.autorun, true);
  assert.equal((await send("PUT", `/api/campaigns/${id}/account-set`, { accountSetId: 1 })).statusCode, 200);
  assert.equal(cs.campaign(id)!.accountSetId, 1);
  // the old settings and text routes are gone
  for (const [method, url] of [["PUT", "cap"], ["PUT", "post-times"], ["PUT", "text"], ["POST", "confirm"]] as const) {
    assert.equal((await send(method, `/api/campaigns/${id}/${url}`, {})).statusCode, 404, url);
  }

  // validation: 400 with an error; unknown ids: 404
  for (const [url, payload] of [
    ["/api/campaigns", { name: "" }], ["/api/campaigns", { name: "x", accountSetId: 99 }],
    [`/api/campaigns/${id}/enabled`, { on: "yes" }], [`/api/campaigns/${id}/autorun`, {}],
    [`/api/campaigns/${id}/account-set`, { accountSetId: 99 }], [`/api/campaigns/${id}/rows`, { rows: "x" }],
  ] as const) {
    res = await send(url.endsWith("campaigns") ? "POST" : "PUT", url, payload);
    assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)}`);
    assert.ok(res.json().error);
  }
  assert.equal((await send("PUT", "/api/campaigns/999/enabled", { on: true })).statusCode, 404);
  assert.equal((await send("PUT", "/api/campaigns/999/rows", { rows: [] })).statusCode, 404);
  assert.equal((await send("GET", "/api/campaigns/999/tasks")).statusCode, 404);
});

test("the table saves whole and runs at once; a bad one is a 400 with its problems and changes nothing", async () => {
  const { send, cs, campaignId, row, hook } = setup();
  let res = await send("PUT", `/api/campaigns/${campaignId}/rows`, { rows: [row(), row({ id: 2, origin: "drive", text: "Gatekeeping", time: "17:30", days: ["mon", "fri"], quantity: 3 })] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().rows.length, 2);
  assert.equal(res.json().runnable, true);
  const c = cs.campaign(campaignId)!;
  assert.equal(c.compiled!.days.tue.length, 1);
  assert.equal(c.compiled!.days.tue[0].kind, "make");
  assert.deepEqual([c.compiled!.days.mon[0].kind, c.compiled!.days.fri[0].kind], ["post", "post"]);

  // a row that can't run yet is kept, and left out of the schedule
  res = await send("PUT", `/api/campaigns/${campaignId}/rows`, { rows: [row({ days: [] }), row({ id: 2, origin: "drive", text: "", days: ["mon"] })] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(cs.campaign(campaignId)!.rows.length, 2);
  assert.ok(Object.values(cs.campaign(campaignId)!.compiled!.days).every((d) => d.length === 0));

  const before = JSON.stringify(cs.campaign(campaignId));
  for (const bad of [
    [row({ quantity: 0 })], [row({ quantity: 11 })], [row({ sec: 4 })], [row({ sec: 301 })], [row({ time: "9am" })],
    [row({ days: ["funday" as never] })], [row({ hook: { pick: "named", id: 999 } })], [row({ style: "nope" })], [row({ type: 42 })],
    [row({ origin: "drive", text: "has_underscore" })], [row(), row()], [{ ...row(), extra: 1 }],
  ]) {
    res = await send("PUT", `/api/campaigns/${campaignId}/rows`, { rows: bad });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.ok(res.json().problems.length > 0, JSON.stringify(bad));
  }
  assert.equal(JSON.stringify(cs.campaign(campaignId)), before);
  assert.ok(hook);
});

test("Stop Campaign and Start Campaign go through the worker", async () => {
  const { send, cs, calls, campaignId } = setup();
  let res = await send("PUT", `/api/campaigns/${campaignId}/enabled`, { on: false });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(calls.stopOne, [campaignId]);
  assert.equal(res.json().held, 4);
  assert.equal(res.json().enabled, false);
  assert.equal(cs.campaign(campaignId)!.enabled, false);
  res = await send("PUT", `/api/campaigns/${campaignId}/enabled`, { on: true });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.startOne, [campaignId]);
  assert.equal(res.json().released, 5);
  assert.equal(cs.campaign(campaignId)!.enabled, true);
});

test("tasks by date, the change log, and undo (refused with 409 once undone)", async () => {
  const { send, cs, store, campaignId, row, hook } = setup();
  cs.setRows(campaignId, [row()]);
  cs.setAutorun(campaignId, true);
  cs.addTask({ campaignId, date: "2026-11-17", dayIndex: 2, instructionIndex: 0, kind: "make" });

  let res = await send("GET", `/api/campaigns/${campaignId}/tasks?date=2026-11-17`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tasks.length, 1);
  assert.equal(res.json().tasks[0].state, "queued");
  assert.equal((await send("GET", `/api/campaigns/${campaignId}/tasks?date=2026-11-18`)).json().tasks.length, 0);
  assert.equal((await send("GET", `/api/campaigns/${campaignId}/tasks`)).statusCode, 200); // today
  assert.equal((await send("GET", `/api/campaigns/${campaignId}/tasks?date=tomorrow`)).statusCode, 400);

  const r = await applyAgentChange(cs, campaignId, { rows: [row({ quantity: 2 })] }, "agent-x", "fewer posts", campaignVocabulary(store, cs));
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
  assert.equal(cs.campaign(campaignId)!.rows[0].quantity, 1);
  res = await send("POST", `/api/campaigns/changes/${changeId}/undo`);
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already undone/);
  assert.equal((await send("POST", "/api/campaigns/changes/999/undo")).statusCode, 404);
  assert.ok(hook);
});

test("a failed campaign video can be retried, from the window only", async () => {
  const { app, send, cs, campaignId } = setup();
  const task = cs.addTask({ campaignId, date: "2026-11-17", dayIndex: 2, instructionIndex: 0, kind: "make", state: "failed", error: "boom" })!;
  assert.equal((await app.inject({ method: "POST", url: `/api/campaigns/tasks/${task}/retry`, headers: { ...OWN, origin: "https://evil.example" } })).statusCode, 403);
  assert.equal(cs.task(task)!.state, "failed", "a refused request changes nothing");
  assert.equal((await send("POST", "/api/campaigns/tasks/9999/retry")).statusCode, 404);
  assert.equal((await send("POST", "/api/campaigns/tasks/abc/retry")).statusCode, 400);
  const res = await send("POST", `/api/campaigns/tasks/${task}/retry`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().task.state, "queued");
  assert.equal((await send("POST", `/api/campaigns/tasks/${task}/retry`)).statusCode, 409, "already retried: it isn't failed any more");
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

test("a change is refused from another website or a foreign host, and allowed from the window itself", async () => {
  const { app, calls, cs } = setup();
  const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/campaigns/resume", headers });
  let res = await post({ ...OWN, origin: "https://evil.example" });
  assert.equal(res.statusCode, 403);
  assert.ok(res.json().error);
  res = await post({ host: "evil.example" });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: "POST", url: "/api/library", headers: { ...OWN, origin: "https://evil.example" }, payload: { kind: "hook", name: "x", text: "y" } });
  assert.equal(res.statusCode, 403);
  assert.equal(cs.entries().length, 2); // the two setup made
  assert.equal(calls.resume, 0);
  res = await post({ ...OWN, origin: `http://localhost:${config.port}` });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.resume, 1);
  // reading stays open to any host (it changes nothing)
  assert.equal((await app.inject({ method: "GET", url: "/api/campaigns/status", headers: { host: "evil.example" } })).statusCode, 200);
});

test("the Campaigns tab lists a campaign's held Drive files and can release one, from the window only", async () => {
  const { app, send, store, campaignId } = setup();
  store.upsertDriveFile("d1", { name: "Gatekeeping_RAW.mp4", state: "held", heldBy: campaignId, note: "held by campaign Weekday Growth" });
  store.upsertDriveFile("d2", { name: "Other.mp4", state: "processing" });
  const listed = (await send("GET", "/api/campaigns")).json().campaigns.find((c: any) => c.id === campaignId);
  assert.deepEqual(listed.held, [{ driveId: "d1", name: "Gatekeeping_RAW.mp4", taken: false, released: false }]);
  const url = "/api/campaigns/held/d1/release";
  assert.equal((await app.inject({ method: "POST", url, headers: { ...OWN, origin: "https://evil.example" } })).statusCode, 403);
  assert.equal(store.driveFile("d1")!.releasedAt, null, "a refused request changes nothing");
  assert.equal((await send("GET", url)).statusCode, 404, "never a GET");
  const res = await send("POST", url);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(store.driveFile("d1")!.releasedAt);
  assert.equal((await send("POST", "/api/campaigns/held/d2/release")).statusCode, 400, "only a held file");
});

test("campaign vocabulary route lists visible looks", async () => {
  const { send, store } = setup();
  const entry = { description: "", needsImageGen: false, libraryVersion: "1" };
  syncLooks(store, "lemo-opuscar", [{ key: "lemo:ukiyo-e", name: "Ukiyo-e", ...entry, needsImageGen: true }, { key: "lemo:old", name: "Old", ...entry }]);
  syncLooks(store, "lemo-opuscar", [{ key: "lemo:ukiyo-e", name: "Ukiyo-e", ...entry, needsImageGen: true }]);
  const res = await send("GET", "/api/campaigns");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().looks, [{ key: "lemo:ukiyo-e", name: "Ukiyo-e", producer: "lemo-opuscar", needsImageGen: true, category: null, description: "" }]);
  assert.equal(res.json().lemoInstalled, false); // the isolated test home has no library
});

test("GET /api/campaigns includes models, defaultClaude and lemoInstalled", async () => {
  let res = await setup().send("GET", "/api/campaigns");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().models, [], "no AI, no models");
  assert.equal(res.json().defaultClaude, DEFAULT_CLAUDE_MODEL_ID);
  assert.equal(res.json().lemoInstalled, false);
  const withClaude = setup({ ai: (store) => new AiService(store, { find: (id) => (id === "claude" ? id : "") }) });
  res = await withClaude.send("GET", "/api/campaigns");
  const models = res.json().models as { provider: string; models: { id: string }[] }[];
  assert.deepEqual(models.map((p) => p.provider), ["claude"]);
  assert.ok(models[0]!.models.some((m) => m.id === DEFAULT_CLAUDE_MODEL_ID));
});

test("saving an agent row with a Lemo style round-trips", async () => {
  const { send, store, campaignId, row } = setup();
  syncLooks(store, "lemo-opuscar", [{ key: "lemo:ukiyo-e", name: "Ukiyo-e", description: "", needsImageGen: false, libraryVersion: "1" }]);
  const agent = row({ origin: "agent", style: "lemo:ukiyo-e", id: 2 });
  const res = await send("PUT", `/api/campaigns/${campaignId}/rows`, { rows: [agent] });
  assert.equal(res.statusCode, 200, res.body);
  const saved = (await send("GET", "/api/campaigns")).json().campaigns.find((c: { id: number }) => c.id === campaignId);
  assert.equal(saved.rows[0].style, "lemo:ukiyo-e");
  assert.equal(saved.rows[0].origin, "agent");
  assert.equal(saved.rows[0].model, null);
  assert.equal("look" in saved.rows[0], false);
  assert.equal(saved.compiled.days.tue[0].look, "lemo:ukiyo-e");
});

test("an agent row with no style saves, and is left out of the schedule", async () => {
  const { send, campaignId, row } = setup();
  const res = await send("PUT", `/api/campaigns/${campaignId}/rows`, { rows: [row({ origin: "agent", style: null })] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().rows[0].style, null);
  assert.deepEqual(res.json().compiled.days.tue, []);
});

test("saving the table makes today's tasks at once, from the rows just saved", async () => {
  const { send, calls, campaignId, row } = setup();
  const res = await send("PUT", `/api/campaigns/${campaignId}/rows`, { rows: [row({ time: "21:45" })] });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(calls.materialize, [JSON.stringify([["21:45"]])], "after the save, before the answer");
  // A table that couldn't be saved makes nothing.
  await send("PUT", `/api/campaigns/${campaignId}/rows`, { rows: "x" });
  assert.equal(calls.materialize.length, 1);
});
