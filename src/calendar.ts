// The Calendar tab: every post going (or gone) out in a stretch of days, and what it goes out with: the editing
// style, the account set, whether it's RAW, and where each account's upload got to. Drive videos still on their way
// (downloading, being edited, in review) are shown at the time their name gave, before they become a post.
// A running campaign's plan is shown too: each line's videos on the days still to come at their time ("planned"),
// and the videos it is making now, until they become a post.
import { accountSets, setToken } from "./accounts.ts";
import { lookByKey } from "./campaigns/looks.ts";
import { ROW_INSTRUCTION_BASE } from "./campaigns/rows.ts";
import { DAYS, type MakeInstruction, type PostInstruction } from "./campaigns/spec.ts";
import type { CampaignStore, TaskState } from "./campaigns/store.ts";
import { dayKey, lineTime, localAt } from "./campaigns/time.ts";
import type { Store } from "./db.ts";
import { styleById } from "./edit/styles.ts";
import type { DriveFileRecord, Job } from "./types.ts";

export interface CalendarEntry {
  /** "post:12", "drive:<id>", "task:<id>" (a campaign video being made) or "plan:<campaign>:<day>:<instruction>:<copy>" */
  key: string;
  at: number;
  name: string;
  /** a Drive video, a post from this window, one an agent asked for, a campaign's video not yet a post… */
  source: "drive" | "window" | "review" | "legacy" | "campaign";
  /** the campaign of a "campaign" entry */
  campaign?: { id: number; name: string };
  /** null: not a Drive video, so no style (or RAW: not edited) */
  style: string | null;
  /** null when the post didn't come from a set (made in the window, or by an agent) */
  set: string | null;
  raw: boolean;
  /** in plain words: "waiting for review", "scheduled", "posted", "failed"… */
  status: string;
  /** true once it can't go out any more (rejected, cancelled, failed everywhere) */
  stopped: boolean;
  accounts: { platform: string; name: string; state: string; url: string | null }[];
  note: string | null;
}

const DRIVE_STATUS: Partial<Record<DriveFileRecord["state"], string>> = {
  queued: "arriving",
  downloading: "downloading",
  transcribing: "transcribing",
  processing: "being edited",
  reviewing: "waiting for your review",
  held: "held for its campaign",
  unreviewed: "review ended undecided",
  edit_failed: "edit failed",
  failed: "failed",
  rejected: "rejected",
  invalid: "refused",
  late: "too late to post",
  cancelled: "cancelled",
};
const STOPPED = new Set<DriveFileRecord["state"]>(["rejected", "invalid", "late", "cancelled", "failed", "edit_failed"]);

/**
 * Where a post's uploads got to, judged only against the accounts it was actually sent to (accounts its set
 * skipped at scheduling never get a job, so they don't count). "posting" covers a post that has started going out
 * (one account running or done) while others are still on their way; it settles once every account is finished.
 */
export type PostOutcome = "scheduled" | "posting" | "posted" | "partial" | "failed";

export function postOutcome(jobs: Pick<Job, "state">[]): PostOutcome | null {
  if (!jobs.length) return null;
  const states = jobs.map((j) => j.state);
  const done = (s: string) => s === "published" || s === "failed";
  if (states.every((s) => s === "published")) return "posted";
  if (states.every((s) => s === "failed")) return "failed";
  if (states.every(done)) return "partial";
  if (states.some((s) => s === "running" || s === "published")) return "posting";
  return "scheduled";
}

function postStatus(jobs: Job[], captionPending: boolean): { status: string; stopped: boolean } {
  switch (postOutcome(jobs)) {
    case null: return { status: "nothing to post to", stopped: true };
    case "posted": return { status: "posted", stopped: false };
    case "failed": return { status: "not posted", stopped: true };
    case "partial": return { status: "partially posted", stopped: false };
    case "posting": return { status: "posting…", stopped: false };
    default: return { status: captionPending ? "waiting for its caption" : "scheduled", stopped: false };
  }
}

const TASK_STATUS: Partial<Record<TaskState, string>> = {
  queued: "waiting to be made",
  awaiting_agent: "waiting for an agent to make it",
  scripting: "script being written",
  rendering: "being made",
  editing: "being edited",
  reviewing: "waiting for your review",
};

const setNameOf = (store: Store, id: number | null | undefined) => {
  const set = accountSets(store).find((s) => s.id === id);
  return set ? setToken(set.name) : id === undefined || id === null ? null : "(deleted set)";
};

function lineStyle(store: Store, ins: MakeInstruction | PostInstruction): string | null {
  if (ins.kind === "make" && ins.look) return lookByKey(store, ins.look)?.name ?? ins.look;
  return ins.style ? (styleById(store, ins.style)?.name ?? ins.style) : null;
}

function lineName(ins: MakeInstruction | PostInstruction): string {
  if (ins.kind === "post") return ins.name;
  const first = ins.instructions?.split("\n")[0].trim() ?? "";
  return first ? (first.length > 60 ? `${first.slice(0, 59)}…` : first) : "New video";
}

/** "HH:MM" a line's copy posts at, or null when it makes a video to keep (or has no time to post at). */

/**
 * Each running campaign's videos in [from, to) that aren't a post yet: those being made (at the time they're meant
 * to post), and on the days still to come, each line's videos at their time ("planned"). Their real time can still
 * move: a review approved late, or a day at the campaign's cap, puts a post later.
 */
export function campaignPlan(store: Store, cs: CampaignStore, from: number, to: number, now = Date.now()): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  const killed = cs.killed();
  for (const c of cs.campaigns()) {
    if (!cs.isRunnable(c) || !c.compiled) continue;
    const base = { source: "campaign" as const, campaign: { id: c.id, name: c.name }, set: setNameOf(store, c.accountSetId), raw: false, stopped: false, accounts: [] };
    // Being made: a video that will post, until its review makes it a post (that post is shown instead).
    const making = store.db
      .prepare("SELECT id FROM campaign_tasks WHERE campaign_id = ? AND post_id IS NULL AND state IN ('queued', 'awaiting_agent', 'scripting', 'rendering', 'editing', 'reviewing')")
      .all(c.id) as { id: number }[];
    for (const { id } of making) {
      const t = cs.task(id)!;
      const ch = t.choices as { postTime?: string | null; instruction?: MakeInstruction | PostInstruction; driveId?: string };
      if (typeof ch.postTime !== "string" || !ch.instruction) continue;
      // A held Drive file with a time of its own is on the calendar already.
      if (ch.driveId && store.driveFile(ch.driveId)?.scheduledAt) continue;
      const at = localAt(t.date, ch.postTime);
      if (at < from || at >= to) continue;
      out.push({
        ...base, key: `task:${t.id}`, at, name: lineName(ch.instruction), style: lineStyle(store, ch.instruction),
        status: TASK_STATUS[t.state] ?? t.state, note: `Being made by campaign ${c.name}.`,
      });
    }
    // Planned: the days still to come. Today's lines become tasks within seconds, so today counts only those not made
    // yet. Nothing is planned while the kill switch is on: no campaign starts anything new until it's resumed.
    if (killed) continue;
    const first = new Date(Math.max(from, now));
    for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d.getTime() < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const key = dayKey(d.getTime());
      const made = new Set(cs.tasksOn(c.id, key).map((t) => `${t.instructionIndex}:${t.copy}`));
      (c.compiled.days[DAYS[d.getDay()]] ?? []).forEach((ins, index) => {
        if (ins.kind === "make" && ins.look) {
          const look = lookByKey(store, ins.look);
          if (!look || look.hidden) return; // the worker doesn't run it either
        }
        const instructionIndex = ins.row !== undefined ? ROW_INSTRUCTION_BASE + ins.row : index;
        for (let copy = 0; copy < (ins.kind === "make" ? ins.count : 1); copy++) {
          if (made.has(`${instructionIndex}:${copy}`)) continue;
          const hhmm = lineTime(ins, copy, c.defaultPostTimes);
          if (!hhmm) continue;
          const at = localAt(key, hhmm);
          if (at < from || at >= to || at < now) continue;
          out.push({
            ...base, key: `plan:${c.id}:${key}:${instructionIndex}:${copy}`, at, name: lineName(ins), style: lineStyle(store, ins),
            status: "planned", note: `Planned by campaign ${c.name}. It's made on its day and waits for your review, so it can post later than this.`,
          });
        }
      });
    }
  }
  return out;
}

export function calendar(store: Store, from: number, to: number, cs?: CampaignStore, now = Date.now()): CalendarEntry[] {
  const setName = (id: number | undefined) => setNameOf(store, id);
  const fromDrive = (f: DriveFileRecord | undefined) => ({
    style: f?.choice?.styleId ? (styleById(store, f.choice.styleId)?.name ?? f.choice.styleId) : null,
    set: f?.choice ? setName(f.choice.setId) : null,
    raw: f?.choice?.raw ?? false,
  });

  const posts: CalendarEntry[] = store.postsBetween(from, to).map(({ post, jobs }) => {
    // An approved Drive video's post is made by its review, so the Drive file is what says where it came from.
    const f = store.driveFileForPost(post.id);
    const { status, stopped } = postStatus(jobs, Boolean(post.captionTopic));
    return {
      key: `post:${post.id}`,
      at: post.scheduledAt ?? post.createdAt,
      name: f?.choice?.name ?? (post.title || post.caption.split("\n")[0] || `Post ${post.id}`),
      source: f ? "drive" : (post.origin ?? "legacy"),
      ...fromDrive(f),
      status,
      stopped,
      accounts: jobs.map((j) => ({ platform: j.platform, name: store.account(j.accountId)?.name ?? "(disconnected)", state: j.state, url: j.resultUrl })),
      note: f?.note ?? null,
    };
  });

  const waiting: CalendarEntry[] = store.driveFilesBetween(from, to).map((f) => ({
    key: `drive:${f.driveId}`,
    at: f.scheduledAt!,
    name: f.choice?.name ?? f.name,
    source: "drive",
    ...fromDrive(f),
    status: DRIVE_STATUS[f.state] ?? f.state,
    stopped: STOPPED.has(f.state),
    accounts: [],
    note: f.note,
  }));

  const planned = cs ? campaignPlan(store, cs, from, to, now) : [];
  return [...posts, ...waiting, ...planned].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
