// LM Studio: models running on this computer, asked through LM Studio's local server (its OpenAI-compatible API).
// Free and private; nothing to install beyond LM Studio itself with its server started.
import { schemaProblem } from "./answer.ts";
import { strictSchema, type Answer, type Question } from "./providers.ts";

export const DEFAULT_SERVER = "http://localhost:1234";

export type Fetch = typeof fetch;

export interface LmModel {
  /** LM Studio's model key, as its API takes it */
  id: string;
  /** can look at images (a vision model) */
  vision: boolean;
  /** in memory now, so it answers without loading first */
  loaded: boolean;
}

/** A server address as typed: trimmed, without a trailing slash or `/v1`; blank means LM Studio's default. */
export function serverOf(url: string | undefined): string {
  const u = (url ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!u) return DEFAULT_SERVER;
  if (!/^https?:\/\/\S+$/.test(u)) throw new Error("the LM Studio server address must start with http:// or https://");
  return u;
}

const unreachable = (server: string, err: unknown) =>
  new Error(`LM Studio's server isn't answering at ${server} (${(err as Error).message}). Open LM Studio, go to Developer and start the server.`);

/**
 * The chat models LM Studio has downloaded (embedding models left out), loaded ones first. Its own API says which are
 * vision models and which are loaded; an older LM Studio without it gives just the ids.
 */
export async function models(server: string, f: Fetch = fetch): Promise<LmModel[]> {
  let res: Response;
  try {
    res = await f(`${server}/api/v0/models`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw unreachable(server, err);
  }
  if (res.ok) {
    const { data } = (await res.json()) as { data: { id: string; type?: string; state?: string; capabilities?: string[] }[] };
    return data
      .filter((m) => m.type === "llm" || m.type === "vlm")
      .map((m) => ({ id: m.id, vision: m.type === "vlm" || (m.capabilities ?? []).includes("vision"), loaded: m.state === "loaded" }))
      .sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.id.localeCompare(b.id));
  }
  const old = await f(`${server}/v1/models`, { signal: AbortSignal.timeout(10_000) });
  if (!old.ok) throw new Error(`LM Studio's model list didn't load (HTTP ${old.status})`);
  const { data } = (await old.json()) as { data: { id: string }[] };
  return data.filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, vision: false, loaded: false }));
}

/** A reply's JSON: thinking models write their reasoning in <think> first, and some wrap the answer in a code fence. */
export function replyJson(text: string): unknown {
  const bare = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(bare);
}

/**
 * One question, answered under the schema by `model`. A model that isn't loaded yet is loaded by LM Studio first,
 * which can take a while on a slow disk, so the wait is long.
 */
export async function ask<T>(q: Question, server: string, model: string, f: Fetch = fetch): Promise<Answer<T>> {
  const images = q.images ?? [];
  const content = images.length
    ? [{ type: "text", text: q.prompt }, ...images.map((img) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.toString("base64")}` } }))]
    : q.prompt;
  let res: Response;
  try {
    res = await f(`${server}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: q.system }, { role: "user", content }],
        // LM Studio holds the model to the schema while it writes; the answer is still checked against the real one.
        response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: strictSchema(q.schema) } },
        stream: false,
      }),
      signal: AbortSignal.timeout(600_000),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new Error(`${model} took over 10 minutes to answer`);
    throw unreachable(server, err);
  }
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || body.error) throw new Error(`LM Studio: ${body.error?.message ?? body.error ?? `HTTP ${res.status}`}`);
  const text: string = body.choices?.[0]?.message?.content ?? "";
  let answer: T;
  try {
    answer = replyJson(text) as T;
  } catch {
    throw new Error(`${model}'s reply wasn't JSON: ${text.slice(0, 200)}`);
  }
  const problem = schemaProblem(q.schema as any, answer);
  if (problem) throw new Error(`${model}'s reply didn't fit: ${problem}`);
  const usage = body.usage ?? {};
  return { answer, cost: 0, promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null, model: body.model ?? model };
}
