// Briefs: what an agent film waits as. A task for an agent holds a brief; an agent claims it under a time-limited
// lease and delivers a finished video file, which is checked here before the worker takes it on.
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Store } from "../db.ts";
import { probe } from "../media.ts";
import { hashFile } from "../review/media.ts";
import type { Look } from "./looks.ts";
import { foreignLinks, hasLink, type Script } from "./script.ts";
import type { CampaignStore, CampaignTask } from "./store.ts";
import type { TaskChoices } from "./worker.ts";

/** An Agent row's film is asked for this long before the video is due. */
export const BRIEF_LEAD_HOURS = 6;
/** A Create row's Lemo film is made (and briefed at once) this long before its slot, so Claude has time to film it. */
export const CLAUDE_LEAD_HOURS = 48;
export const LEASE_MINUTES = 120;
/** The time kept between an Agent row's delivery and its post time for the review. */
export const REVIEW_BUFFER_MINUTES = 30;
export const MAX_BRIEF_OFFERS = 2;

const MIN = 60_000;
const DAY = 24 * 3_600_000;

export interface Brief {
  look: string;
  producer: string;
  hook: string;
  angle: string;
  cta: { text: string; url: string | null };
  sec: number | null;
  instructions: string | null;
  language: string;
  needsImageGen: boolean;
  deadline: number;
  postAt: number | null;
  /**
   * The script FreePoster wrote for a Create row with a Lemo style: the agent films it as written. Null for an
   * Agent row (the agent writes its own treatment). A brief stored before briefs had one has none (read as null).
   */
  script: string | null;
  /** The film model (`claude:<model>` or `google:<model>`) the row chose to make it; null for the default (and on an older brief). */
  model: string | null;
}

export interface Delivery {
  path: string;
  hash: string;
  durationSec: number;
  manifest: { look: string; libraryVersion: string; treatmentPath?: string };
  caption?: string;
  title?: string;
  deliveredAt: number;
}

/**
 * A claim on a brief. The token is the claim's own identity: only whoever holds it may renew, deliver or give up, so
 * two agents under one client name can never both hold it. The holder (the MCP client's name) is shown and logged.
 */
export interface Lease {
  holder: string;
  until: number;
  token: string;
  /** when this claim was taken (a renewal keeps it) */
  claimedAt: number;
}

/** How far the agent says its film is, as it last reported. */
export interface Progress {
  /** 0 to 100 */
  percent: number;
  /** what it's doing now, in a few words */
  step: string | null;
  at: number;
}

type Leased = { ok: true; brief: Brief; leaseUntil: number; token: string } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });
const choicesOf = (t: CampaignTask) => t.choices as unknown as TaskChoices;
const iso = (ms: number) => new Date(ms).toISOString();

/** A script as the agent reads it: its spoken lines, then its shots with their lengths. */
export const scriptText = (s: Script) => [...s.lines, "", "Shots:", ...s.shots.map((sh) => `- ${sh.prompt} (${sh.sec}s)`)].join("\n");

/**
 * The brief for a task: the chosen words, the look, the script and model, and when the film is needed by. An Agent
 * row's film is due REVIEW_BUFFER_MINUTES before its slot. A Create row's Lemo film (scripted) runs like a WanGP
 * video: it's wanted within a day whatever its slot, and a film that arrives after the slot posts once approved; a
 * slot already gone isn't given as its post time.
 */
export function buildBrief(store: Store, c: TaskChoices, look: Look, postAt: number | null, now: number): Brief {
  const instruction = c.instruction as { sec?: number | null; instructions?: string; model?: string; scripted?: boolean } | undefined;
  const scripted = instruction?.scripted === true;
  if (scripted && postAt !== null && postAt <= now) postAt = null;
  return {
    look: look.key,
    producer: look.producer,
    hook: c.hook?.text ?? "",
    angle: c.angle?.text ?? "",
    cta: { text: c.cta?.text ?? "", url: c.cta?.url ?? null },
    sec: instruction?.sec ?? null,
    instructions: instruction?.instructions ?? null,
    language: store.pref<string>("agent.language") ?? "en",
    needsImageGen: look.needsImageGen,
    deadline: postAt === null || scripted ? now + DAY : postAt - REVIEW_BUFFER_MINUTES * MIN,
    postAt,
    script: c.script ? scriptText(c.script) : null,
    model: instruction?.model ?? null,
  };
}

const leaseLive = (c: TaskChoices, now: number) => Boolean(c.lease && c.lease.until > now);

/** Briefs an agent could claim now: no lease, or one that has run out, and never while its campaign is stopped. */
export function openBriefs(cs: CampaignStore, now: number): CampaignTask[] {
  if (cs.killed()) return [];
  return cs.tasksIn(["awaiting_agent"]).filter((t) => {
    const c = choicesOf(t);
    return c.brief && !c.delivery && !leaseLive(c, now) && cs.campaign(t.campaignId)?.enabled === true;
  });
}

const OTHER_CLAIM = "this brief is claimed under another claim; call claim_brief to get your own";

/** Why this token can't act on the task's lease now, or null when it holds a live one. */
function notHeld(c: TaskChoices, taskId: number, token: string, now: number): string | null {
  if (!c.lease || !token || c.lease.token !== token) return OTHER_CLAIM;
  if (!leaseLive(c, now)) return `your lease on task ${taskId} has run out; claim it again`;
  return null;
}

/** Why a task can't be worked on, or null when it has an open brief. */
function refusal(cs: CampaignStore, t: CampaignTask | undefined, taskId: number): string | null {
  if (!t || t.state !== "awaiting_agent" || !choicesOf(t).brief || choicesOf(t).delivery) return `task ${taskId} has no open brief`;
  if (cs.killed() || !cs.campaign(t.campaignId)?.enabled) return "the campaign is stopped";
  return null;
}

function lease(cs: CampaignStore, t: CampaignTask, l: Omit<Lease, "until">, now: number, offers: number): Leased {
  const brief = choicesOf(t).brief!;
  const until = Math.min(now + LEASE_MINUTES * MIN, brief.deadline);
  cs.updateTask(t.id, { choices: { ...t.choices, lease: { ...l, until }, offers } });
  return { ok: true, brief, leaseUntil: until, token: l.token };
}

/**
 * Takes a brief under a new claim, whose token is returned. While a claim is live, only its own token claims again
 * (and gets the same lease back); anyone else, under any name, is refused.
 */
export function claimBrief(cs: CampaignStore, taskId: number, holder: string, now: number, token?: string): Leased {
  const t = cs.task(taskId);
  const why = refusal(cs, t, taskId);
  if (why) return fail(why);
  const c = choicesOf(t!);
  if (leaseLive(c, now)) {
    if (!token || c.lease!.token !== token) return fail(`claimed by ${c.lease!.holder} until ${iso(c.lease!.until)}`);
    return { ok: true, brief: c.brief!, leaseUntil: c.lease!.until, token };
  }
  if (c.brief!.deadline <= now) return fail(`the deadline for task ${taskId} has passed`);
  const offers = c.offers ?? 0;
  if (offers >= MAX_BRIEF_OFFERS) return fail(`no offers left for task ${taskId}`);
  return lease(cs, t!, { holder, token: randomUUID(), claimedAt: now }, now, offers + 1);
}

/**
 * The holder says how far its film is (renew_brief's percent and step). Only the live claim may; `changed` is false
 * when it said the same as last time (so a repeat isn't logged again).
 */
export function reportProgress(cs: CampaignStore, taskId: number, token: string, percent: number, step: string | null, now: number):
  { ok: true; changed: boolean; progress: Progress } | { ok: false; error: string } {
  const t = cs.task(taskId);
  const why = refusal(cs, t, taskId);
  if (why) return fail(why);
  const c = choicesOf(t!);
  const held = notHeld(c, taskId, token, now);
  if (held) return fail(held);
  const progress: Progress = { percent: Math.max(0, Math.min(100, Math.round(percent))), step, at: now };
  const changed = c.progress?.percent !== progress.percent || c.progress?.step !== progress.step;
  cs.updateTask(taskId, { choices: { ...t!.choices, progress } });
  return { ok: true, changed, progress };
}

/** The claim's lease runs another stretch, never past the brief's deadline. */
export function renewBrief(cs: CampaignStore, taskId: number, token: string, now: number): Leased {
  const t = cs.task(taskId);
  const why = refusal(cs, t, taskId);
  if (why) return fail(why);
  const c = choicesOf(t!);
  const held = notHeld(c, taskId, token, now);
  if (held) return fail(held);
  const { holder, claimedAt } = c.lease!;
  return lease(cs, t!, { holder, token, claimedAt: claimedAt ?? now }, now, c.offers ?? 1);
}

/** Whether a delivery may be written now (the task, its campaign, deadline, lease and file's uniqueness); the refusal if not. */
function checkSubmit(cs: CampaignStore, t: CampaignTask | undefined, taskId: number, token: string, hash: string, now: number) {
  const why = refusal(cs, t, taskId);
  if (why) return fail(why);
  const c = choicesOf(t!);
  if (c.brief!.deadline < now) return fail(`the deadline for task ${taskId} has passed`);
  const held = notHeld(c, taskId, token, now);
  if (held) return fail(held);
  for (const other of cs.tasksIn(["awaiting_agent", "editing", "reviewing", "scheduled", "posted", "kept", "replaced"])) {
    if (other.id !== taskId && choicesOf(other).delivery?.hash === hash) return fail(`this file was already delivered for task ${other.id}`);
  }
  return null;
}

/**
 * The agent's caption and title, through the same link check as a campaign script: the only link is the brief's
 * CTA link, and when it has one the caption must carry it (so a caption is needed). Every problem, or none.
 */
export function captionProblems(brief: Brief, caption: string | undefined, title: string | undefined): string[] {
  const problems = foreignLinks([caption ?? "", title ?? ""], { hook: brief.hook, angle: brief.angle, cta: brief.cta.text, url: brief.cta.url });
  const url = brief.cta.url;
  if (url && !hasLink(caption ?? "", url)) problems.push(`caption must include ${url}; write the caption, with the link`);
  return problems;
}

export async function submitBrief(
  _store: Store, cs: CampaignStore, taskId: number, token: string,
  input: { videoPath: string; manifest: Delivery["manifest"]; caption?: string; title?: string }, now: number,
): Promise<{ ok: true; repeat: boolean } | { ok: false; error: string }> {
  const t = cs.task(taskId);
  if (!t || t.state !== "awaiting_agent" || !choicesOf(t).brief) return fail(`task ${taskId} has no open brief`);
  const path = input.videoPath;
  if (typeof path !== "string" || !isAbsolute(path)) return fail("video_path must be an absolute path on this computer");
  if (!existsSync(path) || !statSync(path).isFile()) return fail(`no file at ${path}`);
  const hash = await hashFile(path);

  const done = choicesOf(t).delivery;
  if (done) return done.hash === hash ? { ok: true, repeat: true } : fail(`task ${taskId} already has a delivery`);

  const words = captionProblems(choicesOf(t).brief!, input.caption, input.title);
  if (words.length) return fail(words.join("; "));

  const early = checkSubmit(cs, t, taskId, token, hash, now);
  if (early) return early;
  const brief = choicesOf(t).brief!;

  let p;
  try { p = await probe(path); } catch (err) { return fail((err as Error).message); }
  // Resolution, frame rate, codec and audio are not checked here: FreePoster's render step normalizes them.
  // Shape and length cannot be fixed by a render, so those are.
  if (!p.width || !p.height || Math.abs(p.width / p.height - 9 / 16) > 0.01 * (9 / 16)) {
    return fail(`the film is ${p.width}x${p.height}; it must be portrait 9:16`);
  }
  if (brief.sec !== null) {
    const slack = Math.max(brief.sec * 0.2, 2);
    if (Math.abs(p.durationSec - brief.sec) > slack) {
      return fail(`the film is ${p.durationSec.toFixed(1)} s long; this brief asks for ${brief.sec} s (±${+slack.toFixed(1)} s), so its length is off`);
    }
  }

  // The task may have moved on while the file was read: check again, then write without waiting.
  const fresh = cs.task(taskId);
  if (fresh && choicesOf(fresh).delivery?.hash === hash) return { ok: true, repeat: true };
  const late = checkSubmit(cs, fresh, taskId, token, hash, now);
  if (late) return late;
  const delivery: Delivery = {
    path, hash, durationSec: p.durationSec, manifest: input.manifest,
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    deliveredAt: now,
  };
  const { lease: _released, ...rest } = fresh!.choices as Record<string, unknown>;
  cs.updateTask(taskId, { choices: { ...rest, delivery } });
  return { ok: true, repeat: false };
}

/** The claim's holder stops while its lease is live: the task fails with the agent's reason. */
export function giveUpBrief(cs: CampaignStore, taskId: number, token: string, reason: string, now: number): { ok: true } | { ok: false; error: string } {
  const t = cs.task(taskId);
  if (!t || t.state !== "awaiting_agent" || !choicesOf(t).brief) return fail(`task ${taskId} has no open brief`);
  const held = notHeld(choicesOf(t), taskId, token, now);
  if (held) return fail(held);
  cs.updateTask(taskId, { state: "failed", error: `the agent gave up: ${reason}` });
  return { ok: true };
}
