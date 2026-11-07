// Every AI provider FreePoster can use, and how to ask each one a question. All but OpenRouter run the program
// that comes with the user's own monthly plan (signed in on this computer), so nothing is billed per use.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askClaude, findClaude } from "../claude.ts";
import { findAnswer, promptText } from "./answer.ts";
import { findProgram, lastWords, planEnv, runProgram, type ProgramRun } from "./cli.ts";

export const AI_JOBS = ["caption", "frames", "lyrics"] as const;
export type AiJob = (typeof AI_JOBS)[number];

export const JOB_LABELS: Record<AiJob, string> = {
  caption: "Titles and captions (from what's said)",
  frames: "Titles and captions (from the picture, when nobody speaks)",
  lyrics: "Spotting song lyrics in the captions",
};

export const PROVIDER_IDS = ["claude", "chatgpt", "google", "copilot", "cursor", "grok", "muse", "openrouter"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** One question with no tools, answered as JSON matching `schema`. `images` are JPEGs shown with the prompt. */
export interface Question {
  system: string;
  prompt: string;
  schema: object;
  effort?: "low" | "medium" | "high";
  images?: Buffer[];
}

export interface Answer<T> {
  answer: T;
  /** what it cost, for pay-per-use providers (USD) */
  cost?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  model?: string | null;
}

export interface Plan { id: string; label: string; price?: string }

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /** "plan": the user's monthly plan through its program; "credits": prepaid, charged per use */
  billing: "plan" | "credits";
  plans: Plan[];
  /** can look at the still frames of a video with no speech */
  images: boolean;
  /** works per its documentation, but not yet tried on a real plan */
  experimental?: boolean;
  /** the program's name, as shown to the user */
  program?: string;
  setupUrl: string;
  /** how to install the program and sign in, as HTML-free text */
  setup: string;
  /** the program's full path ("" when not found); `override` is a path the user entered */
  find?(override?: string): string;
  ask?<T>(q: Question, ctx: { path: string; run?: ProgramRun }): Promise<Answer<T>>;
}

/** Writes the frames (and any other files) to a fresh temporary folder for a program to read, and cleans up. */
async function withFiles<R>(files: Record<string, string | Buffer>, images: Buffer[], use: (dir: string, imagePaths: string[]) => Promise<R>): Promise<R> {
  const dir = mkdtempSync(join(tmpdir(), "freeposter-ai-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const paths = images.map((img, i) => {
      const p = join(dir, `frame-${i + 1}.jpg`);
      writeFileSync(p, img);
      return p;
    });
    return await use(dir, paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs a program and finds the answer in what it printed (or in `answerFile`, when it writes one). */
async function runFor<T>(
  label: string, ctx: { path: string; run?: ProgramRun }, args: string[], stdin: string, schema: object,
  opts: { dropEnv?: string[]; answerFile?: string } = {},
): Promise<Answer<T>> {
  if (!ctx.path) throw new Error(`${label} isn't installed`);
  const { code, stdout, stderr } = await (ctx.run ?? runProgram)(ctx.path, args, stdin, { env: planEnv(opts.dropEnv ?? []) });
  const written = opts.answerFile && existsSync(opts.answerFile) ? readFileSync(opts.answerFile, "utf8") : "";
  try {
    return { answer: findAnswer<T>(written || stdout, schema) };
  } catch (err) {
    // A program that says why it stopped (signed out, out of plan usage) says it in an error event or on stderr.
    const said = errorIn(stdout) ?? lastWords(stdout, stderr);
    if (code) throw new Error(`${label} failed (exit ${code})${said ? `: ${said}` : ""}`);
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}

/** An error message a program reported in its JSON output, if any. */
function errorIn(stdout: string): string | null {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const msg = JSON.parse(line);
      const e = msg?.error ?? (msg?.type === "error" ? msg.message : null) ?? (msg?.is_error ? msg.result : null);
      if (e) return String(typeof e === "object" ? e.message ?? JSON.stringify(e) : e).slice(0, 300);
    } catch {}
  }
  return null;
}

/** Codex's schemas are strict: every object closed, every property required. */
export function strictSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = { ...schema };
  if (out.type === "object" && out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, strictSchema(v)]));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictSchema(out.items);
  return out;
}

const localAppData = process.env.LOCALAPPDATA ?? "";

export const PROVIDERS: Record<Exclude<ProviderId, "openrouter">, ProviderDef> & { openrouter: ProviderDef } = {
  claude: {
    id: "claude",
    label: "Claude",
    billing: "plan",
    plans: [{ id: "pro", label: "Claude Pro", price: "$20/month" }, { id: "max5", label: "Claude Max 5x", price: "$100/month" }, { id: "max20", label: "Claude Max 20x", price: "$200/month" }],
    images: true,
    program: "Claude Code",
    setupUrl: "https://claude.com/claude-code",
    setup: "Install Claude Code, then run claude once in a terminal and sign in with your Claude plan.",
    find: (override) => override || findClaude(),
    async ask<T>(q: Question, ctx: { path: string; run?: ProgramRun }) {
      return { answer: await askClaude<T>(q, { claudePath: ctx.path, run: ctx.run }) };
    },
  },
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT",
    billing: "plan",
    plans: [{ id: "plus", label: "ChatGPT Plus", price: "$20/month" }, { id: "pro", label: "ChatGPT Pro", price: "$200/month" }, { id: "business", label: "ChatGPT Business" }],
    images: true,
    program: "Codex CLI",
    setupUrl: "https://learn.chatgpt.com/docs/codex/cli",
    setup: "Install the Codex CLI (npm install -g @openai/codex), then run codex login and choose Sign in with ChatGPT.",
    find: (override) => override || findProgram(["codex"]),
    ask<T>(q: Question, ctx: { path: string; run?: ProgramRun }) {
      const schema = strictSchema(q.schema);
      return withFiles({ "schema.json": JSON.stringify(schema) }, q.images ?? [], (dir, images) => runFor<T>("Codex", ctx, [
        "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never",
        "-c", `model_reasoning_effort="${q.effort ?? "low"}"`,
        "--output-schema", join(dir, "schema.json"), "--output-last-message", join(dir, "answer.txt"),
        ...(images.length ? ["--image", images.join(",")] : []),
        "-", // the prompt comes on stdin
      ], promptText({ ...q, schema }), q.schema, { dropEnv: ["OPENAI_API_KEY", "CODEX_API_KEY"], answerFile: join(dir, "answer.txt") }));
    },
  },
  google: {
    id: "google",
    label: "Google AI (Gemini)",
    billing: "plan",
    plans: [{ id: "pro", label: "Google AI Pro", price: "$19.99/month" }, { id: "ultra", label: "Google AI Ultra", price: "$249.99/month" }],
    // Its headless mode takes text only.
    images: false,
    program: "Antigravity CLI",
    setupUrl: "https://antigravity.google/docs/cli/",
    setup: "Install the Antigravity CLI, then run agy once in a terminal and sign in with the Google account that has your Google AI plan.",
    find: (override) => override || findProgram(["agy"]),
    ask<T>(q: Question, ctx: { path: string; run?: ProgramRun }) {
      return runFor<T>("Antigravity", ctx, ["-p", promptText(q), "--output-format", "json", "--json-schema", JSON.stringify(q.schema)], "", q.schema,
        { dropEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] });
    },
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    billing: "plan",
    plans: [{ id: "pro", label: "Copilot Pro", price: "$10/month" }, { id: "proplus", label: "Copilot Pro+", price: "$39/month" }],
    images: true,
    program: "Copilot CLI",
    setupUrl: "https://docs.github.com/en/copilot/how-tos/copilot-cli",
    setup: "Install the Copilot CLI (npm install -g @github/copilot), then run copilot once in a terminal and sign in with /login. Each answer uses your plan's premium requests.",
    // Not VS Code's copilot-shim, which only offers to install the real one.
    find: (override) => override || findProgram(["copilot"]).replace(/^.*copilot-shim.*$/i, ""),
    ask<T>(q: Question, ctx: { path: string; run?: ProgramRun }) {
      return withFiles({}, q.images ?? [], (_dir, images) => runFor<T>("Copilot", ctx,
        ["-p", promptText(q), "-s", ...images.flatMap((p) => ["--attachment", p])], "", q.schema));
    },
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    billing: "plan",
    plans: [{ id: "pro", label: "Cursor Pro", price: "$20/month" }, { id: "proplus", label: "Cursor Pro+", price: "$60/month" }, { id: "ultra", label: "Cursor Ultra", price: "$200/month" }],
    images: false,
    program: "Cursor CLI",
    setupUrl: "https://cursor.com/cli",
    setup: "Install the Cursor CLI, then run cursor-agent login in a terminal.",
    find: (override) => override || findProgram(["cursor-agent"], localAppData ? [join(localAppData, "cursor-agent")] : []),
    ask<T>(q: Question, ctx: { path: string; run?: ProgramRun }) {
      return runFor<T>("Cursor", ctx, ["-p", "--output-format", "json", promptText(q)], "", q.schema);
    },
  },
  grok: {
    id: "grok",
    label: "Grok",
    billing: "plan",
    plans: [{ id: "supergrok", label: "SuperGrok", price: "$30/month" }, { id: "heavy", label: "SuperGrok Heavy", price: "$300/month" }],
    images: false,
    experimental: true,
    program: "Grok Build",
    setupUrl: "https://docs.x.ai/build/overview",
    setup: "Install Grok Build, then run grok login in a terminal. xAI may limit it to some SuperGrok plans.",
    find: (override) => override || findProgram(["grok"]),
    ask<T>(q: Question, ctx: { path: string; run?: ProgramRun }) {
      return withFiles({ "prompt.txt": promptText(q) }, [], (dir) => runFor<T>("Grok", ctx, [
        "--prompt-file", join(dir, "prompt.txt"), "--output-format", "json", "--disable-web-search", "--no-subagents", "--no-auto-update",
      ], "", q.schema, { dropEnv: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] }));
    },
  },
  muse: {
    id: "muse",
    label: "Muse Code",
    billing: "plan",
    plans: [
      { id: "everyday", label: "Everyday Usage", price: "$5/month" }, { id: "high", label: "High Usage", price: "$15/month" },
      { id: "power", label: "Power Usage", price: "$50/month" }, { id: "maximum", label: "Maximum Usage", price: "$200/month" },
    ],
    images: false,
    experimental: true,
    program: "Muse Code",
    setupUrl: "https://dev.meta.ai",
    setup: "Install Muse Code (in PowerShell: irm https://dev.meta.ai/install.ps1 | iex), then run muse once and sign in with your Muse Code subscription.",
    find: (override) => override || findProgram(["muse"]),
    ask<T>(q: Question, ctx: { path: string; run?: ProgramRun }) {
      // An API key would win over the signed-in subscription and bill per token.
      return withFiles({ "prompt.txt": promptText(q) }, [], (dir) => runFor<T>("Muse Code", ctx,
        ["exec", "--prompt-file", join(dir, "prompt.txt"), "--json"], "", q.schema, { dropEnv: ["META_API_KEY"] }));
    },
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    billing: "credits",
    plans: [],
    images: true,
    setupUrl: "https://openrouter.ai",
    setup: "Sign in with your OpenRouter account. Each answer is paid from your OpenRouter credits.",
  },
};
