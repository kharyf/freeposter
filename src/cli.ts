// freeposter: a command-line client for a running FreePoster. Every command is one MCP tool call to the app's
// /mcp endpoint, so the CLI and agents can never disagree, and the CLI adds nothing new to secure.
// Standalone on purpose (no imports from the app): it is bundled into one file that runs on any Node 24.
import { readFileSync } from "node:fs";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  /** stdout is a terminal: print readable lines instead of JSON */
  isTTY: boolean;
  stdin(): Promise<string>;
}

export const EXIT = { ok: 0, toolError: 1, usage: 2, notRunning: 3, auth: 4 } as const;

const USAGE = `usage: freeposter <command> [options]

  accounts                                   connected accounts and their ids
  publish <file> --accounts 1,4 [--caption <text>] [--title <text>] [--at <iso>] [--dry-run]
                                             asks you to review it: nothing posts until you approve
  edit <file> [--no-tighten] [--no-captions] [--no-reframe] [--no-audio] [--no-punch-in]
  produce <spec.json | -> [--dry-run] [--wait]
  production [<id>] [--watch]                one production, or the recent ones
  revise <id> <shots-or-spec.json | ->       a JSON list = replacement shots; an object = a whole spec
  review <id> [--accounts 1,4] [--caption <text>] [--title <text>] [--at <iso>] [--edit] [--dry-run]
                                             sends a production (or with --edit, an edit) for review
  reviews [<id>]                             one review, or the recent ones
  audit                                      checks every published post against what was approved
  cancel <id> [--post]                       a production (or with --post, a post)
  posts [<id>]                               recent posts, or one
  tools                                      what productions can use (tools, templates, sound effects)
  call <tool> [<json arguments>]             any MCP tool

  --json   print JSON (the default when output isn't a terminal)

  FREEPOSTER_URL       default http://localhost:4400
  FREEPOSTER_PASSWORD  the app password, when one is set

exit codes: 0 ok, 1 FreePoster refused (message on stderr), 2 usage, 3 FreePoster isn't running, 4 wrong password`;

class Exit extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      const takesValue = ["accounts", "caption", "title", "at"].includes(k);
      flags[k] = inline ?? (takesValue ? argv[++i] ?? "" : true);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const int = (raw: string | undefined, what: string) => {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n)) throw new Exit(EXIT.usage, `${what} must be a whole number\n\n${USAGE}`);
  return n;
};
const ids = (raw: string | true | undefined) =>
  typeof raw === "string" ? raw.split(",").map((s) => int(s.trim(), "--accounts")) : undefined;

export async function main(argv: string[], io: CliIO): Promise<number> {
  const base = (io.env.FREEPOSTER_URL || "http://localhost:4400").replace(/\/$/, "");
  const password = io.env.FREEPOSTER_PASSWORD;
  let rpcId = 0;
  const { positional, flags } = parse(argv);
  const asJson = flags.json === true || !io.isTTY;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pollMs = Number(io.env.FREEPOSTER_POLL_MS) || 5_000;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(password ? { authorization: `Basic ${Buffer.from(`freeposter:${password}`).toString("base64")}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
    } catch {
      throw new Exit(EXIT.notRunning, `FreePoster isn't running at ${base} (start the app, or set FREEPOSTER_URL)`);
    }
    if (res.status === 401) throw new Exit(EXIT.auth, "FreePoster wants its app password: set FREEPOSTER_PASSWORD");
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || !body) throw new Exit(EXIT.toolError, body?.error?.message ?? `FreePoster answered ${res.status}`);
    if (body.error) throw new Exit(EXIT.toolError, body.error.message);
    if (body.result?.isError) throw new Exit(EXIT.toolError, body.result.content?.[0]?.text ?? "FreePoster refused");
    return body.result.structuredContent;
  }

  const print = (value: unknown) => io.out(asJson ? JSON.stringify(value, null, 2) : readable(value));

  const readJson = async (source: string | undefined, what: string) => {
    if (!source) throw new Exit(EXIT.usage, `give ${what} as a file, or - for stdin\n\n${USAGE}`);
    const text = source === "-" ? await io.stdin() : readFileSync(source, "utf8");
    try { return JSON.parse(text); } catch (err) { throw new Exit(EXIT.usage, `${what} isn't valid JSON: ${(err as Error).message}`); }
  };

  /** Follows a production until it settles; 0 when ready or approved. */
  async function watch(id: number): Promise<number> {
    let last = "";
    for (;;) {
      const p = await call("get_production", { production_id: id });
      const line = `${p.state}${p.state === "rendering" ? ` ${Math.round(p.progress * 100)}%` : ""}`;
      if (line !== last) { io.err(`production ${id}: ${line}`); last = line; }
      if (["ready", "approved", "failed", "cancelled", "rejected"].includes(p.state)) {
        print(p);
        return p.state === "ready" || p.state === "approved" ? EXIT.ok : EXIT.toolError;
      }
      await sleep(pollMs);
    }
  }

  try {
    const [cmd, a1, a2] = positional;
    switch (cmd) {
      case "accounts":
        print(await call("list_accounts"));
        return EXIT.ok;
      case "publish":
        if (!a1) throw new Exit(EXIT.usage, USAGE);
        print(await call("publish_video", clean({ video_path: a1, account_ids: ids(flags.accounts), caption: flags.caption, title: flags.title, schedule_at: flags.at, dry_run: flags["dry-run"] === true || undefined })));
        return EXIT.ok;
      case "edit": {
        if (!a1) throw new Exit(EXIT.usage, USAGE);
        const settings = clean({ tighten: off(flags, "tighten"), captions: off(flags, "captions"), reframe: off(flags, "reframe"), audio: off(flags, "audio"), punchIn: off(flags, "punch-in") });
        print(await call("create_edit", clean({ video_path: a1, settings: Object.keys(settings).length ? settings : undefined })));
        return EXIT.ok;
      }
      case "produce": {
        const spec = await readJson(a1, "the spec");
        const dryRun = flags["dry-run"] === true;
        const p = await call("start_production", { spec, dry_run: dryRun });
        if (dryRun || flags.wait !== true) { print(p); return EXIT.ok; }
        return await watch(p.id);
      }
      case "production":
        if (!a1) { print(await call("get_production")); return EXIT.ok; }
        if (flags.watch === true) return await watch(int(a1, "the production id"));
        print(await call("get_production", { production_id: int(a1, "the production id") }));
        return EXIT.ok;
      case "revise": {
        const body = await readJson(a2, "the shots or spec");
        print(await call("revise_production", { production_id: int(a1, "the production id"), ...(Array.isArray(body) ? { shots: body } : { spec: body }) }));
        return EXIT.ok;
      }
      case "review": {
        const id = int(a1, flags.edit === true ? "the edit id" : "the production id");
        print(await call("request_review", clean({ [flags.edit === true ? "edit_id" : "production_id"]: id, account_ids: ids(flags.accounts), caption: flags.caption, title: flags.title, schedule_at: flags.at, dry_run: flags["dry-run"] === true || undefined })));
        return EXIT.ok;
      }
      case "reviews":
        print(await call("get_review", a1 ? { review_id: int(a1, "the review id") } : {}));
        return EXIT.ok;
      case "audit": {
        const audit = await call("audit_reviews");
        print(audit);
        return audit.ok ? EXIT.ok : EXIT.toolError;
      }
      case "cancel":
        print(flags.post === true ? await call("cancel_post", { post_id: int(a1, "the post id") }) : await call("cancel_production", { production_id: int(a1, "the production id") }));
        return EXIT.ok;
      case "posts":
        print(a1 ? await call("get_post", { post_id: int(a1, "the post id") }) : await call("list_posts"));
        return EXIT.ok;
      case "tools":
        print(await call("describe_production_tools"));
        return EXIT.ok;
      case "call": {
        if (!a1) throw new Exit(EXIT.usage, USAGE);
        let args = {};
        if (a2) try { args = JSON.parse(a2); } catch { throw new Exit(EXIT.usage, "the arguments must be a JSON object"); }
        print(await call(a1, args));
        return EXIT.ok;
      }
      case undefined:
      case "help":
        io.out(USAGE);
        return cmd ? EXIT.ok : EXIT.usage;
      default:
        throw new Exit(EXIT.usage, `unknown command ${cmd}\n\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof Exit) { io.err(err.message); return err.code; }
    io.err((err as Error).message);
    return EXIT.toolError;
  }
}

/** --no-<name> → false; otherwise left out (the tool's default). */
const off = (flags: Record<string, string | true>, name: string) => (flags[`no-${name}`] === true ? false : undefined);

function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Plain indented lines for people at a terminal. */
function readable(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return `${indent}-`;
  if (typeof value !== "object") return `${indent}${value}`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(none)`;
    return value.map((v) => (typeof v === "object" && v !== null ? `${indent}-\n${readable(v, `${indent}  `)}` : `${indent}- ${v}`)).join("\n");
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => (typeof v === "object" && v !== null ? `${indent}${k}:\n${readable(v, `${indent}  `)}` : `${indent}${k}: ${v ?? "-"}`))
    .join("\n");
}

// Run as a program (node src/cli.ts, or the bundled freeposter-cli.mjs).
const entry = process.argv[1] ?? "";
if (/cli\.(ts|mjs|js)$/.test(entry)) {
  const code = await main(process.argv.slice(2), {
    out: (t) => process.stdout.write(`${t}\n`),
    err: (t) => process.stderr.write(`${t}\n`),
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
  });
  process.exitCode = code;
}
