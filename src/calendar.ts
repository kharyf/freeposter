// The Calendar tab: every post going (or gone) out in a stretch of days, and what it goes out with: the editing
// style, the account set, whether it's RAW, and where each account's upload got to. Drive videos still on their way
// (downloading, being edited, in review) are shown at the time their name gave, before they become a post.
import { accountSets, setToken } from "./accounts.ts";
import type { Store } from "./db.ts";
import { styleById } from "./edit/styles.ts";
import type { DriveFileRecord, Job } from "./types.ts";

export interface CalendarEntry {
  /** "post:12" or "drive:<id>" */
  key: string;
  at: number;
  name: string;
  /** a Drive video, a post from this window, one an agent asked for… */
  source: "drive" | "window" | "review" | "legacy";
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

export function calendar(store: Store, from: number, to: number): CalendarEntry[] {
  const setName = (id: number | undefined) => {
    const set = accountSets(store).find((s) => s.id === id);
    return set ? setToken(set.name) : id === undefined ? null : "(deleted set)";
  };
  const fromDrive = (f: DriveFileRecord | undefined) => ({
    style: f?.choice?.styleId ? (styleById(f.choice.styleId)?.name ?? f.choice.styleId) : null,
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

  return [...posts, ...waiting].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
