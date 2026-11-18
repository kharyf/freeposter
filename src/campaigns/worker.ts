// Runs confirmed campaigns, with plain code only (the one AI call is the script writer's). Every tick:
//  - materialize: today's instructions of every runnable campaign become tasks, one per copy (local calendar day;
//    a day the app was closed is never back-filled). Each task keeps a snapshot of the instruction it came from and
//    the hook / angle / CTA it was given, so editing the campaign never changes a task already made.
//  - make: script (AI) → WanGP voiceover and music → production → the editing style's edit → review. Nothing a
//    campaign makes posts without the user's approval here.
//  - post: a "post" line waits for a kept campaign video with that name until the local day ends (then "missed").
//  - placing an approved post: the review service makes a campaign's post held; this worker picks its time (the
//    line's time today, now if that has passed today, the next free default time if approved on a later day), keeps
//    the daily cap by the day it actually posts, writes its labels, and only then releases it.
//  - kill switch: stopAll() holds every campaign post not yet out and nothing new is scheduled or started; renders
//    under way finish. resumeAll() lets them go.
// WanGP speech and music aren't production shots, so they borrow the production worker's GPU lane (borrowGpu): they
// run only while no GPU shot is running, one at a time, and no GPU shot starts while they run.
// One task failing never stops another: each step is caught per task, and a failure is told to the user.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultSetId, defaultTikTok, setAccounts } from "../accounts.ts";
import type { AiService } from "../ai/router.ts";
import { compareLabels, scoreVideos, type ScoredJob } from "../analytics/score.ts";
import { AnalyticsStore } from "../analytics/store.ts";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { styleById } from "../edit/styles.ts";
import { queueEvent } from "../notify.ts";
import type { ProductionSpec } from "../produce/spec.ts";
import type { Production, ProductionStore } from "../produce/store.ts";
import { generateMusic, generateSpeech } from "../produce/wan-audio.ts";
import { hashFile } from "../review/media.ts";
import type { ReviewService, Subject } from "../review/service.ts";
import { buildGeneratedProduction, writeScript, type Script } from "./script.ts";
import { DAYS, type MakeInstruction, type Pick as ValuePick, type PostInstruction } from "./spec.ts";
import { CampaignStore, type Campaign, type CampaignTask, type LibraryEntry, type LibraryKind, type TaskState } from "./store.ts";

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
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** States a task is still being worked on in. */
const ACTIVE: TaskState[] = ["queued", "scripting", "rendering", "editing", "reviewing", "scheduled"];
/** Before it posts: the video is the campaign's alone (no other review may be asked for it). */
const IN_FLIGHT: TaskState[] = ["queued", "scripting", "rendering", "editing", "reviewing"];
const PENDING_JOBS = ["queued", "running", "retry", "waiting_quota"];
/** Campaign reviews wait for the user well past their post time (approved a later day, it takes a later time). */
const REVIEW_HOURS = 24 * 7;
/** How far ahead a post is placed before giving up (a cap of 0, say). */
const MAX_DAYS_AHEAD = 60;
/** The score age "best" ranks by: the "working" default's. */
const BEST_AGE = "72h";

const pad = (n: number) => String(n).padStart(2, "0");
/** The local calendar day of a time, YYYY-MM-DD. */
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const parseDay = (key: string) => key.split("-").map(Number) as [number, number, number];
/** That local day at "HH:MM" (a time a DST change skips moves forward, as Date does). */
export const localAt = (key: string, hhmm: string) => {
  const [y, m, d] = parseDay(key);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).getTime();
};
const nextDayKey = (key: string) => {
  const [y, m, d] = parseDay(key);
  return dayKey(new Date(y, m - 1, d + 1, 12).getTime());
};
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
}

/**
 * The hook, angle or CTA for one copy. random: uniform among the values the day's batch hasn't had yet (repeating
 * only once the library runs out); best: the highest median score with enough videos, random until one has;
 * named: that entry. Null when there is nothing to pick. (Values a rule stopped using are a later task's filter.)
 */
export function pickValue(kind: LibraryKind, pick: ValuePick, ctx: PickContext): LibraryEntry | null {
  const pool = ctx.pool(kind);
  const random = () => {
    const fresh = pool.filter((e) => !ctx.used[kind].has(e.id));
    const from = fresh.length ? fresh : pool;
    return from.length ? from[Math.min(Math.floor(ctx.random() * from.length), from.length - 1)] : null;
  };
  let chosen: LibraryEntry | null = null;
  if (pick.pick === "named") chosen = pool.find((e) => e.id === pick.id) ?? null;
  else if (pick.pick === "best") chosen = ctx.best(kind).map((id) => pool.find((e) => e.id === id)).find((e) => e !== undefined) ?? random();
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
        made += this.materializeCampaign(c, key, dayIndex, best);
      } catch (err) {
        console.error(`campaign ${c.id}: couldn't make today's tasks: ${(err as Error).message}`);
      }
    }
    return made;
  }

  private materializeCampaign(c: Campaign, key: string, dayIndex: number, best: Map<LibraryKind, number[]>): number {
    const instructions = c.compiled!.days[DAYS[dayIndex]] ?? [];
    if (!instructions.length) return 0;
    const existing = this.campaigns.tasksOn(c.id, key);
    const have = new Set(existing.map((t) => `${t.instructionIndex}:${t.copy}`));
    const used: Record<LibraryKind, Set<number>> = { hook: new Set(), angle: new Set(), cta: new Set() };
    for (const t of existing) {
      for (const kind of ["hook", "angle", "cta"] as LibraryKind[]) {
        const e = t.choices[kind] as LibraryEntry | undefined;
        if (e) used[kind].add(e.id);
      }
    }
    const pools = new Map<LibraryKind, LibraryEntry[]>();
    const ctx: PickContext = {
      pool: (kind) => { if (!pools.has(kind)) pools.set(kind, this.campaigns.entries(kind)); return pools.get(kind)!; },
      used,
      random: this.random,
      best: (kind) => { if (!best.has(kind)) best.set(kind, this.bestRanking(kind)); return best.get(kind)!; },
    };
    let made = 0;
    instructions.forEach((ins, index) => {
      const copies = ins.kind === "make" ? ins.count : 1;
      for (let copy = 0; copy < copies; copy++) {
        if (have.has(`${index}:${copy}`)) continue;
        const { choices, error } = this.resolve(c, ins, copy, DAY_LABELS[dayIndex], ctx);
        const id = this.campaigns.addTask({
          campaignId: c.id, date: key, dayIndex, instructionIndex: index, copy, kind: ins.kind, choices: choices as unknown as Record<string, unknown>,
          state: error ? "failed" : "queued", error,
        });
        if (id === null) continue;
        made++;
        if (error) this.tell(this.campaigns.task(id)!, "campaign.failed", error);
      }
    });
    return made;
  }

  /** One copy's choices; an error when it can't be made at all. */
  private resolve(c: Campaign, ins: MakeInstruction | PostInstruction, copy: number, day: string, ctx: PickContext): { choices: TaskChoices; error: string | null } {
    const defaults = c.defaultPostTimes;
    const choices: TaskChoices = {
      instruction: structuredClone(ins), campaignName: c.name, day, style: ins.style, types: [...ins.types], postTime: null, accountSetId: c.accountSetId,
    };
    const problems: string[] = [];
    if (ins.kind === "make") {
      for (const kind of ["hook", "angle", "cta"] as LibraryKind[]) {
        const entry = pickValue(kind, ins[kind], ctx);
        if (entry) choices[kind] = entry;
        else problems.push(ins[kind].pick === "named" ? `its ${kind} is no longer in the library` : `the library has no ${kind} to pick`);
      }
      if (ins.post === null) choices.libraryName = `${c.name.replace(/\s+/g, "")}-${day}-${copy + 1}`;
      else if (ins.post.at !== "default") choices.postTime = ins.post.at;
      else if (defaults.length) choices.postTime = defaults[copy % defaults.length];
      else problems.push("it posts at the default time, and the campaign has no default post times");
    } else {
      choices.postTime = ins.at ?? defaults[0] ?? null;
      if (!choices.postTime) problems.push("the line has no time, and the campaign has no default post times");
    }
    return { choices, error: problems.length ? problems.join("; ") : null };
  }

  /** Library ids of a kind by median score (enough videos only), best first. Plain code: no AI. */
  private bestRanking(kind: LibraryKind): number[] {
    const labels = this.analytics.allLabels();
    if (!labels.length) return [];
    const rows = this.store.db.prepare("SELECT id, published_at FROM jobs WHERE published_at IS NOT NULL").all() as { id: number; published_at: number }[];
    const jobs: ScoredJob[] = rows.map((r) => ({ ...this.store.job(r.id)!, publishedAt: r.published_at }));
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
        if (this.campaigns.killed()) return; // stopped: nothing new starts
        this.campaigns.updateTask(t.id, { state: "scripting" });
        return this.spawn(t, () => this.makeScript(t.id));
      case "scripting":
        // A script left half-written by a restart is written again.
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
      const script = await this.write({ ai: this.ai }, { hook: c.hook!, angle: c.angle!, cta: c.cta! });
      this.setChoices(id, { script });
    }
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
    const script = this.scriptOf(t);
    if (!script) return this.fail(t.id, "its script is missing");
    const keep = t.kind !== "post" && c.libraryName ? c.libraryName : undefined;
    const planned = c.postTime ? localAt(t.date, c.postTime) : null;
    const review = await this.reviews.request({
      subject: { kind: "edit", id: t.editId! },
      accountIds: accounts.map((a) => a.id),
      caption: script.caption,
      title: script.title,
      // What the card shows; the campaign places the post itself once it's approved.
      scheduledAt: !keep && planned !== null && planned > this.now() ? planned : null,
      tiktok: accounts.some((a) => a.platform === "tiktok") ? defaultTikTok(this.store) : null,
      allowDuplicate: false,
      via: "campaign",
      expireAtSchedule: false,
      expiresInHours: REVIEW_HOURS,
      ...(keep ? { keep } : {}),
    });
    this.campaigns.updateTask(t.id, { state: "reviewing", reviewId: review.id });
    log(t, `edit ${t.editId} sent for review (review ${review.id})`);
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
        if (this.campaigns.killed()) return; // the post stays held until resumeAll
        return this.place(t, c, r.postId);
      case "rejected":
        return this.fail(t.id, "you rejected it in review; nothing was posted", false);
      case "redo":
      case "superseded": {
        // A redo makes a newer edit (the agent's revise_edit): review that one.
        const latest = this.store.latestRevision(t.editId!);
        if (latest !== t.editId) {
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
    const src = c.sourceTaskId ? (this.campaigns.task(c.sourceTaskId)?.choices as unknown as TaskChoices | undefined) ?? c : c;
    // Labels first: the post must carry them before it can publish.
    this.analytics.setLabels({
      postId, source: "generated", styleId: c.style,
      hookId: src.hook?.id ?? null, hookText: src.hook?.text ?? null,
      angleId: src.angle?.id ?? null, angleText: src.angle?.text ?? null,
      ctaId: src.cta?.id ?? null, ctaText: src.cta?.text ?? null,
      campaignId: t.campaignId, campaignTaskId: t.id, types: c.types, labelledBy: "campaign",
    });
    this.store.releasePost(postId, { at });
    this.campaigns.updateTask(t.id, { state: "scheduled", postId });
    log(t, `post ${postId} scheduled for ${new Date(at).toLocaleString()}`);
  }

  /**
   * When an approved post goes out (placed within a tick of the approval, or after a restart or resumeAll, so "now"
   * is when it's placed). On its own day: its time, or now if that has passed. A later day: the campaign's next free
   * default time. Either way, a day already at the daily cap (counted by the day posts
   * actually go out) passes it on to the next day's first default time.
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
    for (let i = 0; candidate !== null && i < MAX_DAYS_AHEAD; i++) {
      const d = dayKey(candidate);
      if (!full(d)) return candidate;
      candidate = localAt(nextDayKey(d), times[0]);
    }
    return null;
  }

  /** The times of this campaign's posts (placed, or out) that go out on a local day. */
  private postsOn(campaignId: number, day: string, exceptTask: number): number[] {
    const rows = this.store.db.prepare(
      `SELECT COALESCE(p.scheduled_at, p.created_at) AS at FROM campaign_tasks t JOIN posts p ON p.id = t.post_id
       WHERE t.campaign_id = ? AND t.state IN ('scheduled', 'posted') AND t.id != ?`,
    ).all(campaignId, exceptTask) as { at: number }[];
    return rows.map((r) => r.at).filter((at) => dayKey(at) === day);
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

  /** A post line: the kept campaign video with that name (first made first); missed once its day is over. */
  private async findVideo(t: CampaignTask) {
    const c = t.choices as unknown as TaskChoices;
    const ins = c.instruction as PostInstruction;
    if (this.now() >= endOfDay(t.date)) {
      this.campaigns.updateTask(t.id, { state: "missed", error: `no video named ${ins.name} turned up by the end of the day` });
      this.tell(this.campaigns.task(t.id)!, "campaign.missed", `no video named ${ins.name} turned up by the end of ${t.date}`);
      return;
    }
    if (this.campaigns.killed()) return;
    const name = ins.name.toLowerCase();
    const kept = this.campaigns.tasksIn(["kept"]).find((k) => String((k.choices as unknown as TaskChoices).libraryName ?? "").toLowerCase() === name);
    if (!kept) return; // looked for again next tick
    const keptChoices = kept.choices as unknown as TaskChoices;
    const style = ins.style ?? keptChoices.style;
    this.setChoices(t.id, { sourceTaskId: kept.id, style });
    const keptEdit = kept.editId === null ? undefined : this.store.edit(kept.editId);
    if (style === keptChoices.style && keptEdit?.state === "ready") {
      this.campaigns.updateTask(t.id, { state: "editing", editId: keptEdit.id });
      log(t, `posting ${keptChoices.libraryName} (edit ${keptEdit.id})`);
      return;
    }
    const video = kept.productionId === null ? null : this.productions.productions.get(kept.productionId)?.outputPath ?? null;
    if (!video) return this.fail(t.id, `${keptChoices.libraryName}'s video is gone`);
    await this.startEdit(t.id, video, style);
  }

  // ---- failures and notifications ----

  fail(id: number, error: string, notify = true) {
    const t = this.campaigns.task(id);
    if (!t) return;
    this.campaigns.updateTask(id, { state: "failed", error });
    log(t, `failed: ${error}`);
    if (notify) this.tell(this.campaigns.task(id)!, "campaign.failed", error);
  }

  private tell(t: CampaignTask, type: "campaign.failed" | "campaign.missed", error: string) {
    const c = t.choices as unknown as TaskChoices;
    const name = c.campaignName ?? this.campaigns.campaign(t.campaignId)?.name ?? `campaign ${t.campaignId}`;
    const ins = c.instruction;
    const what = ins?.kind === "post" ? `the line "post ${ins.name}"` : `video ${t.copy + 1} of "${ins?.source ?? `line ${t.instructionIndex + 1}`}"`;
    const summary = type === "campaign.missed"
      ? `Campaign "${name}" missed ${what} on ${t.date}: ${error}.`
      : `Campaign "${name}" couldn't finish ${what} for ${t.date}: ${error}`;
    queueEvent(this.store, type, `${type}:${t.id}`, { campaign_id: t.campaignId, task_id: t.id, date: t.date, error }, summary);
  }

  // ---- the kill switch ----

  /** Stops every campaign at once: no new scheduling or starts, and every campaign post not yet out is held. Returns how many posts were held. */
  stopAll(): number {
    this.campaigns.setKilled(true);
    let held = 0;
    for (const t of this.campaigns.tasksIn(["scheduled"])) if (t.postId !== null && this.store.holdPost(t.postId) > 0) held++;
    console.log(`campaigns: stopped; ${held} post${held === 1 ? "" : "s"} held`);
    return held;
  }

  /** Lets campaigns run again: held posts go back to their time (now if it has passed). Returns how many were released. */
  resumeAll(): number {
    this.campaigns.setKilled(false);
    let released = 0;
    for (const t of this.campaigns.tasksIn(["scheduled"])) if (t.postId !== null && this.store.releasePost(t.postId, { now: this.now() }) > 0) released++;
    console.log(`campaigns: resumed; ${released} post${released === 1 ? "" : "s"} released`);
    void this.tick().catch((err) => console.error(`campaigns: ${(err as Error).message}`));
    return released;
  }

  // ---- whose video it is ----

  /** Whether a campaign task is still making this video (so only the campaign may send it for review). */
  owns(s: Subject): boolean {
    if (s.kind === "file") return false;
    const tasks = this.campaigns.tasksIn(IN_FLIGHT);
    if (s.kind === "production") return tasks.some((t) => t.productionId === s.id);
    return tasks.some((t) => t.editId !== null && (t.editId === s.id || this.store.latestRevision(t.editId) === s.id));
  }
}
