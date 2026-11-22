// Runs confirmed campaigns, with plain code only (the one AI call is the script writer's). Every tick:
//  - materialize: today's instructions of every runnable campaign become tasks, one per copy (local calendar day;
//    a day the app was closed is never back-filled). Only a time still ahead is made today: one already come (this
//    minute or earlier, as when a line is added late) is next week's. Each task keeps a snapshot of the instruction it came from and
//    the hook / angle / CTA it was given, so editing the campaign never changes a task already made, except that a
//    row's new post time moves its videos not yet out (retime.ts).
//  - make: script (AI) → WanGP voiceover and music → production → the editing style's edit → review. Nothing a
//    campaign makes posts without the user's approval here.
//  - post: a "post" line waits for a kept campaign video with that name, else a Drive file intake held for it (its
//    own edit, or for _RAW the file, goes to a campaign review), until the local day ends (then "missed"). A Drive
//    file with that name already reviewing or scheduled by its filename is never posted again: the task is missed.
//  - placing an approved post: the review service makes a campaign's post held; this worker picks its time (the
//    line's time today, now if that has passed today, the next free default time if approved on a later day), keeps
//    the daily cap by the day it actually posts, writes its labels, and only then releases it.
//  - kill switch: stopAll() holds every campaign post not yet out and nothing new is scheduled or started; renders
//    under way finish. resumeAll() lets them go.
// WanGP speech and music aren't production shots, so they borrow the production worker's GPU lane (borrowGpu): they
// run only while no GPU shot is running, one at a time, and no GPU shot starts while they run.
// One task failing never stops another: each step is caught per task, and a failure is told to the user.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultSetId, defaultTikTok, setAccounts } from "../accounts.ts";
import { OverBudget } from "../ai/budget.ts";
import type { AiService } from "../ai/router.ts";
import { compareLabels, scoreVideos } from "../analytics/score.ts";
import { AnalyticsStore } from "../analytics/store.ts";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { styleById } from "../edit/styles.ts";
import { queueEvent } from "../notify.ts";
import type { ProductionSpec } from "../produce/spec.ts";
import { dayKey, lineTime, localAt, parseDay } from "./time.ts";
import type { Production, ProductionStore } from "../produce/store.ts";
import { generateMusic, generateSpeech } from "../produce/wan-audio.ts";
import { hashFile } from "../review/media.ts";
import type { ReviewRequest, ReviewService, Subject } from "../review/service.ts";
import { ROW_INSTRUCTION_BASE } from "./rows.ts";
import { BRIEF_LEAD_HOURS, LAUNCH_PREF, MAX_BRIEF_OFFERS, REVIEW_BUFFER_MINUTES, buildBrief, giveUpBrief, type Brief, type Delivery, type Lease } from "./briefs.ts";
import { lookByKey, type Look } from "./looks.ts";
import { buildGeneratedProduction, writeScript, type Script } from "./script.ts";
import { DAYS, type MakeInstruction, type Pick as ValuePick, type PostInstruction } from "./spec.ts";
import { CampaignStore, campaignTaskFor, driveFileTaken, mayPostUnseen, type Campaign, type CampaignTask, type LibraryEntry, type LibraryKind, type TaskState } from "./store.ts";

/** What the worker needs of the production worker (a stand-in in tests). */
export interface Productions {
  productions: ProductionStore;
  createStaged(spec: ProductionSpec): Promise<Production>;
  borrowGpu<T>(fn: () => Promise<T>): Promise<{ value: T } | null>;
}

export interface CampaignWorkerDeps {
  store: Store;
  productions: Productions;
  reviews: ReviewService;
  ai: AiService | null;
  now?: () => number;
  random?: () => number;
  /** WanGP's voiceover and soundtrack (stand-ins in tests) */
  speech?: (text: string, outDir: string) => Promise<string>;
  music?: (prompt: string, sec: number, outDir: string) => Promise<string>;
  writeScript?: typeof writeScript;
  /** data/campaigns: each task's voiceover and music */
  dir?: string;
}

/** A task's resolved instruction, frozen when it was made. */
export interface TaskChoices {
  instruction: MakeInstruction | PostInstruction;
  campaignName: string;
  /** "Sun" … "Sat" */
  day: string;
  /** the editing style id (a post line with no style takes its video's) */
  style: string | null;
  types: number[];
  hook?: LibraryEntry;
  angle?: LibraryEntry;
  cta?: LibraryEntry;
  /** "HH:MM" it is meant to post at on its day; null for a video made to keep */
  postTime: string | null;
  accountSetId: number | null;
  /** a video made to keep (make with no post): its library name */
  libraryName?: string;
  script?: Script;
  voiceover?: string;
  music?: string;
  /** a post line: the kept task whose video it posts */
  sourceTaskId?: number;
  /** a post line: the held Drive file it posts (recorded footage) */
  driveId?: string;
  /** a rule's video: the rule and the value it matched */
  rule?: { index: number; label: string; key: string };
  /** what the picker had to fall back on (every value stopped by a rule, say) */
  notes?: string[];
  /** today's AI budget was used up when its script was due: what the tab shows, and when it tries again */
  waiting?: string;
  waitUntil?: number;
  /** an agent film: what the agent is asked to make */
  brief?: Brief;
  /** the agent that has claimed the brief, until the time given */
  lease?: Lease;
  /** how many times the brief has been claimed */
  offers?: number;
  /** which brief this is: 1, then one more for each retry, so each round's events are told afresh */
  briefRound?: number;
  /** the agent's checked film, waiting for the worker to take it on */
  delivery?: Delivery;
}

/** Whether a task's video is an agent film (a make line with a look: an Agent row, or a Create row with a Lemo style). */
const isAgentFilm = (c: TaskChoices) => c.instruction?.kind === "make" && Boolean(c.instruction.look);

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** States a task is still being worked on in. */
const ACTIVE: TaskState[] = ["queued", "awaiting_agent", "scripting", "rendering", "editing", "reviewing", "scheduled"];
const PENDING_JOBS = ["queued", "running", "retry", "waiting_quota"];
/** Campaign reviews wait for the user well past their post time (approved a later day, it takes a later time). */
const REVIEW_HOURS = 24 * 7;
/** How far ahead a post is placed before giving up (a cap of 0, say). */
const MAX_DAYS_AHEAD = 60;
/** A post line takes a kept video made at most this many days before its own day. */
const KEPT_WINDOW_DAYS = 7;
/** The score age "best" ranks by: the "working" default's. */
const BEST_AGE = "72h";
/** A rule's tasks number their instructions from here (1000 + the rule's index), apart from the day's own lines. */
export const RULE_INSTRUCTION_BASE = 1000;

const HOUR = 3_600_000;
export { dayKey, localAt };
const addDays = (key: string, n: number) => {
  const [y, m, d] = parseDay(key);
  return dayKey(new Date(y, m - 1, d + n, 12).getTime());
};
const nextDayKey = (key: string) => addDays(key, 1);
const minute = (ms: number) => Math.floor(ms / 60_000);
/** The local midnight that ends the day. */
const endOfDay = (key: string) => {
  const [y, m, d] = parseDay(key);
  return new Date(y, m - 1, d + 1).getTime();
};

export interface PickContext {
  pool: (kind: LibraryKind) => LibraryEntry[];
  /** values already given to the day's batch, per kind */
  used: Record<LibraryKind, Set<number>>;
  random: () => number;
  /** library ids ranked best first, only those with enough videos */
  best: (kind: LibraryKind) => number[];
  /** values a "stop using" rule took out of the campaign's random and best picks */
  excluded?: Record<LibraryKind, Set<number>>;
  /** the campaign picking: random and best skip entries another campaign's Autorun added */
  campaignId?: number;
  /** a rule's video: the value it matched, for same_as_rule */
  fixed?: Partial<Record<LibraryKind, number>>;
  /** what the picker had to fall back on, for the task to say */
  notes?: string[];
}

/**
 * The hook, angle or CTA for one copy. random: uniform among the values the day's batch hasn't had yet (repeating
 * only once the library runs out); best: the highest median score with enough videos, random until one has;
 * named: that entry; same_as_rule: the value the rule matched. Random and best skip values a rule stopped using
 * (when every value is stopped, they pick from all of them and say so in ctx.notes); named never does. Random and
 * best never pick an entry another campaign's Autorun added (it's that campaign's). Null when there is nothing to
 * pick.
 */
export function pickValue(kind: LibraryKind, pick: ValuePick, ctx: PickContext): LibraryEntry | null {
  const all = ctx.pool(kind);
  const foreign = (e: LibraryEntry) => e.ownerCampaignId != null && e.ownerCampaignId !== ctx.campaignId;
  const pool = pick.pick === "random" || pick.pick === "best" ? all.filter((e) => !foreign(e)) : all;
  const stopped = ctx.excluded?.[kind];
  let open = stopped?.size ? pool.filter((e) => !stopped.has(e.id)) : pool;
  if ((pick.pick === "random" || pick.pick === "best") && pool.length && !open.length) {
    open = pool;
    ctx.notes?.push(`every ${kind} in the library was stopped by a rule, so it picked from all of them`);
  }
  const random = () => {
    const fresh = open.filter((e) => !ctx.used[kind].has(e.id));
    const from = fresh.length ? fresh : open;
    return from.length ? from[Math.min(Math.floor(ctx.random() * from.length), from.length - 1)] : null;
  };
  let chosen: LibraryEntry | null = null;
  if (pick.pick === "named") chosen = pool.find((e) => e.id === pick.id) ?? null;
  else if (pick.pick === "same_as_rule") chosen = pool.find((e) => e.id === ctx.fixed?.[kind]) ?? null;
  else if (pick.pick === "best") chosen = ctx.best(kind).map((id) => open.find((e) => e.id === id)).find((e) => e !== undefined) ?? random();
  else if (pick.pick === "random") chosen = random();
  if (chosen) ctx.used[kind].add(chosen.id);
  return chosen;
}

const log = (t: { id: number }, msg: string) => console.log(`[campaign task ${t.id}] ${msg}`);

export class CampaignWorker {
  store: Store;
  campaigns: CampaignStore;
  analytics: AnalyticsStore;
  productions: Productions;
  reviews: ReviewService;
  ai: AiService | null;
  now: () => number;
  random: () => number;
  speech: (text: string, outDir: string) => Promise<string>;
  music: (prompt: string, sec: number, outDir: string) => Promise<string>;
  write: typeof writeScript;
  dir: string;
  /** long steps (the script, the audio) running in this process, by task id */
  work = new Map<number, Promise<void>>();
  running: Promise<void> | undefined;
  timer: NodeJS.Timeout | undefined;
  /**
   * Called when campaigns stop: a campaign's id (Stop Campaign) or null (the kill switch). The app ends a running
   * agent launch through it, so this worker never needs the launcher.
   */
  onStop: (campaignId: number | null) => void = () => {};

  constructor(deps: CampaignWorkerDeps) {
    this.store = deps.store;
    this.campaigns = new CampaignStore(deps.store);
    this.analytics = new AnalyticsStore(deps.store);
    this.productions = deps.productions;
    this.reviews = deps.reviews;
    this.ai = deps.ai;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.speech = deps.speech ?? ((text, dir) => generateSpeech(text, dir));
    this.music = deps.music ?? ((prompt, sec, dir) => generateMusic(prompt, sec, dir));
    this.write = deps.writeScript ?? writeScript;
    this.dir = deps.dir ?? join(dataDir, "campaigns");
    this.reviews.ownedByCampaign = (s) => this.owns(s);
    this.reviews.agentFilm = (r) => this.agentFilmReview(r.id);
  }

  start(intervalMs = 15_000) {
    const tick = () => {
      void this.tick().catch((err) => console.error(`campaigns: ${(err as Error).message}`));
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** Resolves once no script or audio step started by this worker is still running. */
  async idle() {
    while (this.work.size || this.running) await Promise.all([...this.work.values(), this.running]);
  }

  // ---- making today's tasks ----

  /** Today's (local) tasks of every runnable campaign; repeats are no-ops. Returns how many were made. */
  materialize(date: Date = new Date(this.now())): number {
    const key = dayKey(date.getTime());
    const dayIndex = date.getDay();
    const best = new Map<LibraryKind, number[]>();
    let made = 0;
    for (const c of this.campaigns.campaigns()) {
      if (!this.campaigns.isRunnable(c) || !c.compiled) continue;
      try {
        made += this.materializeCampaign(c, key, dayIndex, best, date.getTime());
      } catch (err) {
        console.error(`campaign ${c.id}: couldn't make today's tasks: ${(err as Error).message}`);
      }
    }
    return made;
  }

  private materializeCampaign(c: Campaign, key: string, dayIndex: number, best: Map<LibraryKind, number[]>, now: number): number {
    const instructions = c.compiled!.days[DAYS[dayIndex]] ?? [];
    if (!instructions.length) return 0;
    let existing = this.campaigns.tasksOn(c.id, key);
    // A slot missed today (no video made) whose row has since moved to a time still ahead is made again, fresh from
    // the row as it is now: saving the new time means it should run at that time.
    const missedSlots = new Map(existing.filter((t) => t.state === "missed" && t.postId === null).map((t) => [`${t.instructionIndex}:${t.copy}`, t]));
    if (missedSlots.size) {
      const retired = new Set<number>();
      instructions.forEach((ins) => {
        if (ins.row === undefined) return; // only a table row's time can be moved
        for (let copy = 0; copy < (ins.kind === "make" ? ins.count : 1); copy++) {
          const t = missedSlots.get(`${ROW_INSTRUCTION_BASE + ins.row}:${copy}`);
          const hhmm = lineTime(ins, copy, c.defaultPostTimes);
          if (!t || hhmm === null || hhmm === (t.choices as unknown as TaskChoices).postTime || localAt(key, hhmm) <= now) continue;
          if (this.campaigns.retireMissed(t.id)) retired.add(t.id);
        }
      });
      if (retired.size) existing = this.campaigns.tasksOn(c.id, key);
    }
    const have = new Set(existing.map((t) => `${t.instructionIndex}:${t.copy}`));
    const ctx = this.pickContext(c, existing, best);
    // Kept videos are numbered across the whole day (instruction, then copy order), so every name is the day's own.
    const keepNo = new Map<string, number>();
    instructions.forEach((ins, index) => {
      if (ins.kind === "make" && ins.post === null) for (let copy = 0; copy < ins.count; copy++) keepNo.set(`${index}:${copy}`, keepNo.size + 1);
    });
    let made = 0;
    instructions.forEach((ins, index) => {
      // An Agent row whose look has left the catalogue (hidden by a sync, or never synced) doesn't run: the table
      // says so, and no task is made (nor a failure sent) until the look is back.
      if (ins.kind === "make" && ins.look) {
        const look = lookByKey(this.store, ins.look);
        if (!look || look.hidden) return;
      }
      // A table row's tasks are named by the row, so adding, removing or moving rows mid-day never re-makes or skips one.
      const instructionIndex = ins.row !== undefined ? ROW_INSTRUCTION_BASE + ins.row : index;
      const copies = ins.kind === "make" ? ins.count : 1;
      for (let copy = 0; copy < copies; copy++) {
        if (have.has(`${instructionIndex}:${copy}`)) continue;
        // A time already come today (this very minute, or earlier) is next week's: only a time still ahead is made
        // today. A video to keep has no time, so it's always made.
        const hhmm = lineTime(ins, copy, c.defaultPostTimes);
        if (hhmm !== null && localAt(key, hhmm) <= now) continue;
        const { choices, error } = this.resolve(c, ins, copy, DAY_LABELS[dayIndex], ctx, keepNo.get(`${index}:${copy}`) ?? copy + 1);
        const id = this.campaigns.addTask({
          campaignId: c.id, date: key, dayIndex, instructionIndex, copy, kind: ins.kind, choices: choices as unknown as Record<string, unknown>,
          state: error ? "failed" : "queued", error,
        });
        if (id === null) continue;
        made++;
        if (error) this.tell(this.campaigns.task(id)!, "campaign.failed", error);
      }
    });
    return made;
  }

  /** The picker's view of one campaign's day: the values its tasks that day already have, and what rules stopped. */
  private pickContext(c: Campaign, existing: CampaignTask[], best: Map<LibraryKind, number[]>): PickContext {
    const used: Record<LibraryKind, Set<number>> = { hook: new Set(), angle: new Set(), cta: new Set() };
    for (const t of existing) {
      for (const kind of ["hook", "angle", "cta"] as LibraryKind[]) {
        const e = t.choices[kind] as LibraryEntry | undefined;
        if (e) used[kind].add(e.id);
      }
    }
    const stopped = this.campaigns.excluded(c.id);
    const pools = new Map<LibraryKind, LibraryEntry[]>();
    return {
      pool: (kind) => { if (!pools.has(kind)) pools.set(kind, this.campaigns.entries(kind)); return pools.get(kind)!; },
      used,
      random: this.random,
      best: (kind) => { if (!best.has(kind)) best.set(kind, this.bestRanking(kind)); return best.get(kind)!; },
      excluded: { hook: new Set(stopped.hook), angle: new Set(stopped.angle), cta: new Set(stopped.cta) },
      campaignId: c.id,
    };
  }

  /**
   * A rule's videos, dated today: count copies of a make instruction the rule built, picked by the same picker
   * (same_as_rule takes `fixed`) and made by the same pipeline as any make task. Their instruction index is
   * 1000 + the rule's index, each firing taking the next copy numbers, so they never meet the day's own tasks.
   * Returns the new tasks' ids (a copy that can't be made is a failed task, told like any other).
   */
  addRuleTasks(c: Campaign, ruleIndex: number, ins: MakeInstruction, fixed: Partial<Record<LibraryKind, number>>, rule: NonNullable<TaskChoices["rule"]>, now = this.now()): number[] {
    const key = dayKey(now);
    const dayIndex = new Date(now).getDay();
    const existing = this.campaigns.tasksOn(c.id, key);
    const ctx = this.pickContext(c, existing, new Map());
    ctx.fixed = fixed;
    const instructionIndex = RULE_INSTRUCTION_BASE + ruleIndex;
    let copy = Math.max(-1, ...existing.filter((t) => t.instructionIndex === instructionIndex).map((t) => t.copy)) + 1;
    // Kept names go on after the day's own: those already made and those the day's lines will make.
    const dayKeeps = (c.compiled?.days[DAYS[dayIndex]] ?? []).reduce((n, i) => n + (i.kind === "make" && i.post === null ? i.count : 0), 0);
    const keptNo = (t: CampaignTask) => Number(/-(\d+)$/.exec(String((t.choices as unknown as TaskChoices).libraryName ?? ""))?.[1] ?? 0);
    let keepNo = Math.max(dayKeeps, ...existing.map(keptNo));
    const ids: number[] = [];
    for (let i = 0; i < ins.count; i++, copy++) {
      const { choices, error } = this.resolve(c, ins, copy, DAY_LABELS[dayIndex], ctx, ins.post === null ? ++keepNo : copy + 1);
      choices.rule = rule;
      const id = this.campaigns.addTask({
        campaignId: c.id, date: key, dayIndex, instructionIndex, copy, kind: "rule", choices: choices as unknown as Record<string, unknown>,
        state: error ? "failed" : "queued", error,
      });
      if (id === null) continue;
      ids.push(id);
      if (error) this.tell(this.campaigns.task(id)!, "campaign.failed", error);
    }
    return ids;
  }

  /** One copy's choices; an error when it can't be made at all. */
  private resolve(c: Campaign, ins: MakeInstruction | PostInstruction, copy: number, day: string, ctx: PickContext, keepNo: number): { choices: TaskChoices; error: string | null } {
    const defaults = c.defaultPostTimes;
    const choices: TaskChoices = {
      instruction: structuredClone(ins), campaignName: c.name, day, style: ins.style, types: [...ins.types], postTime: null, accountSetId: c.accountSetId,
    };
    const problems: string[] = [];
    if (ins.kind === "make") {
      const notes: string[] = [];
      ctx.notes = notes;
      for (const kind of ["hook", "angle", "cta"] as LibraryKind[]) {
        const entry = pickValue(kind, ins[kind], ctx);
        if (entry) choices[kind] = entry;
        else problems.push(ins[kind].pick === "named" || ins[kind].pick === "same_as_rule" ? `its ${kind} is no longer in the library` : `the library has no ${kind} to pick`);
      }
      if (notes.length) choices.notes = notes;
      if (ins.post === null) choices.libraryName = `${c.name.replace(/\s+/g, "")}-${day}-${keepNo}`;
      else if (ins.post.at !== "default") choices.postTime = ins.post.at;
      else if (defaults.length) choices.postTime = defaults[copy % defaults.length];
      else problems.push("it posts at the default time, and the campaign has no default post times");
    } else {
      choices.postTime = ins.at ?? defaults[0] ?? null;
      if (!choices.postTime) problems.push("the line has no time, and the campaign has no default post times");
      // A table row's labels for the recorded video: only a named one says what it is (random or best would guess).
      for (const kind of ["hook", "angle", "cta"] as LibraryKind[]) {
        const p = ins[kind];
        if (p?.pick !== "named") continue;
        const entry = ctx.pool(kind).find((e) => e.id === p.id);
        if (entry) choices[kind] = entry;
      }
    }
    return { choices, error: problems.length ? problems.join("; ") : null };
  }

  /** Library ids of a kind by median score (enough videos only), best first. Plain code: no AI. */
  private bestRanking(kind: LibraryKind): number[] {
    const labels = this.analytics.allLabels();
    if (!labels.length) return [];
    const jobs = this.analytics.scoredJobs();
    const snapshotsByJob = new Map(jobs.map((j) => [j.id, this.analytics.snapshots(j.id)]));
    const scores = scoreVideos({ labels, snapshotsByJob, jobs, now: this.now() });
    return compareLabels(scores, labels, kind, BEST_AGE).filter((r) => r.enough).map((r) => Number(r.key)).filter(Number.isInteger);
  }

  // ---- running tasks ----

  /** Makes today's tasks and moves every open task on by one step. Overlapping calls share one run. */
  tick(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run() {
    try {
      this.sweepHeld();
      // A retried campaign job waits held for its task to place it again.
      if (!this.campaigns.killed()) this.placeHeld();
    } catch (err) {
      console.error(`campaigns: held posts: ${(err as Error).message}`);
    }
    try {
      this.materialize();
    } catch (err) {
      console.error(`campaigns: materialize: ${(err as Error).message}`);
    }
    for (const t of this.campaigns.tasksIn(ACTIVE)) {
      if (this.work.has(t.id)) continue;
      try {
        await this.step(t);
      } catch (err) {
        this.fail(t.id, (err as Error).message);
      }
    }
  }

  private async step(t: CampaignTask) {
    const c = t.choices as unknown as TaskChoices;
    switch (t.state) {
      case "queued":
        if (t.kind === "post") return this.findVideo(t);
        // An Agent row's film is never scripted or rendered here: its brief goes out to an agent. A Create row with a
        // Lemo style (scripted) has its script written here first, then its brief goes out.
        if (c.instruction.kind === "make" && c.instruction.look && !c.instruction.scripted) return this.offerBrief(t, c);
        if (c.waitUntil !== undefined && this.now() < c.waitUntil) return; // waiting for tomorrow's AI budget
        if (this.stopped(t)) return; // stopped: nothing new starts
        if (c.waitUntil !== undefined) this.setChoices(t.id, { waiting: undefined, waitUntil: undefined });
        this.campaigns.updateTask(t.id, { state: "scripting" });
        return this.spawn(t, () => this.makeScript(t.id));
      case "awaiting_agent":
        return this.followBrief(t);
      case "scripting":
        // A script left half-written by a restart is written again; a scripted Lemo film whose script is written
        // and whose brief isn't out yet (its lead time, or a stopped campaign) goes straight on to its brief.
        return this.spawn(t, () => this.makeScript(t.id));
      case "rendering":
        if (t.productionId === null) return this.spawn(t, () => this.makeAudio(t.id));
        return this.checkProduction(t, c);
      case "editing":
        return this.checkEdit(t);
      case "reviewing":
        if (t.reviewId === null) return this.requestReview(t, c);
        return this.followReview(t, c);
      case "scheduled":
        return this.followPost(t);
    }
  }

  /** Runs a long step in the background; its failure fails only this task. */
  private spawn(t: CampaignTask, fn: () => Promise<void>) {
    if (this.work.has(t.id)) return;
    const p = fn()
      .catch((err) => this.fail(t.id, (err as Error).message))
      .finally(() => this.work.delete(t.id));
    this.work.set(t.id, p);
  }

  private choices(id: number): TaskChoices {
    return this.campaigns.task(id)!.choices as unknown as TaskChoices;
  }

  private setChoices(id: number, patch: Partial<TaskChoices>) {
    this.campaigns.updateTask(id, { choices: { ...this.choices(id), ...patch } as unknown as Record<string, unknown> });
  }

  private async makeScript(id: number) {
    const c = this.choices(id);
    if (!c.script) {
      if (!this.ai) throw new Error("no AI provider is set up to write the script");
      log({ id }, "writing the script");
      let script: Script;
      const targetSec = c.instruction.kind === "make" ? c.instruction.sec ?? undefined : undefined;
      const instructions = c.instruction.kind === "make" ? c.instruction.instructions : undefined;
      // The row's model, when it chose one, is the only one asked: its failure fails the task with its reason.
      const model = c.instruction.kind === "make" ? c.instruction.model : undefined;
      try {
        script = await this.write({ ai: this.ai }, { hook: c.hook!, angle: c.angle!, cta: c.cta! }, targetSec, instructions, model);
      } catch (err) {
        if (err instanceof OverBudget || (err as Error)?.name === "OverBudget") return this.waitForBudget(id);
        throw err;
      }
      this.setChoices(id, { script });
    }
    // A Create row with a Lemo style: an agent films the script (no WanGP voiceover or music). Until its brief is
    // out the task stays scripting, and the next tick comes back here with the script already written.
    const written = this.choices(id);
    if (written.instruction.kind === "make" && written.instruction.look && written.instruction.scripted) return this.offerBrief(this.campaigns.task(id)!, written);
    this.campaigns.updateTask(id, { state: "rendering" });
    await this.makeAudio(id);
  }

  /** The voiceover and the music, on the GPU lane when it's free; then the production. */
  private async makeAudio(id: number) {
    const t = this.campaigns.task(id)!;
    if (t.state !== "rendering" || t.productionId !== null) return;
    const c = this.choices(id);
    if (!c.script) throw new Error("the script is missing");
    const script = c.script;
    if (!c.voiceover || !c.music) {
      const dir = join(this.dir, `task-${id}`);
      mkdirSync(dir, { recursive: true });
      const done = await this.productions.borrowGpu(async () => {
        if (!this.choices(id).voiceover) {
          log({ id }, "making the voiceover");
          this.setChoices(id, { voiceover: await this.speech(script.lines.join("\n"), dir) });
        }
        if (!this.choices(id).music) {
          log({ id }, "making the music");
          const sec = script.shots.reduce((n, s) => n + s.sec, 0);
          this.setChoices(id, { music: await this.music(script.musicPrompt, sec, dir) });
        }
      });
      if (!done) return; // a GPU shot is running: next tick
    }
    const audio = this.choices(id);
    const p = await this.productions.createStaged(buildGeneratedProduction(script, { voiceover: audio.voiceover!, music: audio.music! }, true));
    this.campaigns.updateTask(id, { productionId: p.id });
    log({ id }, `production ${p.id} queued`);
  }

  private async checkProduction(t: CampaignTask, c: TaskChoices) {
    const p = this.productions.productions.get(t.productionId!);
    if (!p) return this.fail(t.id, `its production ${t.productionId} is gone`);
    if (p.state === "failed" || p.state === "cancelled" || p.state === "rejected") {
      return this.fail(t.id, `the video couldn't be made: ${p.error ?? p.state}`);
    }
    if (p.state !== "ready" && p.state !== "approved") return;
    if (!p.outputPath) return this.fail(t.id, `production ${p.id} has no video`);
    await this.startEdit(t.id, p.outputPath, c.style);
  }

  /** The editing style's edit of a finished video. */
  private async startEdit(id: number, video: string, styleId: string | null) {
    const style = styleById(this.store, styleId);
    if (!style) return this.fail(id, `the editing style ${styleId ?? "(none)"} no longer exists`);
    const edit = this.store.createEdit(video, await hashFile(video), style.settings);
    this.campaigns.updateTask(id, { state: "editing", editId: edit.id });
    log({ id }, `edit ${edit.id} (${style.name})`);
  }

  private async checkEdit(t: CampaignTask) {
    const latest = this.store.latestRevision(t.editId!);
    if (latest !== t.editId) this.campaigns.updateTask(t.id, { editId: latest });
    const e = this.store.edit(latest);
    if (!e) return this.fail(t.id, "its edit is gone");
    if (e.state === "failed") return this.fail(t.id, `the edit failed: ${e.error ?? "unknown error"}`);
    if (e.state === "rejected" || e.state === "superseded") return this.fail(t.id, `its edit was ${e.state}`);
    if (e.state !== "ready") return;
    this.campaigns.updateTask(t.id, { state: "reviewing", reviewId: null });
    await this.requestReview(this.campaigns.task(t.id)!, t.choices as unknown as TaskChoices);
  }

  // ---- agent films ----

  /**
   * An Agent row's brief goes out BRIEF_LEAD_HOURS before its slot (a film to keep, at once); a Create row's Lemo
   * film's (scripted) goes out as soon as its script is written, however close its slot, as a WanGP video starts at
   * once. Never while its campaign is stopped. Its look must still be in the catalogue then; once the brief is out,
   * it keeps that look.
   */
  private offerBrief(t: CampaignTask, c: TaskChoices) {
    const now = this.now();
    const postAt = c.postTime === null ? null : localAt(t.date, c.postTime);
    const scripted = (c.instruction as MakeInstruction).scripted === true;
    if (!scripted && postAt !== null && now < postAt - BRIEF_LEAD_HOURS * HOUR) return;
    // An Agent row's deadline has already passed (the app was off, or the campaign stopped, through it): no brief is offered.
    const deadline = postAt === null || scripted ? null : postAt - REVIEW_BUFFER_MINUTES * 60_000;
    if (deadline !== null && now >= deadline) return this.missBrief(t, deadline);
    if (this.stopped(t)) return; // stopped: no new brief is offered
    const key = (c.instruction as MakeInstruction).look!;
    const look = lookByKey(this.store, key);
    if (!look || look.hidden) return this.fail(t.id, `the Lemo style ${key} is no longer in Lemo-Opuscar`);
    const brief = buildBrief(this.store, c, look, postAt, now);
    const round = c.briefRound ?? 1;
    // Told first: a crash before the task is written tells it again next tick under the same key, never not at all.
    this.announceBrief(t, brief, look.name, round);
    this.setChoices(t.id, { brief, offers: 0, briefRound: round });
    this.campaigns.updateTask(t.id, { state: "awaiting_agent", error: null });
    log(t, `brief for a ${key} film, due by ${new Date(brief.deadline).toLocaleString()}`);
  }

  /** Whether FreePoster starts Claude itself for open briefs (the launcher is on), so no other agent should claim them. */
  private launching(): boolean {
    return this.store.pref<boolean>(LAUNCH_PREF) === true;
  }

  /** brief.requested, once per round of the task's brief. */
  private announceBrief(t: CampaignTask, brief: Brief, lookName: string, round: number) {
    const { name, what } = this.describe(t);
    // No post time on a video meant to post (a retry too late for its slot) posts at the next free time.
    const keeping = (t.choices as unknown as TaskChoices).postTime === null;
    const posts = brief.postAt !== null ? `posting ${new Date(brief.postAt).toLocaleString()}`
      : keeping ? "a video to keep" : "posting at the next free time once approved";
    const launching = this.launching();
    const next = launching ? "FreePoster is starting Claude on this computer to make it; don't claim it" : `call claim_brief with task_id ${t.id}`;
    queueEvent(this.store, "brief.requested", `brief.requested:${t.id}:${round}`,
      {
        campaign_id: t.campaignId, task_id: t.id, campaign_task_id: t.id, look: brief.look, deadline: new Date(brief.deadline).toISOString(), post_at: brief.postAt === null ? null : new Date(brief.postAt).toISOString(),
        ...(launching ? { handled_by: "freeposter" } : {}),
      },
      `Campaign "${name}" wants a ${lookName} (${brief.look}) film for ${what} (${posts}), delivered by ${new Date(brief.deadline).toLocaleString()}: ${next}`);
  }

  /** No film by the deadline: the slot is skipped. */
  private missBrief(t: CampaignTask, deadline: number) {
    const when = new Date(deadline).toLocaleString();
    this.campaigns.updateTask(t.id, { state: "missed", error: `the agent didn't deliver before ${when}` });
    this.tell(this.campaigns.task(t.id)!, "campaign.missed", `the agent didn't deliver before ${when}; the slot was skipped`);
  }

  /**
   * A brief waiting for its film. A delivery is taken on; past the deadline the slot is missed; a lease that ran
   * out is cleared so another agent can claim it, until MAX_BRIEF_OFFERS claims have all run out.
   */
  private async followBrief(snapshot: CampaignTask) {
    // The tick's snapshot may be old by now (an agent claimed or delivered since): judge the task as it is.
    const t = this.campaigns.task(snapshot.id);
    if (!t || t.state !== "awaiting_agent") return;
    const c = t.choices as unknown as TaskChoices;
    if (c.delivery) return this.takeDelivery(t, c, c.delivery);
    if (!c.brief) return this.fail(t.id, "its brief is missing");
    const now = this.now();
    // A lease never outlasts the deadline, so at the deadline the slot is missed, not the lease expired.
    if (now >= c.brief.deadline) return this.missBrief(t, c.brief.deadline);
    if (!c.lease || c.lease.until > now) return;
    const judged = c.lease;
    // Only the lease judged expired is acted on; a newer claim since stands.
    const still = (this.campaigns.task(t.id)?.choices as unknown as TaskChoices | undefined)?.lease;
    if (!still || still.holder !== judged.holder || still.until !== judged.until || still.token !== judged.token) return;
    const offers = c.offers ?? 0;
    const last = offers >= MAX_BRIEF_OFFERS;
    const launching = this.launching();
    const next = last ? "it has no offers left"
      : launching ? "FreePoster is starting Claude on this computer for it again; don't claim it"
      : `call claim_brief with task_id ${t.id} to take it on`;
    queueEvent(this.store, "brief.expired", `brief.expired:${t.id}:${c.briefRound ?? 1}:${offers}`,
      { campaign_id: t.campaignId, task_id: t.id, campaign_task_id: t.id, look: c.brief.look, holder: c.lease.holder, offers, ...(launching ? { handled_by: "freeposter" } : {}) },
      `${c.lease.holder}'s lease on the brief for task ${t.id} ran out without a film; ${next}`);
    if (last) return this.fail(t.id, `no agent delivered after ${MAX_BRIEF_OFFERS} tries`);
    this.setChoices(t.id, { lease: undefined });
  }

  /**
   * The agent's checked film, sent for review as it was delivered: a Lemo film is never edited by FreePoster, even
   * one whose task kept a FreePoster style from a schedule saved before that.
   */
  private async takeDelivery(t: CampaignTask, c: TaskChoices, d: Delivery) {
    if (!existsSync(d.path)) return this.fail(t.id, `its delivered film ${d.path} is gone`);
    this.campaigns.updateTask(t.id, { state: "reviewing", reviewId: null });
    await this.requestReview(this.campaigns.task(t.id)!, c);
  }

  /** The look a brief already out was made in: it keeps it, even one hidden or gone since. */
  private briefLook(old: Brief): Look {
    return lookByKey(this.store, old.look)
      ?? { key: old.look, producer: old.producer, name: old.look, description: "", needsImageGen: old.needsImageGen, libraryVersion: "", category: null, hidden: true };
  }

  /**
   * The user asked for a redo of an agent film: a new round of its brief, for the same slot, with the note added
   * to its instructions, unclaimed and with its offers back. Past an Agent row's brief's deadline the slot is missed
   * instead; a Create row's Lemo film (scripted) is asked for again however close its slot.
   */
  private redoFilm(t: CampaignTask, c: TaskChoices, note: string | null, reason: string | null) {
    const now = this.now();
    const old = c.brief;
    if (!old) return this.fail(t.id, "its brief is missing");
    const briefRound = (c.briefRound ?? 1) + 1;
    this.setChoices(t.id, { briefRound });
    const postAt = old.postAt;
    const scripted = (c.instruction as MakeInstruction).scripted === true;
    if (!scripted && postAt !== null && now >= postAt - REVIEW_BUFFER_MINUTES * 60_000) return this.missBrief(t, postAt - REVIEW_BUFFER_MINUTES * 60_000);
    const look = this.briefLook(old);
    const ask = note?.trim() || (reason && reason !== "none" ? reason : "make a new film");
    const fresh = buildBrief(this.store, c, look, postAt, now);
    const brief: Brief = { ...fresh, instructions: [old.instructions, `Redo: ${ask}`].filter(Boolean).join("\n") };
    const current = this.campaigns.task(t.id)!;
    // Told first, as a first brief is: a crash before the task is written tells it again under the same key.
    this.announceBrief(current, brief, look.name, briefRound);
    this.setChoices(t.id, { brief, offers: 0, lease: undefined, delivery: undefined, briefRound });
    this.campaigns.updateTask(t.id, { state: "awaiting_agent", editId: null, reviewId: null, error: null });
    log(t, `redo asked: a new brief (round ${briefRound}), due by ${new Date(brief.deadline).toLocaleString()}`);
  }

  /** Whether a review is of an agent film a campaign task is making. */
  private agentFilmReview(reviewId: number): boolean {
    const rows = this.store.db.prepare("SELECT id FROM campaign_tasks WHERE review_id = ?").all(reviewId) as { id: number }[];
    return rows.some((r) => {
      const t = this.campaigns.task(r.id);
      return t !== undefined && isAgentFilm(t.choices as unknown as TaskChoices);
    });
  }

  /** A retried agent film with no film left to take on: a fresh brief, unclaimed, with its offers back, told again. */
  private freshBrief(t: CampaignTask, c: TaskChoices, round: number): Partial<TaskChoices> {
    const now = this.now();
    const old = c.brief!;
    // It keeps its look, even one hidden since.
    const look = this.briefLook(old);
    let postAt = c.postTime === null ? null : localAt(t.date, c.postTime);
    // Its slot is too close to make now: it's wanted within a day, and placed like any later approval (the user
    // asked for this retry, as a retried WanGP video that misses its slot posts at the next free time).
    // A Create row's Lemo film keeps a slot still ahead (buildBrief drops one gone).
    const scripted = (c.instruction as MakeInstruction).scripted === true;
    if (!scripted && postAt !== null && postAt - REVIEW_BUFFER_MINUTES * 60_000 <= now) postAt = null;
    const brief = buildBrief(this.store, c, look, postAt, now);
    this.announceBrief(t, brief, look.name, round);
    return { brief, offers: 0, lease: undefined, delivery: undefined };
  }

  /** The agent's film a task's video is (a post line's is its kept video's). */
  private deliveryOf(t: CampaignTask): Delivery | undefined {
    const c = t.choices as unknown as TaskChoices;
    if (c.delivery) return c.delivery;
    if (c.sourceTaskId) return (this.campaigns.task(c.sourceTaskId)?.choices as unknown as TaskChoices | undefined)?.delivery;
    return undefined;
  }

  /** The script a task's video was made from (a post line's is its kept video's). */
  private scriptOf(t: CampaignTask): Script | undefined {
    const c = t.choices as unknown as TaskChoices;
    if (c.script) return c.script;
    if (c.sourceTaskId) return (this.campaigns.task(c.sourceTaskId)?.choices as unknown as TaskChoices | undefined)?.script;
    return undefined;
  }

  private async requestReview(t: CampaignTask, c: TaskChoices) {
    const accounts = setAccounts(this.store, c.accountSetId ?? defaultSetId(this.store));
    if (!accounts.length) return this.fail(t.id, "the campaign's account set has no accounts to post to");
    // A held Drive file is captioned by intake; an agent's film by the agent (blank: the review writes one); a
    // campaign video by its script.
    const file = c.driveId ? this.store.driveFile(c.driveId) : undefined;
    if (c.driveId && file?.state !== "held") return this.fail(t.id, `its Drive file is ${file ? file.state : "gone"} now`);
    const delivery = file ? undefined : this.deliveryOf(t);
    const text = file ? { caption: file.caption ?? "", title: file.title ?? "" }
      : delivery ? { caption: delivery.caption ?? "", title: delivery.title ?? "" } : this.scriptOf(t);
    if (!text) return this.fail(t.id, "its script is missing");
    // An agent's film with no style is reviewed as it was delivered.
    // An agent's film goes under its look's name (or the kept video's), not its bare file name.
    const filmName = delivery ? lookByKey(this.store, delivery.manifest.look)?.name ?? c.libraryName ?? delivery.manifest.look : undefined;
    const subject: Subject = file?.choice?.raw ? { kind: "file", path: file.sourcePath!, name: file.choice.name }
      : delivery && t.editId === null ? { kind: "file", path: delivery.path, name: filmName } : { kind: "edit", id: t.editId! };
    const keep = t.kind !== "post" && c.libraryName ? c.libraryName : undefined;
    const planned = c.postTime ? localAt(t.date, c.postTime) : null;
    const q: ReviewRequest = {
      subject,
      accountIds: accounts.map((a) => a.id),
      caption: text.caption,
      title: text.title,
      // What the card shows; the campaign places the post itself once it's approved.
      scheduledAt: !keep && planned !== null && planned > this.now() ? planned : null,
      tiktok: accounts.some((a) => a.platform === "tiktok") ? defaultTikTok(this.store) : null,
      allowDuplicate: false,
      via: "campaign",
      expireAtSchedule: false,
      expiresInHours: REVIEW_HOURS,
      ...(keep ? { keep } : {}),
    };
    // Types that all allow it (the task's own snapshot of them; the review service checks them again itself): it's
    // approved without the user once its file is made, and placed like any approved post. Otherwise it waits.
    const unseen = mayPostUnseen(this.campaigns, c.types ?? []);
    const review = unseen ? await this.reviews.autoApprove(q, c.types) : await this.reviews.request(q);
    this.campaigns.updateTask(t.id, { state: "reviewing", reviewId: review.id });
    const what = subject.kind !== "file" ? `edit ${t.editId}` : file ? `the Drive file ${file.name}` : `the agent's film ${subject.path}`;
    log(t, `${what} sent for review (review ${review.id})${review.auto ? ", approved by its types" : ""}`);
  }

  private followReview(t: CampaignTask, c: TaskChoices) {
    const r = this.reviews.reviews.get(t.reviewId!);
    if (!r) {
      this.campaigns.updateTask(t.id, { reviewId: null });
      return;
    }
    switch (r.state) {
      case "preparing":
      case "pending":
        return;
      case "approved":
        if (r.draft.keep) {
          this.campaigns.updateTask(t.id, { state: "kept" });
          log(t, `kept as ${r.draft.keep}`);
          return;
        }
        if (r.postId === null) return; // the review service is still making the post
        if (this.stopped(t)) return; // the post stays held until resumeAll or Start Campaign
        return this.place(t, c, r.postId);
      case "rejected":
        return this.fail(t.id, "you rejected it in review; nothing was posted", false);
      case "redo":
        // An agent film's redo is a new film: the agent gets a fresh brief with the user's note.
        if (isAgentFilm(c)) return this.redoFilm(t, c, r.note, r.reason);
      // falls through
      case "superseded": {
        // A redo makes a newer edit (the agent's revise_edit): review that one. (A _RAW file has no edit to redo.)
        const latest = t.editId === null ? null : this.store.latestRevision(t.editId);
        if (latest !== null && latest !== t.editId) {
          this.campaigns.updateTask(t.id, { state: "editing", editId: latest, reviewId: null });
          return;
        }
        if (r.state === "superseded") this.campaigns.updateTask(t.id, { reviewId: null }); // asked again next tick
        return;
      }
      case "expired":
        return this.fail(t.id, "its review ended without a decision; nothing was posted");
      case "failed":
        return this.fail(t.id, `its review failed: ${r.error ?? "unknown error"}`);
    }
  }

  /** An approved post: its time, its labels, then it's released. */
  private place(t: CampaignTask, c: TaskChoices, postId: number) {
    const campaign = this.campaigns.campaign(t.campaignId);
    if (!campaign) return this.fail(t.id, "its campaign is gone");
    const at = this.postTime(t, c, campaign);
    if (at === null) return this.fail(t.id, `no day in the next ${MAX_DAYS_AHEAD} has room under the daily post cap of ${campaign.dailyPostCap}`);
    // A held Drive file removed from the folder (or posted another way) since its review: its post is cancelled.
    const file = c.driveId ? this.store.driveFile(c.driveId) : undefined;
    if (c.driveId && (file?.state !== "held" || file.postId !== null)) return this.fail(t.id, `its Drive file is ${file ? file.state : "gone"} now; nothing was posted`);
    const src = c.sourceTaskId ? (this.campaigns.task(c.sourceTaskId)?.choices as unknown as TaskChoices | undefined) ?? c : c;
    // Labels first: the post must carry them before it can publish. A recorded video has no producer; an agent's
    // film is its look's, at the version it was delivered in.
    this.analytics.setLabels({
      postId, source: c.driveId ? "recorded" : "generated", styleId: c.style,
      producer: c.driveId ? null : src.brief?.producer ?? "freeposter-wangp",
      look: src.brief?.look ?? null, lookVersion: src.delivery?.manifest.libraryVersion ?? null,
      hookId: src.hook?.id ?? null, hookText: src.hook?.text ?? null,
      angleId: src.angle?.id ?? null, angleText: src.angle?.text ?? null,
      ctaId: src.cta?.id ?? null, ctaText: src.cta?.text ?? null,
      campaignId: t.campaignId, campaignTaskId: t.id, types: c.types, labelledBy: "campaign",
      lengthSec: c.instruction?.sec ?? null,
    });
    this.store.releasePost(postId, { at });
    this.campaigns.updateTask(t.id, { state: "scheduled", postId });
    // The kept video a post line posted is used: it's never taken again.
    if (c.sourceTaskId) this.campaigns.updateTask(c.sourceTaskId, { state: "posted", postId });
    // So is a held Drive file: it's scheduled now, by its campaign.
    if (c.driveId) this.store.linkDrivePost(c.driveId, postId, `posted by campaign ${campaign.name}`);
    log(t, `post ${postId} scheduled for ${new Date(at).toLocaleString()}`);
  }

  /**
   * When an approved post goes out (placed within a tick of the approval, or after a restart or resumeAll, so "now"
   * is when it's placed). On its own day: its time, or now if that has passed. A later day: the campaign's next free
   * default time. Either way, a day already at the daily cap (counted by the day posts
   * actually go out) passes it on to the next day's first default time, and a minute another campaign post has
   * taken moves it on a minute.
   */
  postTime(t: CampaignTask, c: TaskChoices, campaign: Campaign): number | null {
    const now = this.now();
    const times = [...(campaign.defaultPostTimes.length ? campaign.defaultPostTimes : [c.postTime!])].sort();
    const full = (day: string) => this.postsOn(campaign.id, day, t.id).length >= campaign.dailyPostCap;
    let day = dayKey(now);
    let candidate: number | null = null;
    if (day === t.date) {
      candidate = Math.max(localAt(t.date, c.postTime!), now);
    } else {
      // The next default time that's still ahead and that no other post of this campaign has taken.
      for (let i = 0; i < MAX_DAYS_AHEAD && candidate === null; i++, day = nextDayKey(day)) {
        if (full(day)) continue;
        const taken = new Set(this.postsOn(campaign.id, day, t.id));
        candidate = times.map((hhmm) => localAt(day, hhmm)).find((ms) => ms >= now && !taken.has(ms)) ?? null;
      }
    }
    const minutes = this.takenMinutes(t.id);
    for (let i = 0; candidate !== null && i < MAX_DAYS_AHEAD; i++) {
      while (minutes.has(minute(candidate))) candidate += 60_000;
      const d = dayKey(candidate);
      if (!full(d)) return candidate;
      candidate = localAt(nextDayKey(d), times[0]);
    }
    return null;
  }

  /**
   * The campaign posts placed or out, each counted once, by the task that placed it (the one whose review made it: a
   * kept video a post line posted shares the post, but isn't its owner). This task's own post is left out.
   */
  private placedPosts(exceptTask: number): { campaignId: number; at: number }[] {
    return this.store.db.prepare(
      `SELECT t.campaign_id AS campaignId, COALESCE(p.scheduled_at, p.created_at) AS at FROM campaign_tasks t
       JOIN posts p ON p.id = t.post_id AND p.review_id = t.review_id
       WHERE t.state IN ('scheduled', 'posted') AND t.id != ?`,
    ).all(exceptTask) as { campaignId: number; at: number }[];
  }

  /** The minutes every campaign's placed posts (but this task's) go out at. */
  private takenMinutes(exceptTask: number): Set<number> {
    return new Set(this.placedPosts(exceptTask).map((r) => minute(r.at)));
  }

  /** The times of this campaign's posts (placed, or out) that go out on a local day. */
  private postsOn(campaignId: number, day: string, exceptTask: number): number[] {
    return this.placedPosts(exceptTask).filter((r) => r.campaignId === campaignId && dayKey(r.at) === day).map((r) => r.at);
  }

  private followPost(t: CampaignTask) {
    const post = t.postId === null ? undefined : this.store.post(t.postId);
    if (!post) return this.fail(t.id, "its post was cancelled", false);
    const jobs = this.store.jobsForPost(post.id);
    if (jobs.some((j) => PENDING_JOBS.includes(j.state))) return;
    const failed = jobs.filter((j) => j.state === "failed").map((j) => `${j.platform}: ${j.error ?? "failed"}`);
    if (jobs.some((j) => j.state === "published")) {
      this.campaigns.updateTask(t.id, { state: "posted", error: failed.length ? failed.join("; ") : null });
      return;
    }
    return this.fail(t.id, `it couldn't be posted: ${failed.join("; ") || "no uploads"}`);
  }

  /**
   * A post line: the newest kept campaign video with that name, made in the week up to the line's day, that no other
   * task has taken (taking it is recorded at once, as this task's sourceTaskId); missed once its day is over.
   */
  private async findVideo(t: CampaignTask) {
    const c = t.choices as unknown as TaskChoices;
    const ins = c.instruction as PostInstruction;
    if (this.now() >= endOfDay(t.date)) {
      this.campaigns.updateTask(t.id, { state: "missed", error: `no video named ${ins.name} turned up by the end of the day` });
      this.tell(this.campaigns.task(t.id)!, "campaign.missed", `no video named ${ins.name} turned up by the end of ${t.date}`);
      return;
    }
    if (this.stopped(t)) return;
    const name = ins.name.toLowerCase();
    const from = addDays(t.date, -(KEPT_WINDOW_DAYS - 1));
    const taken = this.store.db.prepare("SELECT 1 FROM campaign_tasks WHERE id != ? AND json_extract(choices, '$.sourceTaskId') = ? LIMIT 1");
    const kept = this.campaigns.tasksIn(["kept"])
      .filter((k) => String((k.choices as unknown as TaskChoices).libraryName ?? "").toLowerCase() === name && k.date >= from && k.date <= t.date)
      .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1))
      .find((k) => !taken.get(t.id, k.id));
    if (!kept) {
      if (this.takeDriveFile(t, name)) return;
      if (this.scheduledByFilename(t, name)) {
        this.campaigns.updateTask(t.id, { state: "missed", error: "already scheduled by its filename" });
        this.tell(this.campaigns.task(t.id)!, "campaign.missed", `the Drive file ${ins.name} was already scheduled by its filename, so it isn't posted again`);
      }
      return; // looked for again next tick
    }
    const keptChoices = kept.choices as unknown as TaskChoices;
    // A kept Lemo film is posted as it was delivered, whatever style the line or its task has (one compiled before
    // Lemo films stopped being edited can have a FreePoster style): FreePoster never edits it.
    if (keptChoices.delivery) {
      this.setChoices(t.id, { sourceTaskId: kept.id, style: null });
      this.campaigns.updateTask(t.id, { state: "reviewing", reviewId: null });
      log(t, `posting ${keptChoices.libraryName} (the agent's film)`);
      return;
    }
    const style = ins.style ?? keptChoices.style;
    this.setChoices(t.id, { sourceTaskId: kept.id, style });
    const keptEdit = kept.editId === null ? undefined : this.store.edit(kept.editId);
    if (style === keptChoices.style && keptEdit?.state === "ready") {
      this.campaigns.updateTask(t.id, { state: "editing", editId: keptEdit.id });
      log(t, `posting ${keptChoices.libraryName} (edit ${keptEdit.id})`);
      return;
    }
    const made = kept.productionId === null ? null : this.productions.productions.get(kept.productionId)?.outputPath ?? null;
    const video = made;
    if (!video) return this.fail(t.id, `${keptChoices.libraryName}'s video is gone`);
    await this.startEdit(t.id, video, style);
  }

  /**
   * A post line's held Drive file (the newest uploaded that no task has taken and the user hasn't released; taking it is recorded at once, as
   * this task's driveId): its own edit goes to review (the line's style can't pick another: intake makes one edit),
   * or, for a _RAW file, the file itself. True when one was taken.
   */
  private takeDriveFile(t: CampaignTask, name: string): boolean {
    const f = this.store.driveFilesIn(["held"])
      .filter((d) => (d.choice?.name ?? "").toLowerCase() === name && !d.releasedAt && !driveFileTaken(this.store, d.driveId))
      .sort((a, b) => (b.uploadedAt ?? b.createdAt) - (a.uploadedAt ?? a.createdAt))[0];
    if (!f) return false;
    this.setChoices(t.id, { driveId: f.driveId, style: f.choice?.styleId ?? null });
    if (f.choice?.raw) {
      this.campaigns.updateTask(t.id, { state: "reviewing", reviewId: null });
      log(t, `posting the Drive file ${f.name} as uploaded (_RAW), after review`);
    } else if (f.editId === null) {
      this.fail(t.id, `the Drive file ${f.name} has no edit`);
    } else {
      const editId = this.store.latestRevision(f.editId);
      this.campaigns.updateTask(t.id, { state: "editing", editId });
      log(t, `posting the Drive file ${f.name} (edit ${editId})`);
    }
    return true;
  }

  /**
   * A Drive file by this name, uploaded in the week up to the line's day, already going out (or gone out) by its own
   * filename: it reached review or has a post (scheduled, posting, posted or partly posted: a Drive file stays
   * "scheduled" while its post goes out). Not one a campaign task posted.
   */
  private scheduledByFilename(t: CampaignTask, name: string): boolean {
    const from = localAt(addDays(t.date, -(KEPT_WINDOW_DAYS - 1)), "00:00");
    const rows = this.store.db.prepare("SELECT drive_id FROM drive_files WHERE state IN ('reviewing', 'scheduled') OR post_id IS NOT NULL").all() as { drive_id: string }[];
    return rows.map((r) => this.store.driveFile(r.drive_id)!).some((d) =>
      (d.choice?.name ?? "").toLowerCase() === name && (d.uploadedAt ?? d.createdAt) >= from && !driveFileTaken(this.store, d.driveId));
  }

  // ---- failures and notifications ----

  /**
   * Today's AI budget is used up: the task goes back to "queued" (never failed) and waits for the budget to reset at
   * local midnight, then tries again; its post is placed then like any later approval. The user is told once a day.
   */
  private waitForBudget(id: number) {
    const now = this.now();
    const until = endOfDay(dayKey(now));
    const waiting = "waiting for tomorrow's AI budget: today's is used up, so its script is written after midnight";
    this.setChoices(id, { waiting, waitUntil: until });
    this.campaigns.updateTask(id, { state: "queued", error: null });
    const t = this.campaigns.task(id)!;
    const c = t.choices as unknown as TaskChoices;
    const name = c.campaignName ?? this.campaigns.campaign(t.campaignId)?.name ?? `campaign ${t.campaignId}`;
    const what = t.kind === "rule" ? "a rule's video" : `video ${t.copy + 1} of "${c.instruction?.source ?? `line ${t.instructionIndex + 1}`}"`;
    log(t, waiting);
    queueEvent(this.store, "campaign.waiting", `campaign.waiting:${id}:${dayKey(now)}`, { campaign_id: t.campaignId, task_id: id, date: t.date, until: new Date(until).toISOString() },
      `Campaign "${name}": ${what} for ${t.date} is waiting for tomorrow's AI budget (today's is used up); FreePoster tries again after midnight.`);
  }

  /**
   * Retries a failed task from the window: what it already made is kept, and only the step that failed runs again. A
   * failed or gone production, edit or review is dropped, while the script and audio are reused; a video already
   * edited goes straight back for approval. A post that failed on a platform is re-queued exactly as a job Retry, so
   * it is held and placed again under the daily cap. Returns why it can't be retried, or null.
   */
  retryTask(id: number): string | null {
    const t = this.campaigns.task(id);
    if (!t) return "no such task";
    if (t.state !== "failed") return "only a failed video can be retried";
    // A post that failed on a platform: its uploads go back to the queue (the same as the job Retry), held until the
    // campaign worker places it again.
    if (t.postId !== null) {
      const jobs = this.store.jobsForPost(t.postId);
      const failed = jobs.filter((j) => j.state === "failed");
      if (jobs.length && failed.length === jobs.length) {
        for (const j of failed) this.store.retryJob(j.id);
        log(t, "retried by the user");
        return null;
      }
    }
    const c = t.choices as unknown as TaskChoices;
    const production = t.productionId === null ? undefined : this.productions.productions.get(t.productionId);
    const edit = t.editId === null ? undefined : this.store.edit(t.editId);
    const patch: Partial<Pick<CampaignTask, "state" | "error" | "productionId" | "editId" | "reviewId" | "postId">> = { error: null, postId: null };
    if (edit?.state === "ready") {
      // Its video is edited and ready: it goes back for approval (a fresh review).
      patch.state = "reviewing";
      patch.reviewId = null;
    } else if (c.instruction.kind === "make" && c.instruction.look) {
      // An agent film: a delivered film still on disk is taken on again; otherwise an agent is asked again, afresh.
      // (One that failed before its brief went out is offered again from the start.) Each retry is a new round,
      // so what happens to it is told again.
      const briefRound = (c.briefRound ?? 1) + 1;
      patch.state = c.brief ? "awaiting_agent" : "queued";
      patch.editId = null;
      patch.reviewId = null;
      const fresh = c.brief && (!c.delivery || !existsSync(c.delivery.path));
      this.setChoices(id, { ...(fresh ? this.freshBrief(t, c, briefRound) : {}), briefRound });
    } else if (production && (production.state === "ready" || production.state === "approved") && production.outputPath) {
      // Its video is made: edit it again.
      patch.state = "rendering";
      patch.editId = null;
      patch.reviewId = null;
    } else {
      // Nothing usable yet: write the script if it has none, then make the video again.
      patch.state = c.script ? "rendering" : "queued";
      patch.productionId = null;
      patch.editId = null;
      patch.reviewId = null;
    }
    this.campaigns.updateTask(id, patch);
    log(t, "retried by the user");
    return null;
  }

  fail(id: number, error: string, notify = true) {
    const t = this.campaigns.task(id);
    if (!t) return;
    this.campaigns.updateTask(id, { state: "failed", error });
    const r = t.reviewId === null ? undefined : this.reviews.reviews.get(t.reviewId);
    // A held Drive file it took and never posted says why (it isn't taken again, or posted by its filename).
    const driveId = (t.choices as unknown as TaskChoices).driveId;
    const file = driveId ? this.store.driveFile(driveId) : undefined;
    if (file?.state === "held" && file.postId === null) {
      const rejected = r?.state === "rejected";
      this.store.upsertDriveFile(file.driveId, {
        state: rejected ? "rejected" : "failed",
        note: `${rejected ? "you rejected it in its campaign's review" : `its campaign task couldn't post it: ${error}`}; nothing was posted. To post it, upload it again`,
      });
    }
    // An approved post this task never placed is still held: it must never go out on its own.
    const started = r?.postId && t.state !== "scheduled" && t.state !== "posted" ? this.cancelHeld(r.postId) : "";
    log(t, `failed: ${error}`);
    if (notify) this.tell(this.campaigns.task(id)!, "campaign.failed", started ? `${error}. ${started}` : error);
  }

  /** A task's campaign name and which of its videos it is, for the user. */
  private describe(t: CampaignTask): { name: string; what: string } {
    const c = t.choices as unknown as TaskChoices;
    const name = c.campaignName ?? this.campaigns.campaign(t.campaignId)?.name ?? `campaign ${t.campaignId}`;
    const ins = c.instruction;
    const what = ins?.kind === "post" ? `the line "post ${ins.name}"` : `video ${t.copy + 1} of "${ins?.source ?? `line ${t.instructionIndex + 1}`}"`;
    return { name, what };
  }

  /** The agent holding a brief (by its claim token) gives it up: the task fails with its reason, and the user is told. */
  giveUp(taskId: number, token: string, reason: string): { ok: true } | { ok: false; error: string } {
    const r = giveUpBrief(this.campaigns, taskId, token, reason, this.now());
    if (r.ok) this.tell(this.campaigns.task(taskId)!, "campaign.failed", `the agent gave up: ${reason}`);
    return r;
  }

  private tell(t: CampaignTask, type: "campaign.failed" | "campaign.missed", error: string) {
    const { name, what } = this.describe(t);
    // A retried agent film is told again: each round after the first has its own key.
    const round = (t.choices as unknown as TaskChoices).briefRound ?? 1;
    const summary = type === "campaign.missed"
      ? `Campaign "${name}" missed ${what} on ${t.date}: ${error}.`
      : `Campaign "${name}" couldn't finish ${what} for ${t.date}: ${error}`;
    queueEvent(this.store, type, round > 1 ? `${type}:${t.id}:${round}` : `${type}:${t.id}`, { campaign_id: t.campaignId, task_id: t.id, date: t.date, error }, summary);
  }

  // ---- stopping one campaign ----

  /** Whether a task's campaign may not go on: every campaign is stopped, or its own is (Stop Campaign) or gone. */
  private stopped(t: CampaignTask): boolean {
    return this.campaigns.killed() || this.campaigns.campaign(t.campaignId)?.enabled === false;
  }

  /**
   * Stop Campaign: nothing new is made or started for it, and its posts not yet out are held (renders under way
   * finish, and wait). Returns how many posts were held.
   */
  stopCampaign(id: number): number {
    this.campaigns.setEnabled(id, false);
    let held = 0;
    for (const t of this.campaigns.tasksIn(["scheduled"])) if (t.campaignId === id && t.postId !== null && this.store.holdPost(t.postId) > 0) held++;
    console.log(`campaign ${id}: stopped; ${held} post${held === 1 ? "" : "s"} held`);
    this.tellStopped(id);
    return held;
  }

  /** Start Campaign: it runs again, and its held posts are placed again (as resumeAll does; not while every campaign is stopped). */
  startCampaign(id: number): number {
    this.campaigns.setEnabled(id, true);
    const released = this.campaigns.killed() ? 0 : this.placeHeld();
    console.log(`campaign ${id}: started; ${released} post${released === 1 ? "" : "s"} released`);
    void this.tick().catch((err) => console.error(`campaigns: ${(err as Error).message}`));
    return released;
  }

  // ---- the kill switch ----

  /** Stops every campaign at once: no new scheduling or starts, and every campaign post not yet out is held. Returns how many posts were held. */
  stopAll(): number {
    this.campaigns.setKilled(true);
    let held = 0;
    for (const t of this.campaigns.tasksIn(["scheduled"])) if (t.postId !== null && this.store.holdPost(t.postId) > 0) held++;
    console.log(`campaigns: stopped; ${held} post${held === 1 ? "" : "s"} held`);
    this.tellStopped(null);
    return held;
  }

  /** Tells onStop, whose failure never undoes the stop. */
  private tellStopped(campaignId: number | null) {
    try {
      this.onStop(campaignId);
    } catch (err) {
      console.error(`campaigns: after stopping: ${(err as Error).message}`);
    }
  }

  /**
   * Lets campaigns run again. Each held post is placed again, earliest first: its old time if that's still ahead and
   * fits the cap, else the way an approval is placed (now on its own day, else the next free default time, the cap
   * counted by the day it now goes out). Returns how many were released.
   */
  resumeAll(): number {
    this.campaigns.setKilled(false);
    const released = this.placeHeld();
    console.log(`campaigns: resumed; ${released} post${released === 1 ? "" : "s"} released`);
    void this.tick().catch((err) => console.error(`campaigns: ${(err as Error).message}`));
    return released;
  }

  /**
   * Places again every held post of a "scheduled" task (see resumeAll); a retried campaign job (retryJob) comes back
   * this way too, so it never goes out by itself. Only while campaigns run. Returns how many were released.
   */
  private placeHeld(): number {
    const now = this.now();
    const held = this.campaigns.tasksIn(["scheduled"]).flatMap((t) => {
      const from = t.postId === null ? undefined : this.store.jobsForPost(t.postId).map((j) => j.progress.heldFrom).find((h): h is number => typeof h === "number");
      return from === undefined ? [] : [{ t, from }];
    }).sort((a, b) => a.from - b.from || a.t.id - b.t.id);
    let released = 0;
    for (const { t, from } of held) {
      try {
        const c = t.choices as unknown as TaskChoices;
        const campaign = this.campaigns.campaign(t.campaignId);
        if (!campaign) { const started = this.cancelHeld(t.postId!); this.fail(t.id, `its campaign is gone${started ? `. ${started}` : ""}`); continue; }
        if (!campaign.enabled) continue; // its campaign is stopped: held until Start Campaign
        const stillFits = from >= now && this.postsOn(campaign.id, dayKey(from), t.id).length < campaign.dailyPostCap && !this.takenMinutes(t.id).has(minute(from));
        const at = stillFits ? from : this.postTime(t, c, campaign);
        if (at === null) {
          const started = this.cancelHeld(t.postId!);
          this.fail(t.id, `no day in the next ${MAX_DAYS_AHEAD} has room under the daily post cap of ${campaign.dailyPostCap}${started ? `. ${started}` : ""}`);
          continue;
        }
        if (this.store.releasePost(t.postId!, { at }) > 0) released++;
      } catch (err) {
        this.fail(t.id, (err as Error).message);
      }
    }
    return released;
  }

  // ---- held posts nobody will place ----

  /**
   * Stops a campaign post while it's still held: its jobs that never tried are cancelled; one that already tried (or
   * carries an upload checkpoint) can't just be deleted, since it may have half-made a post, so it's finished as
   * failed (kept in the history, never sent on its own). Returns what the user should know: "" when nothing had
   * started, else a sentence naming where to look for a leftover draft.
   */
  private cancelHeld(postId: number): string {
    const held = this.store.jobsForPost(postId).some((j) => typeof j.progress.heldFrom === "number");
    if (!held) return "";
    this.store.cancelPost(postId);
    const started = this.store.post(postId) ? this.store.failHeld(postId) : [];
    if (!started.length) {
      console.log(`campaigns: cancelled held post ${postId}`);
      return "";
    }
    const where = started.join(", ");
    console.log(`campaigns: stopped held post ${postId}; it had already started on ${where}, so those uploads are marked failed`);
    return `Its upload had already started on ${where}, so it was stopped and marked failed rather than deleted: check ${where} for a leftover draft.`;
  }

  /**
   * Every tick: a held campaign post whose task isn't waiting to place it (reviewing that review) or holding it
   * (scheduled with it) would be held forever, e.g. approved after its task failed. It's cancelled, and the user told.
   */
  private sweepHeld() {
    const rows = this.store.db.prepare(
      `SELECT DISTINCT p.id AS post_id, p.review_id AS review_id FROM posts p
       JOIN jobs j ON j.post_id = p.id JOIN reviews r ON r.id = p.review_id
       WHERE r.requested_via = 'campaign' AND json_extract(j.progress, '$.heldFrom') IS NOT NULL`,
    ).all() as { post_id: number; review_id: number }[];
    for (const { post_id, review_id } of rows) {
      const tasks = this.store.db.prepare("SELECT id FROM campaign_tasks WHERE review_id = ? OR post_id = ?").all(review_id, post_id) as { id: number }[];
      const wanted = tasks.map((r) => this.campaigns.task(r.id)!).some((t) =>
        (t.state === "reviewing" && t.reviewId === review_id) || (t.state === "scheduled" && t.postId === post_id));
      if (wanted) continue;
      const started = this.cancelHeld(post_id);
      const task = tasks[0] ? this.campaigns.task(tasks[0].id) : undefined;
      const what = started ? `its post was stopped. ${started}` : "its post was cancelled and nothing was posted.";
      queueEvent(this.store, "campaign.failed", `campaign.failed:post:${post_id}`,
        { campaign_id: task?.campaignId ?? null, task_id: task?.id ?? null, post_id, review_id, error: "approved after its campaign task had stopped", started: Boolean(started) },
        `A campaign video was approved (review ${review_id}) after its campaign task had stopped${task?.error ? ` (${task.error})` : ""}, so ${what}`);
    }
  }

  // ---- whose video it is ----

  /**
   * Whether this video is a campaign's (its production, its edit, a revision of that edit, or an agent's delivered
   * film, in any state): only the campaign worker's own requests may send it for review, so it can never be
   * approved, and posted, twice.
   */
  owns(s: Subject): boolean {
    if (s.kind === "file") {
      const films = this.store.db.prepare(
        "SELECT json_extract(choices, '$.delivery.path') AS path, json_extract(choices, '$.delivery.hash') AS hash FROM campaign_tasks WHERE json_extract(choices, '$.delivery.path') IS NOT NULL",
      ).all() as { path: string; hash: string | null }[];
      if (!films.length) return false;
      // The same path however it's written (relative, "..", or another case on Windows), or the same film copied.
      const key = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
      const want = key(s.path);
      if (films.some((f) => key(f.path) === want)) return true;
      if (!existsSync(s.path) || !statSync(s.path).isFile()) return false;
      const hash = createHash("sha256").update(readFileSync(s.path)).digest("hex");
      return films.some((f) => f.hash === hash);
    }
    return campaignTaskFor(this.store, s.kind, s.id) !== null;
  }
}
