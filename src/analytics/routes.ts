// The Analytics tab's HTTP API: the scored videos with their label comparisons, one video's raw numbers, and the
// user's corrections to a video's labels.
import type { FastifyInstance } from "fastify";
import { todayUse } from "../ai/budget.ts";
import { CampaignStore } from "../campaigns/store.ts";
import type { Store } from "../db.ts";
import { styleById } from "../edit/styles.ts";
import { compareLabels, SCORE_AGES, scoreVideos, type LabelDimension, type ScoreAge } from "./score.ts";
import { AnalyticsStore } from "./store.ts";
import type { Source, VideoLabels } from "./types.ts";
import { labelNames, selectVideos } from "./view.ts";

const DIMENSIONS: LabelDimension[] = ["hook", "angle", "cta", "style", "type", "source"];
const intIn = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const ID_MAX = Number.MAX_SAFE_INTEGER;

export function registerAnalyticsRoutes(app: FastifyInstance, store: Store, now: () => number = Date.now) {
  const analytics = new AnalyticsStore(store);

  app.get("/api/analytics", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const bad = (error: string) => reply.code(400).send({ error });
    const accountId = q.account === undefined ? undefined : intIn(q.account, 1, ID_MAX);
    if (accountId === null) return bad("account must be an account id");
    const campaignId = q.campaign === undefined ? undefined : intIn(q.campaign, 1, ID_MAX);
    if (campaignId === null) return bad("campaign must be a campaign id");
    const days = q.days === undefined ? 30 : intIn(q.days, 1, 3650);
    if (days === null) return bad("days must be a whole number from 1 to 3650");
    if (q.source !== undefined && q.source !== "recorded" && q.source !== "generated") return bad("source must be recorded or generated");
    const age = (q.age ?? "72h") as ScoreAge;
    if (!SCORE_AGES.includes(age)) return bad(`age must be one of ${SCORE_AGES.join(", ")}`);

    const t = now();
    const { labels, shown, jobsOf, a } = selectVideos(store, { accountId, days, source: q.source as Source | undefined, campaignId }, t);
    const byPost = new Map(shown.map((s) => [s.postId, s]));
    const { entries, typeName, nameOf } = labelNames(store);
    const value = (id: number | null, text: string | null) => {
      if (id !== null) {
        const e = entries.get(id);
        return { id, text: e?.text ?? null, name: e?.name ?? null };
      }
      return text ? { id: null, text, name: null } : null;
    };

    const videos = labels.map((l) => {
      const s = byPost.get(l.postId);
      const mine = jobsOf.get(l.postId) ?? [];
      return {
        postId: l.postId,
        title: store.post(l.postId)?.title ?? "",
        source: l.source,
        styleId: l.styleId,
        hook: value(l.hookId, l.hookText), angle: value(l.angleId, l.angleText), cta: value(l.ctaId, l.ctaText),
        campaignId: l.campaignId,
        types: l.types.map((id) => ({ id, name: typeName.get(String(id)) ?? null })),
        labelledBy: l.labelledBy,
        scores: { overall: s?.overall ?? {}, perPlatform: s?.perPlatform ?? {}, provisional: s?.provisional ?? {} },
        platforms: mine.map((j) => ({ accountId: j.accountId, platform: j.platform, hasData: a.snapshots(j.id).length > 0 })),
        publishedAt: Math.min(...mine.map((j) => j.publishedAt ?? 0)),
      };
    }).sort((x, y) => y.publishedAt - x.publishedAt || y.postId - x.postId);

    const compare = Object.fromEntries(DIMENSIONS.map((dim) => [dim, compareLabels(shown, labels, dim, age).map((r) => ({
      key: r.key, name: nameOf(dim, r.key), median: r.median, lo: r.lo, hi: r.hi, n: r.n, enough: r.enough,
    }))]));

    // accounts whose metrics can't be read until the user signs in again
    const stuck = analytics.db.prepare("SELECT DISTINCT job_id FROM metric_poll WHERE done = 0 AND last_error = 'needs permission'").all() as { job_id: number }[];
    const seen = new Map<number, { accountId: number; name: string; platform: string }>();
    for (const { job_id } of stuck) {
      const acct = store.account(store.job(job_id)?.accountId ?? -1);
      if (acct && !seen.has(acct.id)) seen.set(acct.id, { accountId: acct.id, name: acct.name, platform: acct.platform });
    }

    return { age, videos, compare, needsPermission: [...seen.values()], ai: todayUse(store, t) };
  });

  app.get("/api/analytics/videos/:postId", async (req, reply) => {
    const postId = intIn((req.params as { postId: string }).postId, 1, ID_MAX);
    if (postId === null) return reply.code(400).send({ error: "postId must be a post id" });
    const post = store.post(postId);
    if (!post) return reply.code(404).send({ error: `no post ${postId}` });
    const jobs = analytics.scoredJobs();
    const labels = analytics.labels(postId);
    const score = labels
      ? scoreVideos({ labels: [labels], snapshotsByJob: new Map(jobs.map((j) => [j.id, analytics.snapshots(j.id)])), jobs, now: now() })[0]
      : undefined;
    return {
      postId,
      title: post.title,
      labels: labels ?? null,
      scores: { overall: score?.overall ?? {}, perPlatform: score?.perPlatform ?? {}, provisional: score?.provisional ?? {} },
      platforms: store.jobsForPost(postId).map((j) => {
        const snapshots = analytics.snapshots(j.id);
        return {
          jobId: j.id, accountId: j.accountId, platform: j.platform, state: j.state, url: j.resultUrl ?? null,
          snapshots: snapshots.map((s) => ({ ageSec: s.ageSec, takenAt: s.takenAt, views: s.reading.views, viewsKind: s.reading.viewsKind, raw: s.reading.raw })),
          retention: [...snapshots].reverse().find((s) => s.reading.retention)?.reading.retention ?? null,
        };
      }),
    };
  });

  app.put("/api/analytics/labels/:postId", async (req, reply) => {
    const bad = (error: string) => reply.code(400).send({ error });
    const postId = intIn((req.params as { postId: string }).postId, 1, ID_MAX);
    if (postId === null) return bad("postId must be a post id");
    if (!store.post(postId)) return reply.code(404).send({ error: `no post ${postId}` });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) return bad("expected an object");
    const cs = new CampaignStore(store);

    const l: VideoLabels = analytics.labels(postId) ?? {
      postId, source: "recorded", styleId: null, hookId: null, hookText: null, angleId: null, angleText: null, ctaId: null, ctaText: null,
      campaignId: null, campaignTaskId: null, types: [], labelledBy: "user",
    };
    if (body.source !== undefined) {
      if (body.source !== "recorded" && body.source !== "generated") return bad("source must be recorded or generated");
      l.source = body.source;
    }
    if (body.styleId !== undefined) {
      if (body.styleId !== null && (typeof body.styleId !== "string" || !styleById(store, body.styleId))) return bad(`no style "${String(body.styleId)}"`);
      l.styleId = body.styleId as string | null;
    }
    for (const kind of ["hook", "angle", "cta"] as const) {
      const idKey = `${kind}Id` as const, textKey = `${kind}Text` as const;
      if (body[textKey] !== undefined) {
        const text = body[textKey];
        if (text !== null && (typeof text !== "string" || text.length > 2000)) return bad(`${textKey} must be text of at most 2000 characters`);
        l[textKey] = (text as string | null)?.trim() || null;
        if (l[textKey] !== null && body[idKey] === undefined) l[idKey] = null;
      }
      if (body[idKey] !== undefined) {
        const id = body[idKey];
        if (id !== null) {
          if (!Number.isInteger(id)) return bad(`${idKey} must be a library entry id or null`);
          if (cs.entry(id as number)?.kind !== kind) return bad(`no ${kind} in the library with id ${id}`);
          if (body[textKey] === undefined) l[textKey] = null;
        }
        l[idKey] = id as number | null;
      }
    }
    if (body.types !== undefined) {
      const known = new Set(cs.types().map((t) => t.id));
      if (!Array.isArray(body.types) || body.types.some((t) => !Number.isInteger(t) || !known.has(t))) return bad("types must be a list of existing type ids");
      l.types = [...new Set(body.types as number[])];
    }
    l.labelledBy = "user";
    analytics.setLabels(l);
    return { labels: analytics.labels(postId) };
  });
}
