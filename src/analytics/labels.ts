// Hook / angle / CTA labels for videos the user recorded, mostly from plain code on the transcript the edit already
// made. One `label` AI call at most, only to place a video whose words match none of the library's angles.
import { existsSync, readFileSync } from "node:fs";
import type { AiService } from "../ai/router.ts";
import { CampaignStore, type LibraryEntry } from "../campaigns/store.ts";
import type { Store } from "../db.ts";
import type { Transcript } from "../edit/transcribe.ts";
import { AnalyticsStore } from "./store.ts";
import type { VideoLabels } from "./types.ts";

export interface LabelDeps { store: Store; ai: AiService | null }

const words = (t: Transcript) => t.words.map((w) => w.text.trim()).filter(Boolean);

/** What is said in the first few seconds. */
export function hookFromTranscript(t: Transcript, sec = 3): string {
  return t.words.filter((w) => w.start < sec).map((w) => w.text.trim()).filter(Boolean).join(" ");
}

const CTA_RE = /https?:\/\/|\b[\w-]+\.(com|net|org|io|co|app|link|me|ai|shop)\b|\b(click|tap|go to|visit|link in|head to)\b/i;

/** The closing sentence, when it asks the viewer to do something. */
export function ctaFromTranscript(t: Transcript): string | null {
  const text = words(t).join(" ");
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1];
  return last && CTA_RE.test(last) ? last : null;
}

const escape = (s: string) => [...s].map((c) => (".*+?^$|(){}[]\\".includes(c) ? "\\" + c : c)).join("");

/** The angle whose keywords occur most (whole words); null when none do or two are level. */
export function matchAngle(text: string, angles: LibraryEntry[]): number | null {
  const scored = angles.map((a) => ({
    id: a.id,
    hits: a.keywords.reduce((n, k) => {
      const kw = k.trim();
      return kw ? n + (text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escape(kw)}(?![\\p{L}\\p{N}])`, "giu"))?.length ?? 0) : n;
    }, 0),
  })).filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);
  if (!scored.length || (scored.length > 1 && scored[1].hits === scored[0].hits)) return null;
  return scored[0].id;
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean));

/** The library hook whose words overlap the spoken hook the most (Jaccard of at least 0.6). */
export function matchHook(text: string, hooks: LibraryEntry[]): number | null {
  const a = tokens(text);
  if (!a.size) return null;
  let best: { id: number; j: number } | null = null;
  for (const h of hooks) {
    const b = tokens(h.text);
    const common = [...a].filter((w) => b.has(w)).length;
    const j = common / (a.size + b.size - common);
    if (j >= 0.6 && (!best || j > best.j)) best = { id: h.id, j };
  }
  return best?.id ?? null;
}

const ANGLE_SCHEMA = {
  type: "object",
  properties: { angleId: { type: ["integer", "null"] }, description: { type: "string" } },
  required: ["angleId", "description"],
  additionalProperties: false,
};

/** Labels a recorded video from what is said in it. */
export async function labelRecorded(deps: LabelDeps, postId: number, transcript: Transcript, styleId: string | null): Promise<VideoLabels> {
  const lib = new CampaignStore(deps.store);
  const spoken = words(transcript).join(" ");
  const hookText = hookFromTranscript(transcript) || null;
  const ctaText = ctaFromTranscript(transcript);
  const angles = lib.entries("angle");
  const ctaLow = ctaText?.toLowerCase() ?? "";
  const cta = ctaText ? lib.entries("cta").find((c) => (c.url && ctaLow.includes(c.url.toLowerCase())) || (c.text && ctaLow.includes(c.text.toLowerCase()))) : undefined;
  const labels: VideoLabels = {
    postId, source: "recorded", styleId,
    hookId: hookText ? matchHook(hookText, lib.entries("hook")) : null, hookText,
    angleId: matchAngle(spoken, angles), angleText: null,
    ctaId: cta?.id ?? null, ctaText,
    campaignId: null, campaignTaskId: null, types: [], labelledBy: "transcript",
  };
  if (labels.angleId === null && angles.length && deps.ai && spoken) {
    try {
      const a = await deps.ai.ask<{ angleId: number | null; description: string }>("label", {
        system: "You place a short video in the creator's list of angles (the main idea it sells). Answer with the id of the closest angle, or null when none fits, and a one-line description of the video's angle.",
        prompt: `Angles:\n${angles.map((x) => `${x.id}: ${x.name} - ${x.text}`).join("\n")}\n\nTranscript:\n${spoken.slice(0, 3000)}`,
        schema: ANGLE_SCHEMA,
      });
      const known = a.angleId === null || angles.some((x) => x.id === a.angleId);
      if (known && typeof a.description === "string") {
        labels.angleId = a.angleId;
        labels.angleText = a.description.trim() || null;
        if (a.angleId !== null || labels.angleText) labels.labelledBy = "ai";
      }
    } catch (err) {
      console.error(`labels: angle for post ${postId} left empty: ${(err as Error).message}`);
    }
  }
  if (labels.angleId !== null && !labels.angleText) labels.angleText = angles.find((x) => x.id === labels.angleId)?.text ?? null;
  return labels;
}

const started = new Set<number>();

/**
 * When a job is published: label its post once (campaign videos already have theirs). Never throws, so it can't
 * disturb publishing.
 */
export async function labelOnPublish(deps: LabelDeps, jobId: number): Promise<void> {
  let postId: number | undefined;
  try {
    const job = deps.store.job(jobId);
    if (!job) return;
    if (job.postId === null) return;
    postId = job.postId;
    const analytics = new AnalyticsStore(deps.store);
    if (started.has(postId) || analytics.labels(postId)) return;
    started.add(postId);
    const post = deps.store.post(postId);
    const styleId = deps.store.driveFileForPost(postId)?.choice?.styleId ?? null;
    const path = post?.editId ? deps.store.edit(post.editId)?.transcriptPath : null;
    const transcript: Transcript | null = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    const labels = transcript
      ? await labelRecorded(deps, postId, transcript, styleId)
      : { postId, source: "recorded", styleId, hookId: null, hookText: null, angleId: null, angleText: null, ctaId: null, ctaText: null, campaignId: null, campaignTaskId: null, types: [], labelledBy: "transcript" } as VideoLabels;
    // A campaign may have labelled the post while the AI was thinking; its labels win.
    if (!analytics.labels(postId)) analytics.setLabels(labels);
  } catch (err) {
    console.error(`labels: job ${jobId}: ${(err as Error).message}`);
  } finally {
    if (postId !== undefined) started.delete(postId);
  }
}
