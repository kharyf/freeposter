// Briefs: what an agent film waits as. A task for an agent holds a brief; an agent claims it under a time-limited
// lease and delivers a finished video file, which is checked here before the worker takes it on.
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Store } from "../db.ts";
import { probe } from "../media.ts";
import { hashFile } from "../review/media.ts";
import type { Look } from "./looks.ts";
import type { CampaignStore, CampaignTask } from "./store.ts";
import type { TaskChoices } from "./worker.ts";

/** A film is asked for this long before the video is due. */
export const BRIEF_LEAD_HOURS = 6;
export const LEASE_MINUTES = 120;
/** The time kept between a delivery and its post time for the review. */
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

type Leased = { ok: true; brief: Brief; leaseUntil: number } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });
const choicesOf = (t: CampaignTask) => t.choices as unknown as TaskChoices;
const iso = (ms: number) => new Date(ms).toISOString();

/** The brief for a task: the chosen words, the look, and when the film is needed by. */
export function buildBrief(store: Store, c: TaskChoices, look: Look, postAt: number | null, now: number): Brief {
  const instruction = c.instruction as { sec?: number | null; instructions?: string };
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
    deadline: postAt === null ? now + DAY : postAt - REVIEW_BUFFER_MINUTES * MIN,
    postAt,
  };
}

const leaseLive = (c: TaskChoices, now: number) => Boolean(c.lease && c.lease.until > now);

/** Briefs an agent could claim now: no lease, or one that has run out. */
export function openBriefs(cs: CampaignStore, now: number): CampaignTask[] {
  return cs.tasksIn(["awaiting_agent"]).filter((t) => {
    const c = choicesOf(t);
    return c.brief && !c.delivery && !leaseLive(c, now);
  });
}

/** Why a task can't be worked on, or null when it has an open brief. */
function refusal(cs: CampaignStore, t: CampaignTask | undefined, taskId: number): string | null {
  if (!t || t.state !== "awaiting_agent" || !choicesOf(t).brief || choicesOf(t).delivery) return `task ${taskId} has no open brief`;
  if (cs.killed() || !cs.campaign(t.campaignId)?.enabled) return "the campaign is stopped";
  return null;
}

function lease(cs: CampaignStore, t: CampaignTask, holder: string, now: number, offers: number): Leased {
  const brief = choicesOf(t).brief!;
  const until = Math.min(now + LEASE_MINUTES * MIN, brief.deadline);
  cs.updateTask(t.id, { choices: { ...t.choices, lease: { holder, until }, offers } });
  return { ok: true, brief, leaseUntil: until };
}

export function claimBrief(cs: CampaignStore, taskId: number, holder: string, now: number): Leased {
  const t = cs.task(taskId);
  const why = refusal(cs, t, taskId);
  if (why) return fail(why);
  const c = choicesOf(t!);
  if (leaseLive(c, now)) {
    if (c.lease!.holder !== holder) return fail(`claimed by ${c.lease!.holder} until ${iso(c.lease!.until)}`);
    return { ok: true, brief: c.brief!, leaseUntil: c.lease!.until };
  }
  if (c.brief!.deadline <= now) return fail(`the deadline for task ${taskId} has passed`);
  const offers = c.offers ?? 0;
  if (offers >= MAX_BRIEF_OFFERS) return fail(`no offers left for task ${taskId}`);
  return lease(cs, t!, holder, now, offers + 1);
}

/** The holder's lease runs another stretch, never past the brief's deadline. */
export function renewBrief(cs: CampaignStore, taskId: number, holder: string, now: number): Leased {
  const t = cs.task(taskId);
  const why = refusal(cs, t, taskId);
  if (why) return fail(why);
  const c = choicesOf(t!);
  if (!leaseLive(c, now) || c.lease!.holder !== holder) return fail(`you do not hold a lease on task ${taskId}`);
  return lease(cs, t!, holder, now, c.offers ?? 1);
}

export async function submitBrief(
  _store: Store, cs: CampaignStore, taskId: number, holder: string,
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

  const why = refusal(cs, t, taskId);
  if (why) return fail(why);
  const c = choicesOf(t);
  const brief = c.brief!;
  if (brief.deadline < now) return fail(`the deadline for task ${taskId} has passed`);
  if (!leaseLive(c, now)) return fail(`your lease on task ${taskId} has run out; claim it again`);
  if (c.lease!.holder !== holder) return fail(`claimed by ${c.lease!.holder} until ${iso(c.lease!.until)}`);

  for (const other of cs.tasksIn(["awaiting_agent", "editing", "reviewing", "scheduled", "posted", "kept"])) {
    if (other.id !== taskId && choicesOf(other).delivery?.hash === hash) return fail(`this file was already delivered for task ${other.id}`);
  }

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

  // The task may have moved on while the file was read.
  const fresh = cs.task(taskId);
  if (!fresh || choicesOf(fresh).delivery || choicesOf(fresh).lease?.holder !== holder) return fail(`task ${taskId} changed while the film was checked; try again`);
  const delivery: Delivery = {
    path, hash, durationSec: p.durationSec, manifest: input.manifest,
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    deliveredAt: now,
  };
  const { lease: _released, ...rest } = fresh.choices as Record<string, unknown>;
  cs.updateTask(taskId, { choices: { ...rest, delivery } });
  return { ok: true, repeat: false };
}

/** The holder stops: the task fails with the agent's reason. */
export function giveUpBrief(cs: CampaignStore, taskId: number, holder: string, reason: string): { ok: true } | { ok: false; error: string } {
  const t = cs.task(taskId);
  if (!t || t.state !== "awaiting_agent" || !choicesOf(t).brief) return fail(`task ${taskId} has no open brief`);
  const c = choicesOf(t);
  if (!c.lease || c.lease.holder !== holder) return fail(`you do not hold a lease on task ${taskId}`);
  cs.updateTask(taskId, { state: "failed", error: `the agent gave up: ${reason}` });
  return { ok: true };
}
