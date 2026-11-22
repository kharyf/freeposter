// A row's new post time reaches the videos it already started: those still being made take the new time when they're
// placed (a brief still open is asked for the new slot), and a placed post that hasn't started going out moves to the
// new time on the day it was placed on. A slot already missed is made again by the worker (materialize), not here.
import type { Store } from "../db.ts";
import { REVIEW_BUFFER_MINUTES } from "./briefs.ts";
import { ROW_INSTRUCTION_BASE, type Row } from "./rows.ts";
import { dayKey, localAt } from "./time.ts";

/** States of a task whose video hasn't gone out yet. */
const OPEN = ["queued", "awaiting_agent", "scripting", "rendering", "editing", "reviewing", "scheduled"];
const minute = (ms: number) => Math.floor(ms / 60_000);

/**
 * Applies the time changes between a campaign's table before and after a save. A row that stops posting (no time)
 * or is removed leaves its videos as they are; so does a placed post whose new time has already passed today, or
 * one with an account already posting. Returns how many posts moved.
 */
export function retimeRows(store: Store, campaignId: number, before: Row[], after: Row[], now = Date.now()): number {
  const was = new Map(before.map((r) => [r.id, r.time]));
  let moved = 0;
  for (const r of after) {
    const old = was.get(r.id);
    if (old === undefined || old === null || r.time === null || old === r.time) continue;
    const tasks = store.db
      .prepare(`SELECT id, date, state, choices, post_id AS postId FROM campaign_tasks
                WHERE campaign_id = ? AND instruction_index = ? AND state IN (${OPEN.map(() => "?").join(",")})`)
      .all(campaignId, ROW_INSTRUCTION_BASE + r.id, ...OPEN) as { id: number; date: string; state: string; choices: string; postId: number | null }[];
    for (const t of tasks) {
      const choices = JSON.parse(t.choices) as {
        postTime?: string | null; instruction?: { kind: string; post?: { at: string } | null; at?: string | null; scripted?: boolean };
        brief?: { postAt: number | null; deadline: number }; lease?: { until: number };
      };
      if (typeof choices.postTime !== "string") continue; // a video made to keep
      choices.postTime = r.time;
      const ins = choices.instruction;
      if (ins?.kind === "make" && ins.post) ins.post.at = r.time;
      else if (ins?.kind === "post") ins.at = r.time;
      // A brief still open is asked for the new slot: an Agent row's film is due REVIEW_BUFFER_MINUTES before it (a
      // lease never outlasting that); a Create row's Lemo film stays due within a day, as buildBrief made it.
      if (t.state === "awaiting_agent" && choices.brief) {
        const postAt = localAt(t.date, r.time);
        choices.brief.postAt = ins?.scripted === true && postAt <= now ? null : postAt;
        if (ins?.scripted !== true) {
          choices.brief.deadline = postAt - REVIEW_BUFFER_MINUTES * 60_000;
          if (choices.lease && choices.lease.until > choices.brief.deadline) choices.lease.until = choices.brief.deadline;
        }
      }
      store.db.prepare("UPDATE campaign_tasks SET choices = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(choices), now, t.id);
      if (t.state !== "scheduled" || t.postId === null) continue;
      const post = store.post(t.postId);
      if (!post) continue;
      let at = localAt(dayKey(post.scheduledAt ?? localAt(t.date, old)), r.time);
      if (at <= now) continue;
      // As when it was placed: a minute another campaign post has taken moves it on a minute.
      const taken = new Set((store.db
        .prepare(`SELECT COALESCE(p.scheduled_at, p.created_at) AS at FROM campaign_tasks c
                  JOIN posts p ON p.id = c.post_id AND p.review_id = c.review_id
                  WHERE c.state IN ('scheduled', 'posted') AND p.id != ?`)
        .all(t.postId) as { at: number }[]).map((x) => minute(x.at)));
      while (taken.has(minute(at))) at += 60_000;
      if (store.movePost(t.postId, at)) moved++;
    }
  }
  return moved;
}
