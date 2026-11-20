// /agent/v1: a compact REST API over the same ops the MCP server offers, for agents that would rather not load
// every tool schema. Plain text for the index and docs, compact JSON for results. Imports no src/mcp.ts.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { compact, parseFields, pick } from "./compact.ts";
import { ToolError, type Tool } from "./errors.ts";
import { GUIDES, GUIDE_TOPICS } from "./guides.ts";
import { trustedRequest } from "./guard.ts";
import { dropNulls, levenshtein, renderDoc, signature, summary, validate } from "./schema.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BATCH = 20;

function unknownOp(tools: Tool[], name: string): ApiError {
  const near = tools.map((t) => [t.name, levenshtein(name, t.name)] as const).filter(([, d]) => d <= 3).sort((a, b) => a[1] - b[1])[0];
  return new ApiError(404, `unknown op ${name}${near ? ` (did you mean ${near[0]}?)` : ""}; GET /agent/v1 lists them`);
}

/** Finds, validates and runs one op; the result is compact, and projected onto `fields` when given. */
export async function runOp(tools: Tool[], name: string, args: unknown, fields?: string[]): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw unknownOp(tools, name);
  const given = args && typeof args === "object" && !Array.isArray(args) ? dropNulls(args as Record<string, unknown>) : args ?? {};
  try {
    validate(tool.inputSchema, given);
  } catch (err) {
    if (err instanceof ToolError) throw new ApiError(400, err.message);
    throw err;
  }
  let result: unknown;
  try {
    result = await tool.run(given as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ToolError) throw new ApiError(422, err.message);
    throw err;
  }
  const out = compact(result);
  return fields ? pick(out, fields) : out;
}

/** The op index (GET /agent/v1, fp_help with no args). */
export function indexText(tools: Tool[]): string {
  return [
    "FreePoster agent API. POST /agent/v1/<op> with JSON args → compact JSON.",
    "You can't approve: only the user's tap does. Read GET /agent/v1/guide/rules once.",
    `Batch: POST /agent/v1 [{"op","args","fields"}]. Docs: GET /agent/v1/<op>. Guides: ${GUIDE_TOPICS.join(" ")}.`,
    ...tools.map((t) => `${signature(t.name, t.inputSchema)} — ${summary(t.description)}`),
  ].join("\n");
}

/** One op's docs (GET /agent/v1/<op>, fp_help op). */
export function opDoc(tools: Tool[], name: string): string {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw unknownOp(tools, name);
  return renderDoc(tool);
}

/** A guide's text, or null for an unknown topic. */
export function guideText(topic: string): string | null {
  return Object.hasOwn(GUIDES, topic) ? GUIDES[topic as keyof typeof GUIDES] : null;
}

export const noGuide = (topic: string) => `no guide ${topic}; guides: ${GUIDE_TOPICS.join(" ")}`;

/** Runs a batch of {op, args, fields}: at most 20 objects, each result {ok} or {error, status}. */
export async function runBatch(tools: Tool[], items: unknown): Promise<unknown[]> {
  if (!Array.isArray(items)) throw new ApiError(400, "send a JSON array of {op, args, fields}");
  if (items.length > MAX_BATCH) throw new ApiError(400, `at most ${MAX_BATCH} items per batch`);
  if (items.some((i) => typeof i !== "object" || i === null || Array.isArray(i))) throw new ApiError(400, "every item must be an object {op, args, fields}");
  const out: unknown[] = [];
  for (const item of items as { op?: unknown; args?: unknown; fields?: unknown }[]) {
    try {
      if (typeof item.op !== "string") throw new ApiError(400, "op must be a string");
      if (item.op === "wait_for_events") throw new ApiError(400, "wait_for_events can't be batched");
      out.push({ ok: (await runOp(tools, item.op, item.args, parseFields(item.fields))) ?? {} });
    } catch (err) {
      if (err instanceof ApiError) out.push({ error: err.message, status: err.status });
      else {
        console.error("agent api:", (err as Error).message);
        out.push({ error: "internal error", status: 500 });
      }
    }
  }
  return out;
}

export function registerAgentApi(app: FastifyInstance, tools: Tool[], setAgent: (name: string) => void) {
  const index = indexText(tools);

  // Its own plugin under the prefix, so the empty-body parser and the 404 handler apply to /agent/v1 and nowhere else.
  app.register(async (api) => {
    api.removeAllContentTypeParsers();
    api.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      const text = (body as string).trim();
      if (!text) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        done(new ApiError(400, "body is not valid JSON"));
      }
    });
    // Anything else is refused by the onRequest hook below when it has a body; with none, nothing parses it.
    api.addContentTypeParser("*", (_req, _payload, done) => done(null, {}));

    api.addHook("onRequest", async (req, reply) => {
      const refused = trustedRequest(req);
      if (refused) return reply.code(403).send({ error: refused });
      if (req.method === "POST") {
        const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
        // Fastify picks the JSON parser by the exact media type; anything else would reach "*" and lose its body.
        const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (hasBody && mediaType !== "application/json") {
          return reply.code(415).send({ error: "send the arguments as application/json" });
        }
      }
    });

    api.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
      const status = err instanceof ApiError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
      if (status >= 500) console.error("agent api:", err.message);
      reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
    });

    const noteAgent = (req: FastifyRequest) => {
      const raw = req.headers["x-freeposter-agent"];
      const name = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 100);
      setAgent(name || "agent");
    };
    const text = (reply: { type(t: string): any }, body: string) => reply.type("text/plain; charset=utf-8").send(body);

    api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found; GET /agent/v1 lists the ops" }));

    api.get("/", async (_req, reply) => text(reply, index));

    api.get<{ Params: { topic: string } }>("/guide/:topic", async (req, reply) => {
      const topic = req.params.topic;
      const guide = guideText(topic);
      if (guide === null) return reply.code(404).type("text/plain; charset=utf-8").send(noGuide(topic));
      return text(reply, guide);
    });

    api.get<{ Params: { op: string } }>("/:op", async (req, reply) => {
      return text(reply, opDoc(tools, req.params.op));
    });

    api.post<{ Params: { op: string }; Querystring: { fields?: string } }>("/:op", async (req, reply) => {
      noteAgent(req);
      const result = await runOp(tools, req.params.op, req.body, parseFields(req.query.fields));
      return reply.type("application/json").send(JSON.stringify(result ?? {}));
    });

    api.post("/", async (req, reply) => {
      noteAgent(req);
      const out = await runBatch(tools, req.body);
      return reply.type("application/json").send(JSON.stringify(out));
    });
  }, { prefix: "/agent/v1" });
}
