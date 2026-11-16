// The six MCP tools for productions. They sit beside the posting tools in mcp.ts and share its conventions:
// stateless, every call returns at once, slow work happens in the ProductionWorker. The one exception is
// transcribe_media, which waits for Whisper the first time a file is asked about (it's cached after that).
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Store } from "../db.ts";
import { whisperHealth } from "../edit/transcribe.ts";
import type { Publisher } from "../platforms/base.ts";
import type { Platform } from "../types.ts";
import { blenderTemplates } from "./adapters/blender.ts";
import { sfxLibrary } from "./sfx.ts";
import { LIMITS, SHOT_KINDS, SpecError, toWindowsPath } from "./spec.ts";
import { REMOTION_VERSION } from "./tools.ts";
import type { Production } from "./store.ts";
import { previewUrl, thumbUrl, type ProductionWorker } from "./worker.ts";

type Args = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run(args: Args): Promise<unknown>;
}

export const PRODUCTION_INSTRUCTIONS = `Productions make a new video from several shots: HyperFrames (HTML compositions rendered to video), Remotion (React components rendered to video), WanGP (AI video from a prompt, optionally from a start image), Blender (3D templates filled with params), existing files, and talking-head edits. Call describe_production_tools first for what is installed, the Blender templates and their params, and the sound-effects library. transcribe_media runs Whisper on a voiceover or clip and returns each word's start and end, so animation can land on the words. start_production takes one spec and returns at once; FreePoster renders, assembles and makes a preview in the background, and logs production.ready when it is (wait_for_events, or call get_production). Show the user the preview (preview_url) before anything is posted. To post it, call request_review with its production_id: the user approves, rejects or asks for a redo on the review itself, never in chat. revise_production changes shots and re-renders only those; after a redo, revise it and the new revision comes back for review.`;

/** A ToolError's message goes back to the model as an isError result. */
export function productionTools(opts: {
  producer: () => ProductionWorker | undefined;
  store: Store;
  publishers: Record<Platform, Publisher>;
  /** where the user reviews: Telegram (paired or not) and the window */
  reviewChannel: () => Record<string, unknown>;
  fail: (message: string) => Error;
}): ToolDef[] {
  const { fail } = opts;
  const worker = () => {
    const w = opts.producer();
    if (!w) throw fail("productions aren't available in this FreePoster");
    return w;
  };
  const id = (args: Args, key = "production_id") => {
    const v = args[key];
    if (!Number.isInteger(v)) throw fail(`${key} must be a whole number`);
    return v as number;
  };
  const production = (pid: number) => {
    const p = worker().productions.get(pid);
    if (!p) throw fail(`no production ${pid}; get_production with no id lists the recent ones`);
    return p;
  };
  const specError = (err: unknown) => (err instanceof SpecError ? fail(err.message) : err instanceof Error ? fail(err.message) : err);

  const view = (p: Production) => {
    const shots = worker().productions.shots(p.id);
    const sec = p.durationSec;
    const fits = sec === null ? [] : opts.store.accounts().map((a) => ({
      account_id: a.id, platform: a.platform, name: a.name,
      fits: sec <= opts.publishers[a.platform].maxDurationSec(a) + 0.05 && sec >= opts.publishers[a.platform].minDurationSec,
    }));
    const hasPreview = p.state === "ready" || p.state === "approved";
    return {
      id: p.id, title: p.spec.title, state: p.state, revision: p.revision, progress: Math.round(p.progress * 100) / 100, error: p.error,
      duration_sec: sec, preview_url: hasPreview ? previewUrl(p.id) : null, thumb_url: hasPreview ? thumbUrl(p.id) : null,
      approved: Boolean(p.approvedAt), post_id: p.postId, accounts: fits, post_defaults: p.spec.post,
      shots: shots.map((s) => ({ id: s.shotId, kind: s.kind, state: s.state, attempts: s.attempts, progress: s.progress, error: s.error })),
    };
  };

  return [
    {
      name: "describe_production_tools",
      title: "Describe production tools",
      description: "What productions can use right now: each shot kind and whether its tool is installed and working, the Blender templates with their params, the sound-effects library's names, the spec's limits, the HyperFrames composition rules, and whether the user lets the agent approve. Call this before writing a spec.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        const w = worker();
        const kinds = await Promise.all(SHOT_KINDS.map(async (k) => ({ kind: k, lane: w.adapters[k].lane, ...(await w.adapters[k].health()) })));
        const templates = Object.fromEntries(Object.entries(blenderTemplates()).map(([n, t]) => [n, { description: t.description, params: t.params }]));
        return {
          shot_kinds: kinds,
          blender_templates: templates,
          sfx: sfxLibrary().map((s) => s.name),
          limits: { shots: `1 to ${LIMITS.maxShots}`, generated_shot_sec: `${LIMITS.minShotSec} to ${LIMITS.maxShotSec}`, html_kb: LIMITS.maxHtmlBytes / 1024, crossfade_sec: `0.1 to ${LIMITS.maxCrossfadeSec}` },
          output: "1080x1920, 30 fps",
          remotion_rules: `Remotion ${REMOTION_VERSION} with React 19. tsx is one file whose default export is the shot's React component; FreePoster registers it as a 1080x1920, 30 fps composition lasting duration_sec and passes props to it. Import only from "remotion" and "react" (useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, AbsoluteFill, Img, Audio, OffthreadVideo, staticFile). Each file in assets is served by its file name: staticFile("logo.png"). Shot audio is dropped at assembly; use the spec's voiceover and sfx.`,
          whisper: await whisperHealth(),
          hyperframes_rules: "One self-contained HTML page. The root element carries data-composition-id, data-width=\"1080\", data-height=\"1920\" and data-duration equal to the shot's duration_sec; each animated element carries class=\"clip\" with data-start, data-duration and data-track-index; register a paused GSAP timeline as window.__timelines[\"<composition id>\"]. Each file in assets sits beside the page under its file name: <img src=\"logo.png\">. Renders use --strict, so lint errors fail the shot with HyperFrames's own message.",
          review: { ...opts.reviewChannel(), how: "request_review with production_id; only the user's tap on Approve posts it" },
        };
      },
    },
    {
      name: "start_production",
      title: "Start a production",
      description: "Starts rendering a video from a spec: {title?, shots: [...], transitions?, audio?: {voiceover}, sfx?: [{name, at_sec, gain_db}], captions?: {source: \"voiceover\"|\"none\"}, post?: {account_ids, caption, title, schedule_at, tiktok}}. Shot kinds: hyperframes {id, duration_sec, html, assets?}; remotion {id, duration_sec, tsx, props?, assets?}; wan {id, duration_sec, prompt, negative_prompt?, image?, seed?}; blender {id, duration_sec, template, params, engine?}; file {id, path, trim?}; edit {id, path, settings?}. Paths are absolute paths on this computer. Every problem in the spec is reported at once. Returns the production id at once; follow with get_production or wait_for_events. dry_run only checks the spec.",
      inputSchema: {
        type: "object",
        properties: { spec: { type: "object", description: "The production spec." }, dry_run: { type: "boolean", default: false } },
        required: ["spec"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const w = worker();
        try {
          if (args.dry_run === true) return { ok: true, dry_run: true, spec: w.check(args.spec) };
          const p = await w.create(args.spec);
          return { ...view(p), next: "FreePoster is rendering it. Wait for production.ready with wait_for_events, or call get_production; then show the user the preview." };
        } catch (err) {
          throw specError(err);
        }
      },
    },
    {
      name: "get_production",
      title: "Get a production",
      description: "A production's state (queued, rendering, assembling, ready, approved, failed, cancelled), each shot's state and error, its length, which accounts that length fits, and preview_url / thumb_url once ready. With no production_id, the 20 most recent.",
      inputSchema: { type: "object", properties: { production_id: { type: "integer" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        if (args.production_id === undefined) return { productions: worker().productions.recent(20).map(view) };
        return view(production(id(args)));
      },
    },
    {
      name: "revise_production",
      title: "Revise a production",
      description: "Changes a production that isn't approved: either shots (replacement shots, matched by id; a new id is added at the end) or a whole new spec. Only new or changed shots render again, then it re-assembles. Returns the new revision and which shots will render.",
      inputSchema: {
        type: "object",
        properties: {
          production_id: { type: "integer" },
          shots: { type: "array", items: { type: "object" }, description: "Replacement shots, by id." },
          spec: { type: "object", description: "A whole new spec instead." },
        },
        required: ["production_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const p = production(id(args));
        let next: unknown = args.spec;
        if (next === undefined) {
          if (!Array.isArray(args.shots) || !args.shots.length) throw fail("give shots (replacements by id) or a whole spec");
          const replacements = new Map((args.shots as Args[]).map((s) => [s.id, s]));
          const shots: unknown[] = p.spec.shots.map((s) => replacements.get(s.id) ?? s);
          for (const s of args.shots as Args[]) if (!p.spec.shots.some((o) => o.id === s.id)) shots.push(s);
          next = { ...p.spec, shots };
        }
        try {
          return { production_id: p.id, ...(await worker().revise(p.id, next)) };
        } catch (err) {
          throw specError(err);
        }
      },
    },
    {
      name: "transcribe_media",
      title: "Transcribe media",
      description: "Runs Whisper (whisper.cpp, on this computer) on an audio or video file and returns the words spoken, each with start and end in seconds. Use it to time a HyperFrames or Remotion shot to a voiceover: pass the words in as props, or place each animation at a word's start. Sound tags and sung lyrics are left out. The first call on a file takes about as long as the file plays; later calls are instant.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path of the audio or video file on this computer." } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        if (typeof args.path !== "string" || !args.path.trim()) throw fail("path is required");
        const path = toWindowsPath(args.path);
        if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isFile()) throw fail(`no file at ${path}; give an absolute path on this computer`);
        try {
          const t = await worker().transcribeFile(path);
          const round = (n: number) => Math.round(n * 1000) / 1000;
          return {
            path, language: t.language, text: t.words.map((w) => w.text).join(" "),
            duration_sec: t.words.length ? round(t.words.at(-1)!.end) : 0,
            words: t.words.map((w) => ({ text: w.text, start: round(w.start), end: round(w.end) })),
          };
        } catch (err) {
          throw fail((err as Error).message);
        }
      },
    },
    {
      name: "cancel_production",
      title: "Cancel a production",
      description: "Stops a production that isn't approved; any tool rendering for it is stopped.",
      inputSchema: { type: "object", properties: { production_id: { type: "integer" } }, required: ["production_id"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(args) {
        const p = production(id(args));
        if (!worker().cancel(p.id)) throw fail(`production ${p.id} is ${p.state} and can't be cancelled`);
        return view(production(p.id));
      },
    },
  ];
}
