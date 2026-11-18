// Autorun: a campaign the user switched it on for may be changed by the connected agent, "however it thinks is
// best", inside fixed limits. Plain code decides what's allowed; nothing here asks AI except the translation of new
// campaign text (the same translator the user's own edits use). What an agent may never do: change a CTA (its URL,
// adding one, or using a CTA this campaign doesn't already use), raise the daily post cap, change a type's "post
// without approval", touch the kill switch, or turn Autorun on or off. Every change needs a reason, is logged whole
// (the campaign before and after) and notified, and can be undone while nothing has changed since.
import type { AiService } from "../ai/router.ts";
import { AnalyticsStore } from "../analytics/store.ts";
import type { Store } from "../db.ts";
import { allStyles, styleToken } from "../edit/styles.ts";
import { queueEvent } from "../notify.ts";
import { DAYS, parseCompiled, type CompiledCampaign, type Vocabulary } from "./spec.ts";
import { roundTrip } from "./render.ts";
import { translateCampaign } from "./translate.ts";
import type { Campaign, CampaignStore, LibraryEntry } from "./store.ts";

export interface AgentEntry {
  kind: "hook" | "angle";
  name: string;
  text: string;
  keywords?: string[];
}

export interface AgentChange {
  text?: string;
  compiled?: unknown;
  dailyPostCap?: number;
  addEntries?: AgentEntry[];
}

export const REASON_MAX = 500;
const TEXT_MAX = 20_000;
const ENTRIES_MAX = 20;

/** Fields an agent might send that it may never change, with why. */
const FORBIDDEN: Record<string, string> = {
  autorun: "an agent can't turn Autorun on or off; only the user can",
  killed: "an agent can't touch the kill switch (stop_campaigns stops everything; only the user resumes)",
  kill: "an agent can't touch the kill switch (stop_campaigns stops everything; only the user resumes)",
  autoPost: "an agent can't change whether a type may post without approval",
  types: "an agent can't change video types or their approval switch",
  cta: "an agent can't change CTAs",
  ctas: "an agent can't change CTAs",
  url: "an agent can't change CTA URLs",
  enabled: "an agent can't switch a campaign on or off",
};

/** What the compiler may name right now: the user's styles, video types and library. */
export function campaignVocabulary(store: Store, cs: CampaignStore): Vocabulary {
  return {
    styles: allStyles(store).map((s) => ({ id: s.id, token: styleToken(s) })),
    types: cs.types().map((t) => ({ id: t.id, name: t.name })),
    hooks: cs.entries("hook"),
    angles: cs.entries("angle"),
    ctas: cs.entries("cta"),
  };
}

/**
 * Which CTAs a schedule can end its videos with: each named one, "random"/"best" when a line picks from the whole
 * library, and the ways a make rule can bring in a CTA (varying it at random, or matching one by its score).
 */
function ctaRefs(c: CompiledCampaign | null): Map<string, string> {
  const refs = new Map<string, string>();
  if (!c) return refs;
  for (const d of DAYS) {
    (c.days[d] ?? []).forEach((ins, i) => {
      if (ins.kind !== "make") return;
      const key = ins.cta.pick === "named" ? `named:${ins.cta.id}` : ins.cta.pick;
      if (!refs.has(key)) refs.set(key, `days.${d}[${i}].cta`);
    });
  }
  c.rules.forEach((r, i) => {
    if (r.then.kind !== "make") return;
    if (r.then.vary.includes("cta") && !refs.has("rule-vary")) refs.set("rule-vary", `rules[${i}].then.vary`);
    if (r.when.label === "cta" && !refs.has(`rule-label:${r.when.scope}`)) refs.set(`rule-label:${r.when.scope}`, `rules[${i}].when`);
  });
  return refs;
}

/** Every video type a schedule's lines attach, and the scopes of its make rules that attach a type by its score. */
function typeRefs(c: CompiledCampaign | null): { ids: Set<number>; ruleScopes: Set<string> } {
  const ids = new Set<number>(), ruleScopes = new Set<string>();
  for (const d of DAYS) for (const ins of c?.days[d] ?? []) for (const t of ins.types) ids.add(t);
  for (const r of c?.rules ?? []) if (r.then.kind === "make" && r.when.label === "type") ruleScopes.add(r.when.scope);
  return { ids, ruleScopes };
}

/** Each named hook, angle or CTA in a schedule, with where. */
function namedRefs(c: CompiledCampaign | null): { id: number; where: string }[] {
  const out: { id: number; where: string }[] = [];
  for (const d of DAYS) (c?.days[d] ?? []).forEach((ins, i) => {
    if (ins.kind !== "make") return;
    for (const k of ["hook", "angle", "cta"] as const) { const p = ins[k]; if (p.pick === "named") out.push({ id: p.id, where: `days.${d}[${i}].${k}` }); }
  });
  return out;
}

/**
 * What a new schedule may not bring in that this campaign's confirmed one didn't have: another CTA, a type that
 * posts without approval, a library entry another campaign's Autorun added.
 */
function limitProblems(cs: CampaignStore, c: Campaign, next: CompiledCampaign, vocab: Vocabulary): string[] {
  const problems: string[] = [];
  const had = ctaRefs(c.compiled);
  for (const [key, where] of ctaRefs(next)) {
    if (!had.has(key)) problems.push(`${where}: this campaign doesn't already use that CTA; Autorun can only re-use the campaign's own CTAs`);
  }
  const auto = cs.types().filter((t) => t.autoPost);
  const old = typeRefs(c.compiled), now = typeRefs(next);
  for (const t of auto) {
    if (now.ids.has(t.id) && !old.ids.has(t.id)) problems.push(`type "${t.name}" posts without approval and this campaign doesn't already use it; only the user can attach it`);
  }
  const unused = auto.filter((t) => !old.ids.has(t.id));
  for (const scope of now.ruleScopes) {
    if (!old.ruleScopes.has(scope) && unused.length) problems.push(`a type rule could attach a type that posts without approval (${unused.map((t) => `"${t.name}"`).join(", ")}); only the user can add one`);
  }
  const library = new Map([...vocab.hooks, ...vocab.angles, ...vocab.ctas].map((e) => [e.id, e]));
  const own = new Set(namedRefs(c.compiled).map((r) => r.id));
  for (const r of namedRefs(next)) {
    const owner = library.get(r.id)?.ownerCampaignId;
    if (owner != null && owner !== c.id && !own.has(r.id)) problems.push(`${r.where}: "${library.get(r.id)!.name}" belongs to another campaign's Autorun`);
  }
  return problems;
}

/** The parts of a campaign a change writes (and an undo restores). */
const state = (c: Campaign) => JSON.stringify([c.text, c.textSha, c.compiled, c.compiledSha, c.confirmedAt, c.dailyPostCap]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The problems with a change before anything is translated: shape, limits, what may never change. */
function precheck(c: Campaign, change: unknown, reason: unknown): string[] {
  const problems: string[] = [];
  if (!c.autorun) return [`Autorun is off for campaign "${c.name}": only the user can change it`];
  if (typeof reason !== "string" || !reason.trim()) problems.push("a reason is required: say why you're making this change");
  else if (reason.length > REASON_MAX) problems.push(`the reason must be at most ${REASON_MAX} characters`);
  if (!isObj(change)) return [...problems, "the change must be an object"];
  for (const k of Object.keys(change)) {
    if (["text", "compiled", "dailyPostCap", "addEntries"].includes(k)) continue;
    problems.push(FORBIDDEN[k] ?? `unknown field "${k}" (an agent can change text, compiled, dailyPostCap and addEntries)`);
  }
  if (["text", "compiled", "dailyPostCap", "addEntries"].every((k) => change[k] === undefined)) problems.push("the change changes nothing");
  if (change.text !== undefined && change.compiled !== undefined) {
    problems.push("give text or compiled, not both: a schedule change rewrites the text itself, and new text is translated into the schedule");
  }
  // A draft of the user's (text not confirmed yet) is theirs to confirm: a new schedule would confirm it unseen.
  if ((change.text !== undefined || change.compiled !== undefined) && c.textSha !== c.compiledSha) {
    problems.push("the user is editing this campaign's text; wait until they confirm it");
  }
  if (change.text !== undefined && (typeof change.text !== "string" || !change.text.trim() || change.text.length > TEXT_MAX)) {
    problems.push(`text must be non-empty, at most ${TEXT_MAX} characters`);
  }
  if (change.dailyPostCap !== undefined) {
    const cap = change.dailyPostCap;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) problems.push("dailyPostCap must be a whole number of at least 1");
    else if (cap > c.dailyPostCap) problems.push(`the daily post cap can only go down: it's ${c.dailyPostCap}, and only the user can raise it`);
  }
  if (change.addEntries !== undefined) {
    const list = change.addEntries;
    if (!Array.isArray(list) || list.length > ENTRIES_MAX) problems.push(`addEntries must be a list of at most ${ENTRIES_MAX} hooks or angles`);
    else list.forEach((e, i) => {
      const at = `addEntries[${i}]`;
      if (!isObj(e)) { problems.push(`${at} must be an object`); return; }
      for (const k of Object.keys(e)) if (!["kind", "name", "text", "keywords"].includes(k)) problems.push(k === "url" ? `${at}: ${FORBIDDEN.url}` : `${at}: unknown field "${k}"`);
      if (e.kind !== "hook" && e.kind !== "angle") problems.push(`${at}: only hooks and angles can be added (an agent can't add CTAs)`);
      if (typeof e.name !== "string" || !e.name.trim() || e.name.length > 100) problems.push(`${at}.name must be non-empty, at most 100 characters`);
      if (typeof e.text !== "string" || !e.text.trim() || e.text.length > 2000) problems.push(`${at}.text must be non-empty, at most 2000 characters`);
      if (e.keywords !== undefined && (!Array.isArray(e.keywords) || e.keywords.length > 20 || e.keywords.some((k) => typeof k !== "string" || k.length > 100))) {
        problems.push(`${at}.keywords must be a list of at most 20 short words`);
      }
    });
  }
  return problems;
}

/**
 * Applies an agent's change to an Autorun campaign, or refuses it with every problem found. A new text is translated
 * (plain parser, then the AI fallback) and every unread line refuses the change; a compiled schedule must pass the
 * strict check and be one the campaign text can say exactly (the text is rewritten to say it). Not both at once,
 * and neither while the user's own text edit waits to be confirmed. The resulting schedule is confirmed directly:
 * Autorun is the user's authority for it. Hooks and angles it adds belong to this campaign and can be named by that
 * same change's text or schedule.
 */
export async function applyAgentChange(
  cs: CampaignStore,
  campaignId: number,
  change: AgentChange,
  agent: string,
  reason: string,
  vocab: Vocabulary,
  deps: { ai: Pick<AiService, "ask"> | null } = { ai: null },
): Promise<{ ok: true; changeId: number } | { ok: false; problems: string[] }> {
  const c = cs.campaign(campaignId);
  if (!c) return { ok: false, problems: [`no campaign ${campaignId}`] };
  const pre = precheck(c, change, reason);
  if (pre.length) return { ok: false, problems: pre };

  // Hooks and angles to add get stand-in ids (negative, never real) until the change is accepted.
  const adds = (change.addEntries ?? []).map((e, i): LibraryEntry => ({
    id: -(i + 1), kind: e.kind, name: e.name.trim(), text: e.text.trim(), keywords: e.keywords ?? [], url: null, ownerCampaignId: campaignId, createdAt: 0,
  }));
  const withAdds: Vocabulary = {
    ...vocab,
    hooks: [...vocab.hooks, ...adds.filter((e) => e.kind === "hook")],
    angles: [...vocab.angles, ...adds.filter((e) => e.kind === "angle")],
  };

  let compiled: CompiledCampaign | null = null;
  let text: string | null = change.text ?? null;
  if (change.compiled !== undefined) {
    const r = parseCompiled(change.compiled, withAdds);
    if (!r.ok) return { ok: false, problems: r.problems };
    // The text is rewritten to say the new schedule, so it always describes what runs.
    const rt = roundTrip(r.value, withAdds);
    if (!rt.ok) return { ok: false, problems: [rt.problem] };
    compiled = rt.compiled;
    text = rt.text;
  } else if (change.text !== undefined) {
    const t = await translateCampaign(deps, change.text, withAdds);
    if (t.couldNotUnderstand.length) return { ok: false, problems: t.couldNotUnderstand.map((l) => `couldn't understand: "${l}"`) };
    const r = parseCompiled(t.compiled, withAdds);
    if (!r.ok) return { ok: false, problems: r.problems };
    compiled = r.value;
  }

  if (compiled) {
    const problems = limitProblems(cs, c, compiled, withAdds);
    if (problems.length) return { ok: false, problems };
  }

  // The translation may have waited on AI: refuse if the user changed the campaign (or Autorun) meanwhile.
  const now = cs.campaign(campaignId);
  if (!now || !now.autorun || state(now) !== state(c)) return { ok: false, problems: ["the campaign changed while this change was being checked; read it again and retry"] };

  const db = cs.db;
  db.exec("BEGIN");
  let changeId: number;
  let after: Campaign;
  try {
    const realId = new Map<number, number>();
    for (const e of adds) realId.set(e.id, cs.addEntry({ kind: e.kind, name: e.name, text: e.text, keywords: e.keywords, ownerCampaignId: campaignId }));
    if (compiled) {
      for (const d of DAYS) for (const ins of compiled.days[d]) {
        if (ins.kind !== "make") continue;
        for (const k of ["hook", "angle"] as const) {
          const p = ins[k];
          if (p.pick === "named" && p.id < 0) ins[k] = { pick: "named", id: realId.get(p.id)! };
        }
      }
    }
    if (text !== null && text !== c.text) cs.setText(campaignId, text);
    if (compiled) cs.confirm(campaignId, compiled);
    if (change.dailyPostCap !== undefined) cs.setDailyPostCap(campaignId, change.dailyPostCap);
    after = cs.campaign(campaignId)!;
    changeId = cs.logChange({ campaignId, agent, before: c, after: { ...after, addedEntryIds: [...realId.values()] }, reason: reason.trim() });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const what = [
    change.text !== undefined ? "its text" : compiled ? "its schedule" : null,
    change.dailyPostCap !== undefined ? `its daily post cap (${c.dailyPostCap} → ${after.dailyPostCap})` : null,
    adds.length ? `the library (${adds.map((e) => `${e.kind} "${e.name}"`).join(", ")})` : null,
  ].filter(Boolean).join(", ");
  queueEvent(cs.store, "campaign.changed", `campaign.changed:${changeId}`,
    { campaign_id: campaignId, change_id: changeId, agent, reason: reason.trim() },
    `Autorun (${agent}) changed campaign "${c.name}": ${what}. Reason: ${reason.trim()}`);
  return { ok: true, changeId };
}

/** Whether anything still uses a library entry: a campaign's schedule, a campaign task, or a video's labels. */
function entryUsed(cs: CampaignStore, id: number): boolean {
  for (const c of cs.campaigns()) {
    for (const d of DAYS) for (const ins of c.compiled?.days[d] ?? []) {
      if (ins.kind === "make" && [ins.hook, ins.angle, ins.cta].some((p) => p.pick === "named" && p.id === id)) return true;
    }
  }
  if (cs.db.prepare("SELECT 1 FROM campaign_tasks WHERE json_extract(choices, '$.hook.id') = ? OR json_extract(choices, '$.angle.id') = ? LIMIT 1").get(id, id)) return true;
  new AnalyticsStore(cs.store); // its tables, when nothing has made them yet
  return Boolean(cs.db.prepare("SELECT 1 FROM video_labels WHERE hook_id = ? OR angle_id = ? LIMIT 1").get(id, id));
}

/**
 * Undoes one agent change: the campaign's text, schedule (and what it was confirmed for) and cap go back to what
 * they were, and the hooks and angles it added go unless something uses them by now. Refused once undone, or when
 * the campaign has changed since (undo the later changes first).
 */
export function undoChange(cs: CampaignStore, changeId: number): { ok: true } | { ok: false; problem: string } {
  const ch = cs.change(changeId);
  if (!ch) return { ok: false, problem: `no change ${changeId}` };
  if (ch.undoneAt !== null) return { ok: false, problem: "this change was already undone" };
  const c = cs.campaign(ch.campaignId);
  if (!c) return { ok: false, problem: "its campaign is gone" };
  const before = ch.before as Campaign;
  const after = ch.after as Campaign & { addedEntryIds?: number[] };
  if (state(c) !== state(after)) return { ok: false, problem: "the campaign has changed since; undo the later changes first" };
  const db = cs.db;
  db.exec("BEGIN");
  try {
    cs.restore(c.id, before);
    for (const id of after.addedEntryIds ?? []) if (!entryUsed(cs, id)) cs.deleteEntry(id);
    cs.markUndone(changeId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true };
}
