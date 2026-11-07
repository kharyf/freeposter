import "./isolated-home.ts"; // first: config.ts reads FREEPOSTER_HOME when it loads
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findAnswer, schemaProblem } from "../src/ai/answer.ts";
import { unwrapCmd, type ProgramRun } from "../src/ai/cli.ts";
import * as openrouter from "../src/ai/openrouter.ts";
import { PROVIDERS, strictSchema, type ProviderId, type Question } from "../src/ai/providers.ts";
import { AiService } from "../src/ai/router.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { json, newStore, tmp } from "./helpers.ts";

const schema = { type: "object", properties: { title: { type: "string" }, n: { type: "integer" } }, required: ["title"], additionalProperties: false };
const q: Question = { system: "be brief", prompt: "write a title", schema };

// ---- reading answers ----

test("an answer is found in plain JSON, a code fence, text around it, or inside JSON-lines events", () => {
  assert.deepEqual(findAnswer('{"title":"a"}', schema), { title: "a" });
  assert.deepEqual(findAnswer('Sure!\n```json\n{"title": "b"}\n```', schema), { title: "b" });
  assert.deepEqual(findAnswer('Here you go: {"title": "c {not a brace}"} hope it helps', schema), { title: "c {not a brace}" });
  // An envelope whose answer is a string of JSON (Claude's result, Grok's text, Cursor's result...).
  assert.deepEqual(findAnswer(JSON.stringify({ type: "result", text: '{"title":"d"}', sessionId: "x" }), schema), { title: "d" });
  // JSON lines: the last event that holds a fitting answer wins.
  const events = [{ type: "message", content: '{"title":"draft"}' }, { type: "message", content: '{"title":"final"}' }, { type: "done" }];
  assert.deepEqual(findAnswer(events.map((e) => JSON.stringify(e)).join("\n"), schema), { title: "final" });
});

test("an answer that doesn't fit the schema is refused, saying why", () => {
  assert.throws(() => findAnswer('{"name":"x"}', schema), /expected JSON \(answer has no title\)/);
  assert.throws(() => findAnswer('{"title":"x","n":1.5}', schema), /answer\.n isn't a whole number/);
  assert.throws(() => findAnswer("I can't help with that", schema), /nothing that looks like JSON.*can't help/);
  assert.equal(schemaProblem({ type: "object", properties: { l: { type: "array", items: { type: "integer" } } }, required: ["l"] }, { l: [1, "2"] }), "answer.l[1] isn't a whole number");
});

test("Codex gets a strict schema: every object closed and every property required", () => {
  const strict = strictSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "object", properties: { c: { type: "boolean" } } } }, required: ["a"] });
  assert.deepEqual(strict.required, ["a", "b"]);
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.properties.b.required, ["c"]);
});

test("npm's Windows launchers are run through node directly, so a multi-line prompt survives", () => {
  const dir = tmp();
  const cmd = join(dir, "codex.cmd");
  writeFileSync(cmd, [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join("\r\n"));
  const argv = unwrapCmd(cmd)!;
  assert.ok(argv.length === 2 && /node/i.test(argv[0]));
  assert.equal(argv[1], `${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`);
});

// ---- each provider's program ----

/** A stand-in program: records what it was run with and prints `stdout`. */
function fakeProgram(stdout: string | ((args: string[]) => string), code = 0, stderr = "") {
  const calls: { cmd: string; args: string[]; stdin: string; env?: NodeJS.ProcessEnv; files: Record<string, string> }[] = [];
  const run: ProgramRun = async (cmd, args, stdin, opts) => {
    // Files the provider wrote for the program (prompt, schema) are gone after the run: read them now.
    const files: Record<string, string> = {};
    for (const a of args) if (/freeposter-ai-/.test(a) && existsSync(a) && !a.endsWith(".jpg") && !a.endsWith("answer.txt")) files[a] = readFileSync(a, "utf8");
    calls.push({ cmd, args, stdin, env: opts?.env, files });
    return { code, stdout: typeof stdout === "function" ? stdout(args) : stdout, stderr };
  };
  return { run, calls };
}

test("ChatGPT (Codex): exec, read-only, strict schema file, frames as images, prompt on stdin, answer from its last-message file", async () => {
  process.env.OPENAI_API_KEY = "sk-would-bill-the-api";
  const fake = fakeProgram((args) => {
    writeFileSync(args[args.indexOf("--output-last-message") + 1], '{"title":"from codex","n":2}');
    return '{"type":"thread.started"}\n';
  });
  const out = await PROVIDERS.chatgpt.ask!<{ title: string }>({ ...q, images: [Buffer.from("jpg1"), Buffer.from("jpg2")] }, { path: "codex", run: fake.run });
  delete process.env.OPENAI_API_KEY;
  assert.deepEqual(out.answer, { title: "from codex", n: 2 });
  const { args, stdin, env, files } = fake.calls[0];
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ephemeral") && args.includes("--skip-git-repo-check"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.deepEqual(JSON.parse(files[args[args.indexOf("--output-schema") + 1]]).required, ["title", "n"]);
  assert.equal(args[args.indexOf("--image") + 1].split(",").length, 2);
  assert.equal(args.at(-1), "-");
  assert.match(stdin, /be brief[\s\S]*write a title[\s\S]*JSON Schema/);
  assert.equal(env!.OPENAI_API_KEY, undefined, "an API key would bill the API instead of the ChatGPT plan");
});

test("Google AI (Antigravity): print mode with its JSON envelope and schema", async () => {
  const fake = fakeProgram(JSON.stringify({ response: "done", structured_output: { title: "from agy" }, status: "success" }));
  assert.deepEqual((await PROVIDERS.google.ask!(q, { path: "agy", run: fake.run })).answer, { title: "from agy" });
  const { args } = fake.calls[0];
  assert.equal(args[0], "-p");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]), schema);
});

test("Copilot: silent print mode, frames attached", async () => {
  const fake = fakeProgram('{"title":"from copilot"}');
  await PROVIDERS.copilot.ask!({ ...q, images: [Buffer.from("a")] }, { path: "copilot", run: fake.run });
  const { args } = fake.calls[0];
  assert.equal(args[0], "-p");
  assert.ok(args.includes("-s"));
  assert.match(args[args.indexOf("--attachment") + 1], /frame-1\.jpg$/);
});

test("Cursor, Grok and Muse Code: their own flags, and the answer read from their output", async () => {
  let fake = fakeProgram(JSON.stringify({ type: "result", is_error: false, result: '{"title":"from cursor"}' }));
  assert.deepEqual((await PROVIDERS.cursor.ask!(q, { path: "cursor-agent", run: fake.run })).answer, { title: "from cursor" });
  assert.deepEqual(fake.calls[0].args.slice(0, 3), ["-p", "--output-format", "json"]);

  process.env.XAI_API_KEY = "xai-key";
  fake = fakeProgram(JSON.stringify({ text: '{"title":"from grok"}', stopReason: "end_turn", sessionId: "s" }));
  assert.deepEqual((await PROVIDERS.grok.ask!(q, { path: "grok", run: fake.run })).answer, { title: "from grok" });
  delete process.env.XAI_API_KEY;
  const grok = fake.calls[0];
  assert.match(grok.files[grok.args[grok.args.indexOf("--prompt-file") + 1]], /write a title/);
  assert.equal(grok.env!.XAI_API_KEY, undefined);

  process.env.META_API_KEY = "meta-key";
  fake = fakeProgram([{ type: "run.started" }, { type: "message", role: "assistant", text: '{"title":"from muse"}' }, { type: "run.usage" }].map((e) => JSON.stringify(e)).join("\n"));
  assert.deepEqual((await PROVIDERS.muse.ask!(q, { path: "muse", run: fake.run })).answer, { title: "from muse" });
  delete process.env.META_API_KEY;
  assert.deepEqual(fake.calls[0].args.slice(0, 2), ["exec", "--prompt-file"]);
  assert.equal(fake.calls[0].env!.META_API_KEY, undefined, "an API key would win over the Muse Code subscription");
});

test("a program that fails says why: its error event, or the end of what it printed", async () => {
  await assert.rejects(PROVIDERS.grok.ask!(q, { path: "grok", run: fakeProgram('{"type":"error","message":"Couldn\'t start session: not signed in"}', 1).run }),
    /Grok failed \(exit 1\): Couldn't start session: not signed in/);
  await assert.rejects(PROVIDERS.cursor.ask!(q, { path: "c", run: fakeProgram("", 1, "Authentication required. Run cursor-agent login").run }),
    /Cursor failed \(exit 1\): Authentication required/);
  await assert.rejects(PROVIDERS.copilot.ask!(q, { path: "c", run: fakeProgram("I would rather not.").run }), /Copilot: its reply wasn't the expected JSON/);
});

// ---- choosing and ranking providers ----

/** An AiService whose programs are all installed fakes answering with `answers[id]` (an Error = it fails). */
function service(answers: Partial<Record<ProviderId, unknown>>, store = newStore()) {
  const asked: ProviderId[] = [];
  const run: ProgramRun = async (cmd, args, stdin) => {
    const id = cmd as ProviderId;
    asked.push(id);
    // Connect's test question gets its own answer.
    const probe = (args.join(" ") + stdin).includes('Answer with {"answer": "ok"}');
    const a = probe && !(answers[id] instanceof Error) ? { answer: "ok" } : answers[id];
    if (a instanceof Error) return { code: 1, stdout: "", stderr: a.message };
    // Codex writes its answer to a file; the others print it.
    if (id === "chatgpt") writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(a));
    return { code: 0, stdout: id === "claude" ? JSON.stringify({ is_error: false, result: "", structured_output: a }) : JSON.stringify(a), stderr: "" };
  };
  const ai = new AiService(store, { run, find: (id) => id in answers ? id : "" });
  return { ai, asked, store };
}

test("a computer that already had Claude Code keeps using it; one without starts with no provider", () => {
  assert.deepEqual(service({ claude: {} }).ai.connected(), ["claude"]);
  assert.deepEqual(service({}).ai.connected(), []);
});

test("Connect asks a test question first; a provider that can't answer isn't connected", async () => {
  const { ai } = service({ chatgpt: { answer: "ok" }, cursor: new Error("Authentication required") });
  await ai.connect("chatgpt", { plan: "plus" });
  await assert.rejects(ai.connect("cursor"), /Cursor CLI didn't answer: .*Authentication required.*cursor-agent login/);
  await assert.rejects(ai.connect("grok"), /Grok Build isn't installed on this computer\. Install Grok Build/);
  assert.deepEqual(ai.connected(), ["chatgpt"]);
  const view = await ai.view();
  assert.equal(view.providers.find((p) => p.id === "chatgpt")!.pricing, "Monthly plan: ChatGPT Plus ($20/month)");
});

test("each job asks its providers in the user's order, falling through to the next when one fails", async () => {
  const { ai, asked, store } = service({ claude: new Error("Claude usage limit reached"), chatgpt: { title: "from chatgpt" }, copilot: { title: "from copilot" } });
  await ai.connect("chatgpt");
  await ai.connect("copilot");
  asked.length = 0;
  // Claude (connected first) is tried first; its plan is used up, so ChatGPT answers.
  assert.deepEqual(await ai.ask("caption", q), { title: "from chatgpt" });
  assert.deepEqual(asked, ["claude", "chatgpt"]);
  // Another job, another order.
  ai.setRanking("lyrics", ["copilot", "claude"]);
  asked.length = 0;
  assert.deepEqual(await ai.ask("lyrics", q), { title: "from copilot" });
  assert.deepEqual(asked, ["copilot"]);
  assert.deepEqual(ai.ranking("lyrics"), ["copilot", "claude", "chatgpt"], "providers missing from a saved order go last");
  assert.equal(store.aiLastUses().find((u) => u.provider === "claude" && !u.ok)!.error, "Claude Code failed (exit 1): Claude usage limit reached");
});

test("only providers that can look at images are asked about a silent video's frames", async () => {
  const { ai, asked } = service({ claude: {}, google: { title: "from google" }, copilot: { title: "from copilot" } });
  await ai.connect("google");
  await ai.connect("copilot");
  ai.setRanking("frames", ["google", "copilot", "claude"]);
  asked.length = 0;
  assert.deepEqual(await ai.ask("frames", { ...q, images: [Buffer.from("x")] }), { title: "from copilot" });
  assert.deepEqual(asked, ["copilot"], "Antigravity's headless mode takes no images");
  const frames = (await ai.view()).jobs.find((j) => j.id === "frames")!;
  assert.equal(frames.order.find((p) => p.id === "google")!.canDo, false);
});

test("when every provider fails, the error says what each one said", async () => {
  const { ai } = service({ claude: new Error("signed out"), copilot: new Error("no premium requests left") });
  await ai.connect("copilot").catch(() => {});
  ai.disconnect("copilot");
  await assert.rejects(ai.ask("caption", q), /^Error: Claude: Claude Code failed \(exit 1\): signed out$/);
  ai.disconnect("claude");
  await assert.rejects(ai.ask("caption", q), /no AI provider is connected/);
});

// ---- OpenRouter ----

const MODELS = { data: [
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", supported_parameters: ["structured_outputs"], architecture: { input_modalities: ["text", "image"] }, pricing: { prompt: "0.0000001", completion: "0.0000005", image: "0" } },
  { id: "text/only", name: "Text Only", supported_parameters: ["structured_outputs"], architecture: { input_modalities: ["text"] }, pricing: { prompt: "0.00000005", completion: "0.0000001" } },
  { id: "no/schemas", name: "No Schemas", supported_parameters: [], architecture: { input_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
] };

function openRouterFetch(opts: { credits?: boolean } = {}) {
  const calls: { url: string; body: any; auth?: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, auth: (init.headers as Record<string, string> | undefined)?.authorization });
    if (url.endsWith("/auth/keys")) return body.code === "good" ? json({ key: "sk-or-user" }) : json({ error: { message: "invalid code" } }, 400);
    if (url.endsWith("/models")) return json(MODELS);
    if (url.endsWith("/credits")) return opts.credits ? json({ data: { total_credits: 10, total_usage: 2.5 } }) : json({ error: { message: "Only management keys can perform this operation" } }, 403);
    if (url.endsWith("/key")) return json({ data: { limit: null, limit_remaining: null, usage: 0.42 } });
    if (url.endsWith("/chat/completions")) {
      return json({ model: body.model, choices: [{ message: { content: '{"title":"from openrouter"}' } }], usage: { prompt_tokens: 1200, completion_tokens: 40, cost: 0.00014 } });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("OpenRouter: sign-in with PKCE and a state, then each answer's cost is recorded", async () => {
  const url = new URL(openrouter.authorizeUrl("http://localhost:4400/callback/openrouter", "4400.abc", "verifier"));
  assert.equal(url.origin + url.pathname, "https://openrouter.ai/auth");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "4400.abc");

  const { f, calls } = openRouterFetch();
  assert.equal(await openrouter.exchangeCode("good", "verifier", f), "sk-or-user");
  await assert.rejects(openrouter.exchangeCode("bad", "verifier", f), /didn't give a key \(HTTP 400: invalid code\)/);

  const { ai, store } = service({});
  ai.opts.fetch = f;
  ai.saveOpenRouterKey("sk-or-user");
  assert.deepEqual(ai.connected(), ["openrouter"]);
  assert.deepEqual(await ai.ask("caption", { ...q, images: [Buffer.from("jpeg")] }), { title: "from openrouter" });
  const chat = calls.find((c) => c.url.endsWith("/chat/completions"))!;
  assert.equal(chat.auth, "Bearer sk-or-user");
  assert.equal(chat.body.model, openrouter.DEFAULT_MODEL);
  assert.equal(chat.body.response_format.json_schema.strict, true);
  assert.deepEqual(chat.body.response_format.json_schema.schema.required, ["title", "n"], "strict schemas list every property");
  assert.match(chat.body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(store.aiCosts("openrouter", "caption").last, 0.00014);
});

test("OpenRouter's panel: balance (or the key's spending when the balance is hidden), models, estimated and actual cost", async () => {
  const { ai } = service({});
  const { f } = openRouterFetch();
  ai.opts.fetch = f;
  ai.saveOpenRouterKey("sk-or-user");
  let view = (await ai.view()).openrouter!;
  assert.deepEqual(view.balance, { credits: null, keyRemaining: null, keyUsage: 0.42 });
  assert.deepEqual(view.models.map((m) => m.id), ["text/only", "anthropic/claude-haiku-5.5"], "only models that follow a schema, cheapest first");
  // No uses yet: estimated from the model's prices and a typical caption's size.
  assert.ok(Math.abs(view.costs.caption.estimate! - (1300 * 1e-7 + 150 * 5e-7)) < 1e-12);
  assert.equal(view.costs.caption.uses, 0);
  await ai.ask("caption", q);
  view = (await ai.view()).openrouter!;
  assert.deepEqual({ last: view.costs.caption.last, average: view.costs.caption.average, uses: view.costs.caption.uses }, { last: 0.00014, average: 0.00014, uses: 1 });
  // Then the estimate follows the sizes seen.
  assert.ok(Math.abs(view.costs.caption.estimate! - (1200 * 1e-7 + 40 * 5e-7)) < 1e-12);

  // A text-only model can't do silent videos.
  await ai.setModel("text/only");
  assert.equal(ai.canDo("openrouter", "frames"), false);
  await assert.rejects(ai.setModel("no/schemas"), /no model no\/schemas/);

  const withCredits = openRouterFetch({ credits: true });
  assert.equal((await openrouter.balance("k", withCredits.f)).credits, 7.5);
});

// ---- the page's routes ----

test("the AI Providers routes: list, connect, plan, order, disconnect, and OpenRouter's sign-in", async () => {
  const store = newStore();
  const { ai } = service({ claude: { answer: "ok" }, chatgpt: { answer: "ok" } }, store);
  const { f } = openRouterFetch();
  ai.opts.fetch = f;
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers, {}, undefined, ai);

  let res = await app.inject("/api/ai");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().providers.filter((p: any) => p.connected).map((p: any) => p.id), ["claude"]);

  res = await app.inject({ method: "POST", url: "/api/ai/chatgpt/connect", payload: { plan: "pro" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().providers.find((p: any) => p.id === "chatgpt").pricing, "Monthly plan: ChatGPT Pro ($200/month)");

  res = await app.inject({ method: "PUT", url: "/api/ai/claude", payload: { plan: "max5" } });
  assert.equal(res.json().providers.find((p: any) => p.id === "claude").pricing, "Monthly plan: Claude Max 5x ($100/month)");
  assert.equal((await app.inject({ method: "PUT", url: "/api/ai/claude", payload: { plan: "gold" } })).statusCode, 400);

  res = await app.inject({ method: "PUT", url: "/api/ai-ranking", payload: { job: "caption", order: ["chatgpt", "claude"] } });
  assert.deepEqual(res.json().jobs.find((j: any) => j.id === "caption").order.map((p: any) => p.id), ["chatgpt", "claude"]);
  assert.equal((await app.inject({ method: "PUT", url: "/api/ai-ranking", payload: { job: "dance", order: [] } })).statusCode, 400);

  res = await app.inject({ method: "POST", url: "/api/ai/grok/connect", payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /isn't installed/);

  // OpenRouter: Connect sends the browser to OpenRouter; the callback trades the code for a key.
  res = await app.inject("/connect/openrouter");
  assert.equal(res.statusCode, 302);
  const auth = new URL(res.headers.location as string);
  assert.equal(auth.searchParams.get("callback_url"), "http://localhost:4400/callback/openrouter");
  res = await app.inject(`/callback/openrouter?code=good&state=${encodeURIComponent(auth.searchParams.get("state")!)}`);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /connected=OpenRouter/);
  assert.ok(ai.connected().includes("openrouter"));
  // A callback nobody started is refused.
  res = await app.inject("/callback/openrouter?code=good&state=4400.forged");
  assert.match(new URLSearchParams((res.headers.location as string).slice(2)).get("error")!, /^openrouter: login expired/);

  res = await app.inject({ method: "DELETE", url: "/api/ai/openrouter" });
  assert.equal(res.json().providers.find((p: any) => p.id === "openrouter").connected, false);
  assert.equal(store.secretPref("ai.openrouter.key"), undefined, "the key is forgotten");
  await app.close();
});
