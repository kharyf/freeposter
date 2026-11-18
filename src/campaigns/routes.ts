// The Campaigns tab's HTTP API. Everything here is the user's own window: Autorun, the daily cap, the kill switch's
// Resume and the library's CTAs are only changeable from here, never from an agent's MCP tools.
import type { FastifyInstance, FastifyReply } from "fastify";
import { accountSets } from "../accounts.ts";
import { todayUse } from "../ai/budget.ts";
import type { Store } from "../db.ts";
import { trustedRequest } from "../mcp.ts";
import { campaignVocabulary, undoChange } from "./autorun.ts";
import { parseCompiled } from "./spec.ts";
import { CampaignStore, type Campaign, type LibraryKind, type TaskState } from "./store.ts";
import { translateCampaign } from "./translate.ts";
import { iso } from "./view.ts";
import { dayKey, type CampaignWorker } from "./worker.ts";

const KINDS: LibraryKind[] = ["hook", "angle", "cta"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const TEXT_MAX = 20_000;
const FINISHED: TaskState[] = ["posted", "kept", "missed", "failed"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const idParam = (v: unknown): number | null => (typeof v === "string" && /^\d{1,15}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const httpUrl = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** Whether a compiled schedule names this library entry anywhere (an instruction's pick). */
function names(node: unknown, id: number): boolean {
  if (Array.isArray(node)) return node.some((n) => names(n, id));
  if (!isObj(node)) return false;
  if (node.pick === "named" && node.id === id) return true;
  return Object.values(node).some((v) => names(v, id));
}

/** Everything that changes something is for this app's own window or a local agent, never another website (CSRF, DNS rebinding). */
function guarded(app: FastifyInstance, routes: (scope: FastifyInstance) => void) {
  void app.register(async (scope) => {
    scope.addHook("onRequest", async (req, reply) => {
      if (req.method === "GET" || req.method === "HEAD") return;
      const refused = trustedRequest(req);
      if (refused) return reply.code(403).send({ error: refused });
    });
    routes(scope);
  });
}

export function registerCampaignRoutes(root: FastifyInstance, store: Store, worker?: CampaignWorker) {
  guarded(root, (app) => campaignRoutes(app, store, worker));
}

function campaignRoutes(app: FastifyInstance, store: Store, worker?: CampaignWorker) {
  const cs = worker?.campaigns ?? new CampaignStore(store);
  const bad = (reply: FastifyReply, error: string, problems?: string[]) => reply.code(400).send(problems ? { error, problems } : { error });
  const missing = (reply: FastifyReply, what: string, id: number | null) => reply.code(404).send({ error: `no ${what} ${id ?? ""}`.trim() });
  const bodyOf = (req: { body: unknown }) => (isObj(req.body) ? req.body : {});

  /** The campaign as the tab shows it. */
  const view = (c: Campaign) => ({
    id: c.id, name: c.name, text: c.text, textSha: c.textSha, compiled: c.compiled, enabled: c.enabled, autorun: c.autorun,
    runnable: cs.isRunnable(c), confirmedForText: c.compiledSha !== null && c.compiledSha === c.textSha, confirmedAt: c.confirmedAt, accountSetId: c.accountSetId, defaultPostTimes: c.defaultPostTimes,
    dailyPostCap: c.dailyPostCap, excluded: cs.excluded(c.id),
  });
  /** Resolves `:id` to a campaign, or answers 400/404 itself. */
  const campaignOf = (params: unknown, reply: FastifyReply): Campaign | undefined => {
    const id = idParam((params as { id?: string }).id);
    if (id === null) { bad(reply, "id must be a campaign id"); return undefined; }
    const c = cs.campaign(id);
    if (!c) missing(reply, "campaign", id);
    return c;
  };
  const times = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length <= 24 && v.every((t) => typeof t === "string" && TIME.test(t)) ? [...new Set(v as string[])].sort() : null;
  const setExists = (id: unknown) => typeof id === "number" && accountSets(store).some((s) => s.id === id);

  // ---- campaigns ----

  app.get("/api/campaigns", async () => ({ killed: cs.killed(), campaigns: cs.campaigns().map(view), ai: todayUse(store) }));

  app.post("/api/campaigns", async (req, reply) => {
    const b = bodyOf(req);
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 100) return bad(reply, "name is required (at most 100 characters)");
    if (b.text !== undefined && (typeof b.text !== "string" || b.text.length > TEXT_MAX)) return bad(reply, `text must be text of at most ${TEXT_MAX} characters`);
    if (b.accountSetId !== undefined && b.accountSetId !== null && !setExists(b.accountSetId)) return bad(reply, "no such account set");
    const defaultPostTimes = b.defaultPostTimes === undefined ? [] : times(b.defaultPostTimes);
    if (!defaultPostTimes) return bad(reply, 'defaultPostTimes must be a list of 24-hour "HH:MM" times');
    const cap = b.dailyPostCap === undefined ? 3 : b.dailyPostCap;
    if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > 100) return bad(reply, "dailyPostCap must be a whole number from 1 to 100");
    const id = cs.create({ name: b.name.trim(), text: (b.text as string | undefined) ?? "", accountSetId: (b.accountSetId as number | null | undefined) ?? null, defaultPostTimes, dailyPostCap: cap as number });
    return { id, campaign: view(cs.campaign(id)!) };
  });

  /** The user's words → a schedule to look at. Saves the text only; nothing runs until it is confirmed for this exact text. */
  app.put("/api/campaigns/:id/text", async (req, reply) => {
    const c = campaignOf(req.params, reply);
    if (!c) return;
    const text = bodyOf(req).text;
    if (typeof text !== "string" || text.length > TEXT_MAX) return bad(reply, `text must be text of at most ${TEXT_MAX} characters`);
    cs.setText(c.id, text);
    const textSha = cs.campaign(c.id)!.textSha; // before the await: a later edit must not lend its sha to this preview
    const { compiled, couldNotUnderstand } = await translateCampaign({ ai: worker?.ai ?? null }, text, campaignVocabulary(store, cs));
    return { compiled, couldNotUnderstand, textSha };
  });

  app.post("/api/campaigns/:id/confirm", async (req, reply) => {
    const c = campaignOf(req.params, reply);
    if (!c) return;
    const b = bodyOf(req);
    if (typeof b.textSha !== "string" || b.compiled === undefined) return bad(reply, "send the compiled schedule and the textSha it was made from");
    // Never confirm a schedule translated from older text (the text was edited since it was shown).
    if (b.textSha !== c.textSha) return reply.code(409).send({ error: "the text changed since this schedule was made; translate it again" });
    const r = parseCompiled(b.compiled, campaignVocabulary(store, cs));
    if (!r.ok) return bad(reply, "that schedule isn't valid", r.problems);
    cs.confirm(c.id, r.value);
    return view(cs.campaign(c.id)!);
  });

  const toggle = (path: "enabled" | "autorun", set: (id: number, on: boolean) => void) =>
    app.put(`/api/campaigns/:id/${path}`, async (req, reply) => {
      const c = campaignOf(req.params, reply);
      if (!c) return;
      const on = bodyOf(req).on;
      if (typeof on !== "boolean") return bad(reply, "on must be true or false");
      set(c.id, on);
      return view(cs.campaign(c.id)!);
    });
  toggle("enabled", (id, on) => cs.setEnabled(id, on));
  toggle("autorun", (id, on) => cs.setAutorun(id, on));

  app.put("/api/campaigns/:id/cap", async (req, reply) => {
    const c = campaignOf(req.params, reply);
    if (!c) return;
    const cap = bodyOf(req).cap;
    if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > 100) return bad(reply, "cap must be a whole number from 1 to 100");
    cs.setDailyPostCap(c.id, cap as number);
    return view(cs.campaign(c.id)!);
  });

  app.put("/api/campaigns/:id/account-set", async (req, reply) => {
    const c = campaignOf(req.params, reply);
    if (!c) return;
    const id = bodyOf(req).accountSetId;
    if (id !== null && !setExists(id)) return bad(reply, "no such account set");
    cs.setAccountSet(c.id, id as number | null);
    return view(cs.campaign(c.id)!);
  });

  app.put("/api/campaigns/:id/post-times", async (req, reply) => {
    const c = campaignOf(req.params, reply);
    if (!c) return;
    const t = times(bodyOf(req).times);
    if (!t) return bad(reply, 'times must be a list of 24-hour "HH:MM" times');
    cs.setDefaultPostTimes(c.id, t);
    return view(cs.campaign(c.id)!);
  });

  app.get("/api/campaigns/:id/tasks", async (req, reply) => {
    const c = campaignOf(req.params, reply);
    if (!c) return;
    const date = (req.query as { date?: string }).date ?? dayKey(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(reply, "date must be YYYY-MM-DD");
    return { date, tasks: cs.tasksOn(c.id, date) };
  });

  app.get("/api/campaigns/:id/changes", async (req, reply) => {
    const c = campaignOf(req.params, reply);
    if (!c) return;
    return { changes: cs.changes(c.id).map((ch) => ({ ...ch, atIso: iso(ch.at) })) };
  });

  app.post("/api/campaigns/changes/:id/undo", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (id === null) return bad(reply, "id must be a change id");
    if (!cs.change(id)) return missing(reply, "change", id);
    const r = undoChange(cs, id);
    if (!r.ok) return reply.code(409).send({ error: r.problem });
    return { ok: true };
  });

  // ---- the kill switch ----

  app.get("/api/campaigns/status", async () => ({ killed: cs.killed() }));
  app.post("/api/campaigns/stop", async (_req, reply) => {
    if (!worker) return reply.code(503).send({ error: "campaigns aren't running in this FreePoster" });
    return { stopped: true, held: worker.stopAll() };
  });
  app.post("/api/campaigns/resume", async (_req, reply) => {
    if (!worker) return reply.code(503).send({ error: "campaigns aren't running in this FreePoster" });
    return { resumed: true, released: worker.resumeAll() };
  });

  // ---- library ----

  /** Whether a confirmed schedule or a task still being made uses this entry. */
  const inUse = (id: number): string | null => {
    for (const c of cs.campaigns()) if (c.compiled && names(c.compiled, id)) return `the confirmed schedule of "${c.name}"`;
    const inFlight = cs.db
      .prepare(`SELECT campaign_id FROM campaign_tasks WHERE state NOT IN (${FINISHED.map(() => "?").join(",")})
                AND (json_extract(choices, '$.hook.id') = ? OR json_extract(choices, '$.angle.id') = ? OR json_extract(choices, '$.cta.id') = ?) LIMIT 1`)
      .get(...FINISHED, id, id, id) as { campaign_id: number } | undefined;
    return inFlight ? `a video being made for "${cs.campaign(inFlight.campaign_id)?.name ?? "a campaign"}"` : null;
  };
  const keywords = (v: unknown): string[] | null =>
    v === undefined ? [] : Array.isArray(v) && v.length <= 20 && v.every((k) => typeof k === "string" && k.trim() && k.length <= 100) ? v.map((k: string) => k.trim()) : null;
  const short = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

  app.get("/api/library", async (req, reply) => {
    const kind = (req.query as { kind?: string }).kind;
    if (kind !== undefined && !KINDS.includes(kind as LibraryKind)) return bad(reply, "kind must be hook, angle or cta");
    return { entries: cs.entries(kind as LibraryKind | undefined) };
  });

  app.post("/api/library", async (req, reply) => {
    const b = bodyOf(req);
    if (!KINDS.includes(b.kind as LibraryKind)) return bad(reply, "kind must be hook, angle or cta");
    if (!short(b.name, 100)) return bad(reply, "name is required (at most 100 characters)");
    if (!short(b.text, 2000)) return bad(reply, "text is required (at most 2000 characters)");
    const kw = keywords(b.keywords);
    if (!kw) return bad(reply, "keywords must be a list of up to 20 words");
    if (b.kind === "cta" && !httpUrl(b.url)) return bad(reply, "a CTA needs a link that starts with http:// or https://");
    const id = cs.addEntry({ kind: b.kind as LibraryKind, name: (b.name as string).trim(), text: (b.text as string).trim(), keywords: kw, ...(b.kind === "cta" ? { url: b.url as string } : {}) });
    return { id, entry: cs.entry(id) };
  });

  app.put("/api/library/:id", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    const entry = id === null ? undefined : cs.entry(id);
    if (id === null || !entry) return missing(reply, "library entry", id);
    const b = bodyOf(req);
    const patch: { name?: string; text?: string; keywords?: string[]; url?: string } = {};
    if (b.name !== undefined) { if (!short(b.name, 100)) return bad(reply, "name must be 1 to 100 characters"); patch.name = (b.name as string).trim(); }
    if (b.text !== undefined) { if (!short(b.text, 2000)) return bad(reply, "text must be 1 to 2000 characters"); patch.text = (b.text as string).trim(); }
    if (b.keywords !== undefined) { const kw = keywords(b.keywords); if (!kw) return bad(reply, "keywords must be a list of up to 20 words"); patch.keywords = kw; }
    if (b.url !== undefined) {
      if (entry.kind !== "cta") return bad(reply, "only a CTA has a link");
      if (!httpUrl(b.url)) return bad(reply, "a CTA needs a link that starts with http:// or https://");
      patch.url = b.url;
    }
    cs.updateEntry(id, patch);
    return { entry: cs.entry(id) };
  });

  app.delete("/api/library/:id", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (id === null || !cs.entry(id)) return missing(reply, "library entry", id);
    const used = inUse(id);
    if (used) return reply.code(409).send({ error: `it's still used by ${used}; take it out of there first` });
    cs.deleteEntry(id);
    return { ok: true };
  });

  // ---- types ----

  app.get("/api/types", async () => ({ types: cs.types() }));

  app.post("/api/types", async (req, reply) => {
    const b = bodyOf(req);
    if (!short(b.name, 50)) return bad(reply, "name is required (at most 50 characters)");
    if (typeof b.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(b.color)) return bad(reply, 'color must look like "#ff8800"');
    const name = (b.name as string).trim();
    if (cs.types().some((t) => t.name.toLowerCase() === name.toLowerCase())) return bad(reply, `there is already a type called "${name}"`);
    const id = cs.addType({ name, color: b.color });
    return { id, types: cs.types() };
  });

  app.put("/api/types/:id/auto-post", async (req, reply) => {
    const id = idParam((req.params as { id: string }).id);
    if (id === null || !cs.types().some((t) => t.id === id)) return missing(reply, "type", id);
    const on = bodyOf(req).on;
    if (typeof on !== "boolean") return bad(reply, "on must be true or false");
    cs.setTypeAutoPost(id, on);
    return { types: cs.types() };
  });
}
