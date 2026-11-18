// The two Analytics MCP tools: read-only, plain code (scores and label comparisons are the same ones the tab and the
// campaign rules use). get_analytics gives scores and comparisons, never raw snapshots; get_video_metrics gives one
// post's snapshots.
import type { Store } from "../db.ts";
import type { ToolDef } from "../produce/mcp-tools.ts";
import { compareLabels, SCORE_AGES, type LabelDimension, type ScoreAge } from "./score.ts";
import { AnalyticsStore } from "./store.ts";
import type { Source } from "./types.ts";
import { labelNames, selectVideos } from "./view.ts";

type Args = Record<string, unknown>;

const DIMENSIONS: LabelDimension[] = ["hook", "angle", "cta", "style", "type", "source"];
const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const roundAll = (o: Partial<Record<string, number>>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

export function analyticsTools(opts: { store: Store; fail: (message: string) => Error; now?: () => number }): ToolDef[] {
  const { store, fail } = opts;
  const now = opts.now ?? Date.now;
  const optInt = (args: Args, key: string, min: number, max: number): number | undefined => {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw fail(`${key} must be a whole number from ${min} to ${max}`);
    return v as number;
  };

  return [
    {
      name: "get_analytics",
      title: "Get analytics",
      description: "Published videos with their scores (percentile 0-100 against the account's own last 30 videos, at 24h, 72h and 7d; provisional until the baseline is big enough) and their labels, plus how each label value (hook, angle, CTA, style, type, source) compares: median score with a 90% interval and how many videos. Values with fewer than 3 videos have enough: false. Filter by account, recent days, source (recorded or generated) or campaign. Comparisons are at the age you choose (default 72h).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "integer", description: "Only videos posted to this account (list_accounts)." },
          days: { type: "integer", minimum: 1, maximum: 3650, description: "Only videos published in the last this many days." },
          source: { type: "string", enum: ["recorded", "generated"] },
          campaign_id: { type: "integer", description: "Only this campaign's videos (list_campaigns)." },
          age: { type: "string", enum: SCORE_AGES, default: "72h", description: "The age the label comparisons use." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const accountId = optInt(args, "account_id", 1, Number.MAX_SAFE_INTEGER);
        const days = optInt(args, "days", 1, 3650);
        const campaignId = optInt(args, "campaign_id", 1, Number.MAX_SAFE_INTEGER);
        const source = args.source;
        if (source !== undefined && source !== "recorded" && source !== "generated") throw fail("source must be recorded or generated");
        const age = (args.age ?? "72h") as ScoreAge;
        if (!SCORE_AGES.includes(age)) throw fail(`age must be one of ${SCORE_AGES.join(", ")}`);

        const t = now();
        const { labels, shown, jobsOf } = selectVideos(store, { accountId, days, source: source as Source | undefined, campaignId }, t);
        const byPost = new Map(shown.map((s) => [s.postId, s]));
        const { entryName, typeName, nameOf } = labelNames(store);
        const value = (id: number | null, text: string | null) => (id !== null ? { id, name: entryName.get(String(id)) ?? null } : text ? { text } : null);

        return {
          age,
          videos: labels.map((l) => {
            const s = byPost.get(l.postId);
            const mine = jobsOf.get(l.postId) ?? [];
            return {
              post_id: l.postId,
              published_at: iso(Math.min(...mine.map((j) => j.publishedAt ?? 0))),
              accounts: mine.map((j) => ({ account_id: j.accountId, platform: j.platform })),
              source: l.source, campaign_id: l.campaignId, style: l.styleId,
              hook: value(l.hookId, l.hookText), angle: value(l.angleId, l.angleText), cta: value(l.ctaId, l.ctaText),
              types: l.types.map((id) => ({ id, name: typeName.get(String(id)) ?? null })),
              score: roundAll(s?.overall ?? {}), provisional: s?.provisional ?? {},
              per_platform: Object.fromEntries(Object.entries(s?.perPlatform ?? {}).map(([p, v]) => [p, roundAll(v ?? {})])),
            };
          }),
          comparisons: Object.fromEntries(DIMENSIONS.map((dim) => [dim, compareLabels(shown, labels, dim, age).map((r) => ({
            key: r.key, name: nameOf(dim, r.key), median: round(r.median), lo: round(r.lo), hi: round(r.hi), n: r.n, enough: r.enough,
          }))])),
        };
      },
    },
    {
      name: "get_video_metrics",
      title: "Get one video's metrics",
      description: "One post's raw metric snapshots for each account it went to (views, or impressions on X; every other number the platform gave; retention when there is one), by age after publishing, and its labels.",
      inputSchema: {
        type: "object",
        properties: { post_id: { type: "integer", description: "A post id from get_analytics or list_posts." } },
        required: ["post_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const postId = args.post_id;
        if (!Number.isInteger(postId)) throw fail("post_id must be a whole number");
        if (!store.post(postId as number)) throw fail(`no post ${postId}; get_analytics lists the published ones`);
        const a = new AnalyticsStore(store);
        const published = new Map(a.scoredJobs().map((j) => [j.id, j.publishedAt]));
        return {
          post_id: postId,
          labels: a.labels(postId as number) ?? null,
          jobs: store.jobsForPost(postId as number).map((j) => ({
            job_id: j.id, account_id: j.accountId, platform: j.platform, state: j.state, url: j.resultUrl,
            published_at: iso(published.get(j.id)),
            snapshots: a.snapshots(j.id).map((s) => ({
              age_sec: s.ageSec, taken_at: iso(s.takenAt), views: s.reading.views, views_kind: s.reading.viewsKind, raw: s.reading.raw,
              ...(s.reading.retention ? { retention: s.reading.retention } : {}),
            })),
          })),
        };
      },
    },
  ];
}
