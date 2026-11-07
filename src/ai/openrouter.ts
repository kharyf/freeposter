// OpenRouter: one sign-in that gives FreePoster a key on the user's own OpenRouter account, paid per use from
// their credits. FreePoster talks to its API directly; there's no program to install.
import { pkceChallenge } from "../crypto.ts";
import { schemaProblem } from "./answer.ts";
import { strictSchema, type Answer, type Question } from "./providers.ts";

const API = "https://openrouter.ai/api/v1";
/** Reads images, follows a JSON schema, and costs a fraction of a cent per caption. */
export const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const HEADERS = { "HTTP-Referer": "https://github.com/kharyf/freeposter", "X-Title": "FreePoster" };

export type Fetch = typeof fetch;

/** Where the Connect button sends the browser. OpenRouter echoes `state` back to the callback. */
export function authorizeUrl(callbackUrl: string, state: string, verifier: string): string {
  const q = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    state,
    key_label: "FreePoster",
  });
  return `https://openrouter.ai/auth?${q}`;
}

/** The callback's one-time code → an API key on the user's account. */
export async function exchangeCode(code: string, verifier: string, f: Fetch = fetch): Promise<string> {
  const res = await f(`${API}/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({})) as { key?: string; error?: { message?: string } };
  if (!res.ok || !body.key) throw new Error(`OpenRouter didn't give a key (HTTP ${res.status}${body.error?.message ? `: ${body.error.message}` : ""})`);
  return body.key;
}

export interface ModelInfo {
  id: string;
  name: string;
  images: boolean;
  /** USD per token, and per image where the model charges for them */
  prompt: number;
  completion: number;
  image: number;
}

let modelCache: { at: number; models: ModelInfo[] } | undefined;

/** Models that can follow a JSON schema (all FreePoster's questions need one), cheapest first. Cached 6 hours. */
export async function models(f: Fetch = fetch): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.at < 6 * 3600_000) return modelCache.models;
  const res = await f(`${API}/models`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenRouter's model list didn't load (HTTP ${res.status})`);
  const { data } = await res.json() as { data: any[] };
  const list: ModelInfo[] = data
    .filter((m) => (m.supported_parameters ?? []).includes("structured_outputs") && !String(m.id).endsWith(":batch"))
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      images: (m.architecture?.input_modalities ?? []).includes("image"),
      prompt: Number(m.pricing?.prompt ?? 0),
      completion: Number(m.pricing?.completion ?? 0),
      image: Number(m.pricing?.image ?? 0),
    }))
    .sort((a, b) => a.prompt - b.prompt || a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), models: list };
  return list;
}

/** One question, answered under the schema; `cost` is what OpenRouter charged for it. */
export async function ask<T>(q: Question, key: string, model: string, f: Fetch = fetch): Promise<Answer<T>> {
  const images = q.images ?? [];
  const content = images.length
    ? [{ type: "text", text: q.prompt }, ...images.map((img) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.toString("base64")}` } }))]
    : q.prompt;
  const res = await f(`${API}/chat/completions`, {
    method: "POST",
    headers: { ...HEADERS, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: q.system }, { role: "user", content }],
      // Strict mode wants every property listed as required; the answer is still checked against the real schema.
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: strictSchema(q.schema) } },
      // Only providers of this model that honour the schema.
      provider: { require_parameters: true },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({})) as any;
  if (!res.ok || body.error) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    throw new Error(res.status === 402 ? `out of OpenRouter credits (${msg})` : res.status === 401 ? `OpenRouter signed FreePoster out; connect it again (${msg})` : `OpenRouter: ${msg}`);
  }
  const usage = body.usage ?? {};
  const text: string = body.choices?.[0]?.message?.content ?? "";
  let answer: T;
  try {
    answer = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error(`OpenRouter's reply (${model}) wasn't JSON: ${text.slice(0, 200)}`);
  }
  const problem = schemaProblem(q.schema as any, answer);
  if (problem) throw new Error(`OpenRouter's reply (${model}) didn't fit: ${problem}`);
  return {
    answer,
    cost: typeof usage.cost === "number" ? usage.cost : null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    model: body.model ?? model,
  };
}

export interface Balance {
  /** credits left on the account (needs OpenRouter to allow it for this key) */
  credits: number | null;
  /** what's left under a spending limit set on FreePoster's key, if it has one */
  keyRemaining: number | null;
  /** spent through FreePoster's key, all time */
  keyUsage: number | null;
  error?: string;
}

/**
 * What's left to spend. The account's balance is only shown to keys allowed to see it; any key can read its
 * own limit and spending, so those come too.
 */
export async function balance(key: string, f: Fetch = fetch): Promise<Balance> {
  const get = async (path: string) => {
    const res = await f(`${API}${path}`, { headers: { ...HEADERS, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? ((await res.json()) as any).data : null;
  };
  try {
    const [credits, info] = await Promise.all([get("/credits").catch(() => null), get("/key")]);
    if (!info && !credits) return { credits: null, keyRemaining: null, keyUsage: null, error: "OpenRouter didn't answer" };
    const remaining = info?.effective_budget?.remaining_usd ?? info?.limit_remaining;
    return {
      credits: credits ? Number(credits.total_credits) - Number(credits.total_usage) : null,
      keyRemaining: typeof remaining === "number" ? remaining : null,
      keyUsage: typeof info?.usage === "number" ? info.usage : null,
    };
  } catch (err) {
    return { credits: null, keyRemaining: null, keyUsage: null, error: (err as Error).message };
  }
}

/** Typical size of each job's question, until FreePoster has seen real ones: [prompt tokens, answer tokens, images]. */
export const TYPICAL_TOKENS = { caption: [1300, 150, 0], frames: [1000, 150, 6], lyrics: [700, 40, 0] } as const;
/** Roughly what a 540×960 still costs in tokens on most models. */
const IMAGE_TOKENS = 800;

/** Estimated USD for one use, from the model's prices and the job's typical (or average seen) size. */
export function estimate(m: ModelInfo, size: { promptTokens: number; completionTokens: number; images: number; measured: boolean }): number {
  // Measured prompt sizes already count the images as tokens.
  const imageTokens = size.measured ? 0 : size.images * IMAGE_TOKENS;
  return (size.promptTokens + imageTokens) * m.prompt + size.completionTokens * m.completion + (size.measured ? 0 : size.images * m.image);
}
