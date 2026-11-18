// How campaigns look to callers (the MCP tools and the Campaigns tab's routes): one place for the summary shape.
import { CampaignStore, type Campaign } from "./store.ts";

export const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** The snake_case summary agents get. */
export const campaignBrief = (cs: CampaignStore, c: Campaign) => ({
  id: c.id, name: c.name, enabled: c.enabled, autorun: c.autorun, runnable: cs.isRunnable(c), daily_post_cap: c.dailyPostCap,
  confirmed_at: iso(c.confirmedAt),
});
