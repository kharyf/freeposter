// /agent/v1: a compact REST API over the same ops the MCP server offers, for agents that would rather not load
// every tool schema. Plain text for the index and docs, compact JSON for results. Imports no src/mcp.ts.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { compact, parseFields, pick } from "./compact.ts";
import { ToolError, type Tool } from "./errors.ts";
import { GUIDES, GUIDE_TOPICS } from "./guides.ts";
import { trustedRequest } from "./guard.ts";
import { levenshtein, renderDoc, signature, summary, validate } from "./schema.ts";

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
  const given = args ?? {};
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

export function registerAgentApi(app: FastifyInstance, tools: Tool[], setAgent: (name: string) => void) {
  const index = [
    "FreePoster agent API. POST /agent/v1/<op> with JSON args → compact JSON.",
    "You can't approve: only the user's tap does. Read GET /agent/v1/guide/rules once.",
    `Batch: POST /agent/v1 [{"op","args","fields"}]. Docs: GET /agent/v1/<op>. Guides: ${GUIDE_TOPICS.join(" ")}.`,
    ...tools.map((t) => `${signature(t.name, t.inputSchema)} — ${summary(t.description)}`),
  ].join("\n");

  // Its own plugin, so the empty-body parser below applies to /agent/v1 and nowhere else.
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
        if (hasBody && !req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
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

    api.get("/agent/v1", async (_req, reply) => text(reply, index));

    api.get<{ Params: { topic: string } }>("/agent/v1/guide/:topic", async (req, reply) => {
      const topic = req.params.topic;
      if (!Object.hasOwn(GUIDES, topic)) return reply.code(404).type("text/plain; charset=utf-8").send(`no guide ${topic}; guides: ${GUIDE_TOPICS.join(" ")}`);
      return text(reply, GUIDES[topic as keyof typeof GUIDES]);
    });

    api.get<{ Params: { op: string } }>("/agent/v1/:op", async (req, reply) => {
      const tool = tools.find((t) => t.name === req.params.op);
      if (!tool) throw unknownOp(tools, req.params.op);
      return text(reply, renderDoc(tool));
    });

    api.post<{ Params: { op: string }; Querystring: { fields?: string } }>("/agent/v1/:op", async (req, reply) => {
      noteAgent(req);
      const result = await runOp(tools, req.params.op, req.body, parseFields(req.query.fields));
      return reply.type("application/json").send(JSON.stringify(result ?? {}));
    });

    api.post("/agent/v1", async (req, reply) => {
      noteAgent(req);
      const items = req.body;
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
      return reply.type("application/json").send(JSON.stringify(out));
    });
  });
}
