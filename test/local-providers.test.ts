import "./isolated-home.ts"; // first: config.ts reads FREEPOSTER_HOME when it loads
import assert from "node:assert/strict";
import { test } from "node:test";
import { replyJson, serverOf } from "../src/ai/lmstudio.ts";
import type { Question } from "../src/ai/providers.ts";
import { AiService } from "../src/ai/router.ts";
import { compileRows, parseRows, rowIssues } from "../src/campaigns/rows.ts";
import { buildGeneratedProduction, type Script } from "../src/campaigns/script.ts";
import type { MakeInstruction, Vocabulary } from "../src/campaigns/spec.ts";
import { newStore } from "./helpers.ts";
import "../public/campaign-rows.js";

const FreePosterRows = (globalThis as any).FreePosterRows;

const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
const q: Question = { system: "be brief", prompt: "write a title", schema };

/** A stand-in LM Studio server: its model list, and chat answers it records the requests of. */
function lmServer(opts: { models?: object[]; answer?: string; down?: boolean } = {}) {
  const chats: { url: string; body: any }[] = [];
  const lists: string[] = [];
  const fetch: typeof globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (opts.down) throw new TypeError("fetch failed");
    if (url.endsWith("/api/v0/models")) {
      lists.push(url);
      return new Response(JSON.stringify({ data: opts.models ?? [
        { id: "qwen3.5-4b", type: "llm", state: "loaded" },
        { id: "nomic-embed", type: "embeddings", state: "not-loaded" },
        { id: "gemma-vision", type: "vlm", state: "not-loaded" },
      ] }));
    }
    const body = JSON.parse(String(init?.body));
    chats.push({ url, body });
    const isProbe = body.messages[1].content.includes('"answer"');
    const content = opts.answer ?? (isProbe ? '{"answer":"ok"}' : '<think>hmm</think>{"title":"local"}');
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  }) as typeof globalThis.fetch;
  return { fetch, chats, lists };
}

const wangp = (dir = "C:/WanGP", video = ["t2v_2_2", "ltxv_13B"]) => ({ dir: () => dir, video: () => video, current: () => "t2v_2_2" });

// ---- LM Studio ----

test("serverOf: blank is LM Studio's default; a typed address loses its slash and /v1; a non-URL is refused", () => {
  assert.equal(serverOf(""), "http://localhost:1234");
  assert.equal(serverOf(" http://pc:1234/v1/ "), "http://pc:1234");
  assert.throws(() => serverOf("localhost:1234"), /must start with http/);
});

test("a thinking model's reasoning and a code fence around the answer are dropped", () => {
  assert.deepEqual(replyJson('<think>first {"x":1}</think>\n```json\n{"title":"a"}\n```'), { title: "a" });
});

test("connecting LM Studio lists its chat models (no embeddings), asks the loaded one a test question, and offers them as writers", async () => {
  const lm = lmServer();
  const ai = new AiService(newStore(), { lmFetch: lm.fetch, find: () => "" });
  await ai.connect("lmstudio", {});
  assert.equal(lm.chats[0].url, "http://localhost:1234/v1/chat/completions");
  assert.equal(lm.chats[0].body.model, "qwen3.5-4b");
  assert.equal(lm.chats[0].body.response_format.type, "json_schema");
  assert.deepEqual(ai.modelChoices(), [{ provider: "lmstudio", label: "LM Studio", models: [
    { id: "lmstudio:qwen3.5-4b", name: "qwen3.5-4b" },
    { id: "lmstudio:gemma-vision", name: "gemma-vision" },
  ] }]);
  assert.deepEqual(ai.ranking("caption"), ["lmstudio"]);
});

test("a row's LM Studio model is the one asked; without one, the loaded model answers", async () => {
  const lm = lmServer();
  const ai = new AiService(newStore(), { lmFetch: lm.fetch, find: () => "" });
  await ai.connect("lmstudio", {});
  assert.deepEqual(await ai.ask("script", q, { model: "lmstudio:gemma-vision" }), { title: "local" });
  assert.equal(lm.chats.at(-1)!.body.model, "gemma-vision");
  assert.deepEqual(await ai.ask("caption", q), { title: "local" });
  assert.equal(lm.chats.at(-1)!.body.model, "qwen3.5-4b");
});

test("LM Studio's server address is kept when it isn't the default, and asked from then on", async () => {
  const lm = lmServer();
  const store = newStore();
  const ai = new AiService(store, { lmFetch: lm.fetch, find: () => "" });
  await ai.connect("lmstudio", { path: "http://gpu-box:1234/" });
  await ai.ask("caption", q);
  assert.equal(lm.chats.at(-1)!.url, "http://gpu-box:1234/v1/chat/completions");
  const view = await ai.view();
  assert.equal(view.providers.find((p) => p.id === "lmstudio")!.path, "http://gpu-box:1234");
});

test("LM Studio's server not running: Connect says to start it; a reply that isn't the schema fails", async () => {
  const ai = new AiService(newStore(), { lmFetch: lmServer({ down: true }).fetch, find: () => "" });
  await assert.rejects(ai.connect("lmstudio", {}), /isn't answering at http:\/\/localhost:1234.*start the server/);
  const bad = new AiService(newStore(), { lmFetch: lmServer({ answer: '{"name":"x"}' }).fetch, find: () => "" });
  await assert.rejects(bad.connect("lmstudio", {}), /qwen3.5-4b didn't answer: .*didn't fit/);
});

test("LM Studio with no chat model downloaded can't be connected", async () => {
  const ai = new AiService(newStore(), { lmFetch: lmServer({ models: [{ id: "nomic-embed", type: "embeddings" }] }).fetch, find: () => "" });
  await assert.rejects(ai.connect("lmstudio", {}), /no chat model downloaded/);
});

test("the AI Providers panel shows LM Studio as free and local", async () => {
  const ai = new AiService(newStore(), { lmFetch: lmServer().fetch, find: () => "" });
  await ai.connect("lmstudio", {});
  const p = (await ai.view()).providers.find((x) => x.id === "lmstudio")!;
  assert.equal(p.pricing, "Free: runs on this computer");
  assert.equal(p.writes, true);
  assert.equal(p.installed, null);
  assert.deepEqual(p.models.map((m) => m.id), ["lmstudio:qwen3.5-4b", "lmstudio:gemma-vision"]);
});

// ---- WanGP ----

test("WanGP connects when it's installed, never writes, and offers its video models for rows instead", async () => {
  const ai = new AiService(newStore(), { wangp: wangp(), find: (id) => (id === "claude" ? "claude" : "") });
  await ai.connect("wangp");
  assert.ok(ai.connected().includes("wangp"));
  assert.equal(ai.ranking("caption").includes("wangp"), false);
  assert.equal(ai.modelChoices().some((g) => g.provider === "wangp"), false);
  assert.deepEqual(ai.videoChoices(), { models: [{ id: "wangp:t2v_2_2", name: "t2v_2_2" }, { id: "wangp:ltxv_13B", name: "ltxv_13B" }], fallback: "t2v_2_2" });
  await assert.rejects(ai.ask("script", q, { model: "wangp:t2v_2_2" }), /WanGP makes video; it can't write/);
  const view = await ai.view();
  assert.equal(view.providers.find((p) => p.id === "wangp")!.writes, false);
  assert.ok(view.jobs.every((j) => j.order.every((p) => p.id !== "wangp")));
});

test("WanGP not installed can't be connected; a video model turned off isn't offered", async () => {
  const missing = new AiService(newStore(), { wangp: wangp(""), find: () => "" });
  await assert.rejects(missing.connect("wangp"), /WanGP wasn't found/);
  assert.deepEqual(missing.videoChoices().models, []);
  const ai = new AiService(newStore(), { wangp: wangp(), find: () => "" });
  await ai.connect("wangp");
  ai.setModelEnabled("wangp:ltxv_13B", false);
  assert.deepEqual(ai.videoChoices().models.map((m) => m.id), ["wangp:t2v_2_2"]);
});

// ---- a row's video model ----

const vocab = { styles: [{ id: "basic", token: "basic" }], types: [], hooks: [], angles: [], ctas: [], looks: [{ key: "lemo:ukiyo-e" }] } as Vocabulary;
const pick = { pick: "random" };
const row = (over: Record<string, unknown> = {}) => ({
  id: 1, quantity: 1, hook: pick, angle: pick, cta: pick, style: "basic", model: null, videoModel: null, type: null, time: "18:00",
  days: ["tue"], sec: 30, origin: "create", text: "", ...over,
});

test("a Create row's video model is checked and compiled into its instruction; a missing one reads as null", () => {
  const r = parseRows([row({ videoModel: "wangp:t2v_2_2" })], vocab);
  assert.ok(r.ok);
  const ins = compileRows(r.ok ? r.value : [], vocab).days.tue[0] as MakeInstruction;
  assert.equal(ins.videoModel, "wangp:t2v_2_2");
  const { videoModel: _, ...old } = row();
  const o = parseRows([old], vocab);
  assert.ok(o.ok && o.value[0].videoModel === null);
});

test("a video model must be WanGP's, never the writer; one turned off or no longer offered is refused or reported", () => {
  const bad = parseRows([row({ videoModel: "lmstudio:qwen" }), row({ id: 2, model: "wangp:t2v_2_2" })], vocab);
  assert.ok(!bad.ok);
  assert.match(bad.ok ? "" : bad.problems.join("\n"), /row 1: videoModel must be a WanGP model id[\s\S]*row 2: model is the AI that writes the video/);
  const off = parseRows([row({ videoModel: "wangp:x" })], { ...vocab, disabledModels: ["wangp:x"] });
  assert.match(off.ok ? "" : off.problems.join(), /wangp:x is turned off/);
  const r = parseRows([row({ videoModel: "wangp:gone" })], vocab);
  assert.deepEqual(rowIssues(r.ok ? r.value[0] : (null as any), { ...vocab, videoModels: ["wangp:t2v_2_2"] }), ["wangp:gone isn't available; pick another video model"]);
});

test("only a Create row with a FreePoster edit takes its video model: a Lemo film's is left out", () => {
  const r = parseRows([row({ style: "lemo:ukiyo-e", model: "claude:claude-opus-5-5", videoModel: "wangp:t2v_2_2" })], vocab);
  assert.ok(r.ok);
  assert.equal((compileRows(r.ok ? r.value : [], vocab).days.tue[0] as MakeInstruction).videoModel, undefined);
});

test("the row's WanGP model makes every shot but the presenter's; without one they use Setup's", () => {
  const s: Script = { title: "t", lines: ["hi"], musicPrompt: "m", shots: [{ prompt: "a", sec: 3 }, { prompt: "b", sec: 3 }] } as unknown as Script;
  const audio = { voiceover: "v.wav", music: "m.wav" };
  assert.deepEqual(buildGeneratedProduction(s, audio, false, "wangp:ltxv_13B").shots.map((x: any) => x.model), ["ltxv_13B", "ltxv_13B"]);
  assert.deepEqual(buildGeneratedProduction(s, audio, false).shots.map((x: any) => x.model), [undefined, undefined]);
});

// ---- the Campaigns tab ----

test("the Video Model dropdown starts with Setup's model, then WanGP's; only Create rows with a FreePoster edit get one", () => {
  const ctx = { models: [], styles: [], lemo: [], videoModels: { models: [{ id: "wangp:t2v_2_2", name: "t2v_2_2" }], fallback: "t2v_2_2" } };
  const groups = FreePosterRows.videoModelOptions(row(), ctx);
  assert.deepEqual(groups.map((g: any) => g.options.map((o: any) => o.label)), [["Setup's model (t2v_2_2)"], ["t2v_2_2"]]);
  assert.deepEqual(FreePosterRows.videoModelOptions(row({ origin: "drive" }), ctx), []);
  assert.deepEqual(FreePosterRows.videoModelOptions(row({ style: "lemo:ukiyo-e" }), ctx), []);
  assert.equal(FreePosterRows.showVideoModelColumn([row()], ctx), true);
  assert.equal(FreePosterRows.showVideoModelColumn([row()], { ...ctx, videoModels: { models: [], fallback: "" } }), false);
  assert.equal(FreePosterRows.applyChange(row(), "videoModel", "", ctx).row.videoModel, null);
  assert.deepEqual(FreePosterRows.rowIssues(row({ videoModel: "wangp:gone" }), ctx), ["wangp:gone isn't available; pick another video model"]);
});
