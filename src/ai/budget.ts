// The daily ceiling on the AI jobs campaigns add, so normal captioning can never starve a campaign (or the reverse).
import type { Store } from "../db.ts";

export const BUDGETED_JOBS = ["campaign", "script", "label"] as const;

export interface Use { calls: number; tokens: number }

const ALL_JOBS = ["caption", "frames", "lyrics", "graphics", "campaign", "script", "label"];

export class OverBudget extends Error {
  constructor(message = "today's AI budget for campaigns and labels is used up; it resets at midnight") {
    super(message);
    this.name = "OverBudget";
  }
}

export function isBudgeted(job: string): boolean {
  return (BUDGETED_JOBS as readonly string[]).includes(job);
}

/** The ceilings (prefs `ai.budget.calls` and `ai.budget.tokens`). */
export function budget(store: Store): Use {
  const calls = store.pref<number>("ai.budget.calls");
  const tokens = store.pref<number>("ai.budget.tokens");
  return { calls: typeof calls === "number" ? calls : 50, tokens: typeof tokens === "number" ? tokens : 200_000 };
}

/** Today's use (since local midnight): the budgeted jobs, and every job. */
export function todayUse(store: Store, now = Date.now()): { budgeted: Use; all: Use } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const from = midnight.getTime();
  return { budgeted: store.aiUsageSince(from, [...BUDGETED_JOBS]), all: store.aiUsageSince(from, ALL_JOBS) };
}

/** Throws OverBudget when the job is budgeted and either ceiling is reached today. */
export function checkBudget(store: Store, job: string, now = Date.now()) {
  if (!isBudgeted(job)) return;
  const max = budget(store);
  const used = todayUse(store, now).budgeted;
  if (used.calls >= max.calls || used.tokens >= max.tokens) {
    throw new OverBudget(`today's AI budget for campaigns and labels is used up (${used.calls} of ${max.calls} calls, ${used.tokens} of ${max.tokens} tokens); it resets at midnight`);
  }
}
