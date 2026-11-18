// Campaign rules ("when analytics show that a hook on this campaign is working, create 3 variant videos that all use
// that hook"), checked by plain code after each analytics refresh. FreePoster only ever acts on analytics when a
// campaign's own text says to, and never with AI.
//  - "working": among the rule's scope's library values (scope campaign: this campaign's labelled videos; account:
//    every labelled video on the campaign's account set's accounts) with at least minVideos final (not provisional)
//    scores at the rule's age, those whose median overall score is in the top thresholdPct of the account baseline's
//    percentile scale (median ≥ 100 − thresholdPct); "not working", the bottom (median ≤ thresholdPct). Only
//    library values act: free text from a recorded video has no id, so it never matches.
//  - A rule fires at most once per matched value, ever (rule_firings, key "<label>:<value>").
//  - make: its copies are tasks dated today, made by the campaign worker's one pipeline and placed under the daily
//    post cap like any other. The matched label is held to the match; vary labels are random; everything else is
//    copied from this campaign's newest make instruction that produced a matched video, else its own first make
//    line (never another campaign's, even under account scope). The CTA always comes from this campaign (see
//    ruleInstruction); a rule never invents one. A match that can't be built fires nothing and is told once.
//  - stop_using: the hook, angle or CTA leaves this campaign's random and best picks; named lines keep using it.
//  - Stopped (the kill switch): nothing is evaluated, so nothing is used up either.
import { defaultSetId, setAccounts } from "../accounts.ts";
import { compareLabels, scoreVideos, type ScoreAge, type VideoScore } from "../analytics/score.ts";
import type { AnalyticsStore } from "../analytics/store.ts";
import type { VideoLabels } from "../analytics/types.ts";
import type { Store } from "../db.ts";
import { styleById } from "../edit/styles.ts";
import { queueEvent } from "../notify.ts";
import { DAYS, type MakeInstruction, type Pick, type Rule } from "./spec.ts";
import type { Campaign, CampaignStore, LibraryEntry, LibraryKind } from "./store.ts";
import type { CampaignWorker, TaskChoices } from "./worker.ts";

export interface RuleDeps {
  store: Store;
  analytics: AnalyticsStore;
  campaigns: CampaignStore;
  worker: CampaignWorker;
  now: number;
}

export interface Firing {
  campaignId: number;
  ruleIndex: number;
  key: string;
}

const LIBRARY: LibraryKind[] = ["hook", "angle", "cta"];
const isLibrary = (l: string): l is LibraryKind => (LIBRARY as string[]).includes(l);

/** The label value a video carries for a rule's label, as compareLabels keys it; library values only. */
function hasValue(l: VideoLabels, label: Rule["when"]["label"]): boolean {
  switch (label) {
    case "hook": return l.hookId !== null;
    case "angle": return l.angleId !== null;
    case "cta": return l.ctaId !== null;
    case "style": return l.styleId !== null;
    case "type": return l.types.length > 0;
  }
}

function keysOf(l: VideoLabels, label: Rule["when"]["label"]): string[] {
  switch (label) {
    case "hook": return l.hookId === null ? [] : [String(l.hookId)];
    case "angle": return l.angleId === null ? [] : [String(l.angleId)];
    case "cta": return l.ctaId === null ? [] : [String(l.ctaId)];
    case "style": return l.styleId ? [l.styleId] : [];
    case "type": return l.types.map(String);
  }
}

/** Checks every rule of every runnable campaign against the current scores, acting on each new match. */
export function evaluateRules(deps: RuleDeps): { fired: Firing[] } {
  const { store, analytics, campaigns, now } = deps;
  const fired: Firing[] = [];
  if (campaigns.killed()) return { fired };
  const list = campaigns.campaigns().filter((c) => campaigns.isRunnable(c) && c.compiled?.rules.length);
  if (!list.length) return { fired };
  const labels = analytics.allLabels();
  if (!labels.length) return { fired };
  const jobs = analytics.scoredJobs();
  const scores = scoreVideos({ labels, snapshotsByJob: new Map(jobs.map((j) => [j.id, analytics.snapshots(j.id)])), jobs, now });
  const accountsOf = new Map<number, Set<number>>();
  for (const j of jobs) {
    const set = accountsOf.get(j.postId) ?? new Set<number>();
    set.add(j.accountId);
    accountsOf.set(j.postId, set);
  }
  for (const c of list) {
    c.compiled!.rules.forEach((rule, ruleIndex) => {
      try {
        fired.push(...evaluateRule(deps, c, rule, ruleIndex, labels, scores, accountsOf));
      } catch (err) {
        console.error(`campaign ${c.id}: rule ${ruleIndex + 1}: ${(err as Error).message}`);
      }
    });
  }
  return { fired };
}

function evaluateRule(deps: RuleDeps, c: Campaign, rule: Rule, ruleIndex: number, labels: VideoLabels[], scores: VideoScore[], accountsOf: Map<number, Set<number>>): Firing[] {
  const { store, campaigns } = deps;
  const { label, is, thresholdPct, minVideos, age, scope } = rule.when;
  // stop_using only has random and best pools to act on: hooks, angles and CTAs.
  if (rule.then.kind === "stop_using" && !isLibrary(label)) return [];
  let inScope: (l: VideoLabels) => boolean;
  if (scope === "campaign") inScope = (l) => l.campaignId === c.id;
  else {
    const accounts = new Set(setAccounts(store, c.accountSetId ?? defaultSetId(store)).map((a) => a.id));
    inScope = (l) => [...(accountsOf.get(l.postId) ?? [])].some((a) => accounts.has(a));
  }
  const scoped = labels.filter((l) => inScope(l) && hasValue(l, label));
  // Provisional scores don't count: only final ones at the rule's age.
  const final = scores.filter((s) => s.overall[age] !== undefined && s.provisional[age] === false);
  const rows = compareLabels(final, scoped, label, age as ScoreAge);
  const matched = rows.filter((r) => r.n >= minVideos && (is === "working" ? r.median >= 100 - thresholdPct : r.median <= thresholdPct));
  const out: Firing[] = [];
  const finalPosts = new Set(final.map((s) => s.postId));
  for (const m of matched) {
    const key = `${label}:${m.key}`;
    const videos = scoped.filter((l) => finalPosts.has(l.postId) && keysOf(l, label).includes(m.key));
    // Built before the firing is recorded: a rule that can't be built doesn't fire, and the user is told (once).
    const made = rule.then.kind === "make" ? ruleInstruction(campaigns, c, rule, m.key, videos) : null;
    if (made && "error" in made) {
      queueEvent(store, "campaign.failed", `campaign.failed:rule:${c.id}:${ruleIndex}:${key}`,
        { campaign_id: c.id, rule_index: ruleIndex, rule: rule.source, label, value_key: m.key, error: made.error },
        `Campaign "${c.name}": the rule "${rule.source}" matched the ${label} ${valueName(deps, label, m.key)}, but ${made.error}, so it made nothing.`);
      continue;
    }
    // The firing and what it does are one transaction: a throw part-way spends nothing, and it fires next refresh.
    store.db.exec("BEGIN");
    try {
      if (!campaigns.ruleFired(c.id, ruleIndex, key)) { store.db.exec("COMMIT"); continue; }
      let taskIds: number[] = [];
      if (made) taskIds = deps.worker.addRuleTasks(c, ruleIndex, made.ins, made.fixed, { index: ruleIndex, label, key: m.key }, deps.now);
      else campaigns.exclude(c.id, label as LibraryKind, Number(m.key));
      tellFiring(deps, c, rule, ruleIndex, m, taskIds);
      store.db.exec("COMMIT");
    } catch (err) {
      store.db.exec("ROLLBACK");
      console.error(`campaign ${c.id}: rule ${ruleIndex + 1} (${key}): ${(err as Error).message}; tried again next refresh`);
      continue;
    }
    out.push({ campaignId: c.id, ruleIndex, key });
  }
  return out;
}

/**
 * The make instruction a make rule's match becomes: the matched label held to the match (same_as_rule), vary labels
 * random, the rest copied from the newest make instruction of THIS campaign that produced one of the matched videos
 * (else the campaign's own first make line): another campaign's lines are never copied, even under account scope.
 * A copied CTA always comes from this campaign: a named one still in the library, else its first named CTA still
 * in the library, else the source task's own CTA if it still exists, else a random library CTA. An error (nothing
 * fires) when there's no line to copy or no CTA in the library at all.
 */
function ruleInstruction(campaigns: CampaignStore, c: Campaign, rule: Rule, key: string, videos: VideoLabels[]): { ins: MakeInstruction; fixed: Partial<Record<LibraryKind, number>> } | { error: string } {
  const then = rule.then as Extract<Rule["then"], { kind: "make" }>;
  const label = rule.when.label;
  const lines = DAYS.flatMap((d) => c.compiled!.days[d] ?? []).filter((i): i is MakeInstruction => i.kind === "make");
  const namedCtas = lines.flatMap((i) => (i.cta.pick === "named" ? [i.cta.id] : []));

  // The newest campaign task that made one of the matched videos (a post line's video was made by its kept task).
  let source: { ins: MakeInstruction; choices: TaskChoices | undefined } | undefined;
  let newest = -1;
  for (const v of videos) {
    let t = v.campaignTaskId === null ? undefined : campaigns.task(v.campaignTaskId);
    const via = (t?.choices as unknown as TaskChoices | undefined)?.sourceTaskId;
    if (t && t.kind === "post" && via) t = campaigns.task(via);
    const ch = t?.choices as unknown as TaskChoices | undefined;
    if (!t || t.campaignId !== c.id || ch?.instruction?.kind !== "make" || t.id <= newest) continue;
    newest = t.id;
    source = { ins: ch.instruction, choices: ch };
  }
  if (!source && !lines[0]) return { error: "the campaign has no make line to copy its videos from" };
  if (!campaigns.entries("cta").length) return { error: "the library has no CTA to end its videos with" };
  source ??= { ins: lines[0]!, choices: undefined };
  const src = source.ins;

  const fixed: Partial<Record<LibraryKind, number>> = {};
  const pickFor = (kind: LibraryKind): Pick => {
    if (kind === label) { fixed[kind] = Number(key); return { pick: "same_as_rule" }; }
    const had = source!.choices?.[kind] as LibraryEntry | undefined;
    if (then.keep.includes(kind) && had) { fixed[kind] = had.id; return { pick: "same_as_rule" }; }
    if (then.vary.includes(kind)) return { pick: "random" };
    const p = src[kind];
    if (p.pick !== "same_as_rule") return p;
    return had ? { pick: "named", id: had.id } : { pick: "random" };
  };
  const hook = pickFor("hook");
  const angle = pickFor("angle");
  let cta = pickFor("cta");
  const copiedCta = label !== "cta" && !then.keep.includes("cta") && !then.vary.includes("cta");
  const isCta = (id: number | undefined) => id !== undefined && campaigns.entry(id)?.kind === "cta";
  if (copiedCta && !(cta.pick === "named" && isCta(cta.id))) {
    const first = namedCtas.find(isCta);
    const had = (source.choices?.cta as LibraryEntry | undefined)?.id;
    cta = first !== undefined ? { pick: "named", id: first } : isCta(had) ? { pick: "named", id: had! } : { pick: "random" };
  }

  const style = label === "style" ? key : (source.choices?.style ?? src.style);
  const typeId = Number(key);
  const types = label === "type" && !src.types.includes(typeId) ? [typeId] : [...src.types];
  const post = then.post ? { at: src.post?.at ?? "default" } : null;
  return { ins: { kind: "make", count: then.count, style, hook, angle, cta, types, post, source: rule.source }, fixed };
}

/** The matched value as the user knows it. */
function valueName(deps: RuleDeps, label: Rule["when"]["label"], key: string): string {
  if (isLibrary(label)) {
    const e = deps.campaigns.entry(Number(key));
    return e ? `${e.name} ("${e.text}")` : `#${key}`;
  }
  if (label === "style") return styleById(deps.store, key)?.name ?? key;
  return deps.campaigns.types().find((t) => t.id === Number(key))?.name ?? `#${key}`;
}

function tellFiring(deps: RuleDeps, c: Campaign, rule: Rule, ruleIndex: number, m: { key: string; median: number; n: number }, taskIds: number[]) {
  const label = rule.when.label;
  const value = valueName(deps, label, m.key);
  const why = `${label} ${value} is ${rule.when.is === "working" ? "working" : "not working"} (median score ${Math.round(m.median)} at ${rule.when.age} over ${m.n} videos)`;
  const did = rule.then.kind === "make"
    ? `made ${taskIds.length} new video${taskIds.length === 1 ? "" : "s"} for today`
    : `random and best picks stop using it (named lines that use it keep running)`;
  queueEvent(deps.store, "campaign.rule", `campaign.rule:${c.id}:${ruleIndex}:${label}:${m.key}`,
    { campaign_id: c.id, rule_index: ruleIndex, rule: rule.source, label, value_key: m.key, value, action: rule.then.kind, task_ids: taskIds },
    `Campaign "${c.name}": the rule "${rule.source}" fired: the ${why}, so it ${did}.`);
}
