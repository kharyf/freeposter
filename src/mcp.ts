// FreePoster's MCP server: the one interface every agent uses (Claude Code, Codex, Cursor, Hermes, any other), to
// check accounts, edit, produce, ask for reviews and follow what happens. Served by the app itself at {BASE_URL}/mcp
// over MCP's Streamable HTTP transport, stateless, answering with plain JSON (no streams or sessions: tools finish
// quickly, posting goes on in the job runner, and wait_for_events holds one call open for at most a minute).
// Nothing here is specific to one agent: news reaches agents through the event log (list_events / wait_for_events),
// which works for agents that only run while the user talks to them, and through a webhook for ones always running.
import { createReadStream, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ToolError, type Tool } from "./api/errors.ts";
import { EVENT_GUIDE, GUIDES } from "./api/guides.ts";
import { trustedRequest } from "./api/guard.ts";
import { ApiError, guideText, indexText, noGuide, opDoc, runBatch, runOp } from "./api/routes.ts";
import { validate } from "./api/schema.ts";
import { parseFields } from "./api/compact.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accountSets, defaultSetId, setToken, sharedFrom } from "./accounts.ts";
import { codeDir, config, isConfigured } from "./config.ts";
import type { Store } from "./db.ts";
import type { Publisher } from "./platforms/base.ts";
import { creatorInfo } from "./platforms/tiktok.ts";
import { parseEditSettings } from "./edit/settings.ts";
import { allStyles, createStyle, defaultStyleId, saveThumbnail, setDefaultStyle, STYLE_STEPS, styleToken, thumbnailProblem, uploadedThumbnail, type EditingStyle } from "./edit/styles.ts";
import { EVENT_TYPES, eventView, nextEvent } from "./notify.ts";
import type { ReviewService, ReviewRequest } from "./review/service.ts";
import { REVIEW_STATES, type ReviewState } from "./review/store.ts";
import { captionTopicFor, checkDraft, DuplicateError, editView, parseSchedule, postView, saveUpload, type Draft } from "./posts.ts";
import { productionTools } from "./produce/mcp-tools.ts";
import { analyticsTools } from "./analytics/mcp-tools.ts";
import { agentTools } from "./campaigns/agent-tools.ts";
import { campaignTools } from "./campaigns/mcp-tools.ts";
import type { CampaignWorker } from "./campaigns/worker.ts";
import type { ProductionWorker } from "./produce/worker.ts";
import type { Runner } from "./runner.ts";
import { PLATFORMS, type Platform, type TikTokOptions } from "./types.ts";

/** The app's version, for serverInfo. */
const VERSION = (() => {
  try { return String(JSON.parse(readFileSync(join(codeDir, "package.json"), "utf8")).version || "0.0.0"); } catch { return "0.0.0"; }
})();

/** Newest first; an initialize asking for any of these gets it back, anything else gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS = [GUIDES.rules, GUIDES.events, GUIDES.production, GUIDES.campaigns].join("\n\n");

/** What lean (and typed-subset) clients are told: the rest is behind fp_help. */
const leanInstructions = () => `FreePoster posts short vertical videos to the user's TikTok, Instagram, Facebook, X and YouTube accounts. It runs on this computer; paths are local.
Use fp(op, args) for everything; fp_help() lists ops, fp_help(op) shows one op's args, fp_help(topic) gives a guide. Read fp_help(topic:"rules") before your first post.
You can't post or approve: request_review sends the video to the user, and only their tap on Approve posts it. If they say "yes" to you, tell them to tap Approve.
For TikTok, call get_tiktok_creator_info and let the user choose privacy_level.
News comes from the event log: wait_for_events / list_events; fp_help(topic:"events") says what to do with each event.
If you can run shell commands, the same ops are at POST ${config.baseUrl}/agent/v1/<op> (or the freeposter CLI), which costs fewer tokens.`;

/** Prompts: ready-made requests the user can pick in agents that offer them (often as slash commands). */
const PROMPTS = [
  {
    name: "check_freeposter",
    title: "Check FreePoster",
    description: "Catch up on what FreePoster did since you last looked (ready videos, review decisions, redos to make, posts that went out) and act on it.",
    arguments: [] as { name: string; description: string; required: boolean }[],
    text: (_args: Record<string, string>) => `Call list_events from FreePoster and handle every event it returns, oldest first:\n${EVENT_GUIDE}\nThen tell me in a few lines what happened and what you did. If there were no events, call list_reviews with needs_agent true in case a redo is still waiting, and say so if nothing is.`,
  },
  {
    name: "handle_redo",
    title: "Make a redo",
    description: "Make the change the user asked for on a FreePoster review, so the new version comes back to them for review.",
    arguments: [{ name: "review_id", description: "The review the user sent back for a redo (list_reviews with needs_agent shows them).", required: true }],
    text: (args: Record<string, string>) => `Call get_review with review_id ${Number(args.review_id) || "(ask me which)"} from FreePoster. It says what I want changed (reason, note, the time in the video, and for an edit the source time and the words said there; for a production the shot). Make that change with revise_edit or revise_production. For a Drive video the new edit comes back to me for review by itself; otherwise call request_review once the new version is ready. Then tell me in one line what you changed.`,
  },
];

/** Epoch ms → ISO 8601; agents read and write times this way. */
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export { ToolError, EVENT_GUIDE };
export type { Tool };
export { trustedRequest };

// ---- argument readers: the schemas below tell clients the shapes; these make sure of them ----

type Args = Record<string, unknown>;

function int(args: Args, key: string): number {
  const v = args[key];
  if (!Number.isInteger(v)) throw new ToolError(`${key} must be a whole number`);
  return v as number;
}

function str(args: Args, key: string, fallback = ""): string {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") throw new ToolError(`${key} must be a string`);
  return v;
}

function bool(args: Args, key: string, fallback = false): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new ToolError(`${key} must be true or false`);
  return v;
}

/** ISO 8601 (local time when there is no offset); null/absent = now. */
function when(args: Args, key: string): number | null {
  const raw = str(args, key);
  if (!raw) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) throw new ToolError(`${key} must be an ISO 8601 date and time, like 2026-11-02T18:30:00-05:00`);
  try {
    return parseSchedule(at);
  } catch (err) {
    throw new ToolError((err as Error).message);
  }
}

const SCHEDULE_PROP = {
  type: "string",
  description: "When to post, as ISO 8601 with a UTC offset (e.g. 2026-11-02T18:30:00-05:00); without an offset it is this computer's local time. Up to a year ahead. Omit to post now.",
};

const TIKTOK_PROP = {
  type: "object",
  description: "Required when any chosen account is TikTok.",
  properties: {
    privacy_level: { type: "string", description: "One of the account's privacy_level_options from get_tiktok_creator_info, chosen by the user." },
    allow_comment: { type: "boolean", default: false },
    allow_duet: { type: "boolean", default: false },
    allow_stitch: { type: "boolean", default: false },
    disclose_your_brand: { type: "boolean", default: false, description: "Promotes the user's own business; labeled \"Promotional content\"." },
    disclose_branded_content: { type: "boolean", default: false, description: "Paid partnership or promotes a third party; labeled \"Paid partnership\". Not allowed with SELF_ONLY." },
  },
  required: ["privacy_level"],
  additionalProperties: false,
};

/** What a review covers besides the video: shared by publish_video and request_review. */
const POST_PROPS = {
  account_ids: { type: "array", items: { type: "integer" }, minItems: 1, description: "Account ids from list_accounts." },
  caption: { type: "string", description: "The post's text: the tweet on X, the description on YouTube, the caption elsewhere. Leave it out (or blank) and the user's AI provider writes it from what's said in the video, or its on-screen text, before the review is sent." },
  title: { type: "string", description: "YouTube title (up to 100 characters); defaults to the caption's first line." },
  schedule_at: SCHEDULE_PROP,
  tiktok: TIKTOK_PROP,
  allow_duplicate: { type: "boolean", default: false, description: "Post even though this exact file already went to some of these accounts. Only when the user confirms." },
  dry_run: { type: "boolean", default: false, description: "Run every check and report, without asking for a review." },
};

export function mcpTools(store: Store, runner: Runner, publishers: Record<Platform, Publisher>, reviews: ReviewService, producer?: ProductionWorker, reviewChannel: () => Record<string, unknown> = () => ({}), campaigns?: CampaignWorker, agent: () => string = () => "agent"): Tool[] {
  const view = (p: Parameters<typeof postView>[1]) => {
    const v = postView(store, p);
    return {
      ...v,
      createdAt: iso(v.createdAt),
      scheduledAt: iso(v.scheduledAt),
      // A held job (a campaign post waiting to be placed, or stopped) has no time yet.
      jobs: v.jobs.map((j) => {
        const held = j.nextRunAt === Number.MAX_SAFE_INTEGER;
        return { ...j, held, nextRunAt: j.state === "published" || j.state === "failed" || held ? null : iso(j.nextRunAt) };
      }),
    };
  };
  const post = (id: number) => {
    const found = store.post(id);
    if (!found) throw new ToolError(`no post ${id}; list_posts shows the recent ones`);
    return view({ post: found, jobs: store.jobsForPost(id) });
  };
  const tiktokAccount = (id: number) => {
    const account = store.account(id);
    if (account?.platform !== "tiktok") throw new ToolError(`account ${id} is not a connected TikTok account`);
    return account;
  };

  /** The event feed (list_events, wait_for_events): what's returned counts as read by an agent. */
  const readEvents = (args: Args) => {
    const since = args.since === undefined || args.since === null ? null : int(args, "since");
    if (since !== null && since < 0) throw new ToolError("since must be 0 or more");
    const limit = args.limit === undefined ? 50 : Math.min(Math.max(int(args, "limit"), 1), 200);
    const raw = args.types;
    if (raw !== undefined && (!Array.isArray(raw) || raw.some((t) => !EVENT_TYPES.includes(t as never)))) throw new ToolError(`types must be a list of ${EVENT_TYPES.join(", ")}`);
    const rows = store.feed(since, limit, (raw as string[] | undefined) ?? []);
    store.markEventsRead(rows.map((r) => r.id));
    return { events: rows.map(eventView), next_since: rows.at(-1)?.id ?? since ?? store.latestEventId() };
  };

  const styleView = (st: EditingStyle) => ({
    id: st.id,
    name: st.name,
    filename_token: styleToken(st),
    description: st.description,
    built_in: st.builtIn,
    default: st.id === defaultStyleId(store),
    steps: Object.fromEntries(STYLE_STEPS.map((step) => [step.key, st.settings[step.key]])),
    thumbnail_url: `${config.baseUrl}/api/styles/${encodeURIComponent(st.id)}/thumbnail`,
    custom_thumbnail: uploadedThumbnail(st.id) !== null,
  });

  const tools: Tool[] = [
    {
      name: "list_accounts",
      title: "List accounts",
      description: "Lists the connected accounts (with the ids publish_video takes; default marks the accounts in the default account set, where FreePoster posts Drive videos whose name picks no set, and shared_from marks an account Meta shares another account's posts to, which can't be posted to directly) and each platform's video length limits, plus which platforms are set up. Platforms without keys are set up in the FreePoster window; accounts are connected by opening connect_url in a browser.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        const defaultSet = defaultSetId(store);
        const sets = accountSets(store);
        const defaults = sets.find((s) => s.id === defaultSet)?.accountIds ?? [];
        return {
          accounts: store.accounts().map((a) => ({
            id: a.id,
            platform: a.platform,
            name: a.name,
            minDurationSec: publishers[a.platform].minDurationSec,
            maxDurationSec: publishers[a.platform].maxDurationSec(a),
            needsReconnectSoon: a.refreshExpiresAt !== null && a.refreshExpiresAt - Date.now() < 14 * 86_400_000,
            default: defaults.includes(a.id),
            // Meta shares that account's posts here; publishing to this one is refused.
            shared_from: sharedFrom(store, a)?.id ?? null,
          })),
          // A Drive filename picks a set by its filename_token: Name_11.1.26_5.30.pm_Basic_PersonalBrand.
          account_sets: sets.map((s) => ({ id: s.id, name: s.name, filename_token: setToken(s.name), default: s.id === defaultSet, account_ids: s.accountIds })),
          platforms: PLATFORMS.map((p) => ({
            platform: p,
            label: publishers[p].label,
            configured: isConfigured(p),
            connect_url: isConfigured(p) ? `${config.baseUrl}/connect/${p}` : null,
          })),
          captionLimits: { x: `${config.xMaxChars} weighted characters (URLs count 23, most emoji 2)`, tiktok: 2200, instagram: "2200 characters, 30 hashtags", youtube: "title 100 characters; description 5000" },
          pendingJobs: store.pendingJobCount(),
        };
      },
    },
    {
      name: "get_tiktok_creator_info",
      title: "TikTok posting options",
      description: "Fetches a TikTok account's live posting options: privacy_level_options (show these to the user and let them choose), whether comments/duets/stitches are turned off on the account (those stay off), and the longest video it may post.",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "integer", description: "A TikTok account id from list_accounts." } },
        required: ["account_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async run(args) {
        const info = await creatorInfo(await runner.freshAccount(tiktokAccount(int(args, "account_id"))));
        return {
          nickname: info.creator_nickname,
          username: info.creator_username,
          privacy_level_options: info.privacy_level_options,
          comment_disabled: info.comment_disabled,
          duet_disabled: info.duet_disabled,
          stitch_disabled: info.stitch_disabled,
          max_video_post_duration_sec: info.max_video_post_duration_sec,
        };
      },
    },
    {
      name: "publish_video",
      title: "Ask to publish a video",
      description: "Asks the user to approve posting a video to the chosen accounts, now or at schedule_at: the same as request_review, for an edit (edit_id) or a file on this computer (video_path). Nothing posts until the user taps Approve on the review (Telegram or the FreePoster window). Returns the review at once; follow it with get_review. Any format works: the file is converted to 1080x1920 (letterboxing other shapes). Caption, length and TikTok rules are checked first and nothing is asked if any account would refuse it.",
      inputSchema: {
        type: "object",
        properties: {
          video_path: { type: "string", description: "Absolute path of the video file on this computer. Not needed with edit_id." },
          edit_id: { type: "integer", description: "Ask to post this edit (from create_edit) instead of a file." },
          ...POST_PROPS,
        },
        required: ["account_ids"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        return askForReview(args, false);
      },
    },
    {
      name: "request_review",
      title: "Ask the user to review a video",
      description: "Sends a ready production (production_id), a ready edit (edit_id) or a video file (video_path) to the user for review, with the accounts, caption, title and schedule it would post with. FreePoster makes the exact file that will be uploaded, writes the caption if it's blank, and sends it to the user on Telegram (and the FreePoster window) with Approve, Reject and Redo. Only the user's Approve posts it. Returns the review at once (state preparing, then pending); follow it with get_review or wait_for_events. A new request for the same edit or production replaces an open one. For a production, fields left out come from its spec's post section.",
      inputSchema: {
        type: "object",
        properties: {
          production_id: { type: "integer" },
          edit_id: { type: "integer" },
          video_path: { type: "string", description: "Absolute path of a video file on this computer." },
          ...POST_PROPS,
          expires_in_hours: { type: "number", minimum: 0.25, maximum: 336, default: 72, description: "How long the user has to decide (a scheduled post's review also ends at its time)." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        return askForReview(args, true);
      },
    },
    {
      name: "get_review",
      title: "Get a review",
      description: "A review's state: preparing, pending (waiting for the user), approved (with post_id), rejected, redo (with the user's reason, note, the time in the video, and what's there: the source time and words for an edit, the shot for a production), superseded (a newer version replaced it), expired, or failed (with the error). With no review_id, the 20 most recent.",
      inputSchema: { type: "object", properties: { review_id: { type: "integer" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        if (args.review_id === undefined) return { reviews: reviews.reviews.recent(20).map((r) => reviews.view(r)) };
        const r = reviews.reviews.get(int(args, "review_id"));
        if (!r) throw new ToolError("no such review; get_review with no id lists the recent ones");
        // An agent looking at a redo has picked it up: the user needn't be told nobody has.
        const redo = r.state === "redo" ? reviews.redoEvent(r) : undefined;
        if (redo) store.markEventsRead([redo.id]);
        return reviews.view(r);
      },
    },
    {
      name: "list_reviews",
      title: "List reviews",
      description: "Reviews, newest first, optionally only those in one state (preparing, pending, approved, rejected, redo, superseded, expired, failed). needs_agent: only redos the user asked for that are yours to make (FreePoster didn't make them itself and no newer version exists yet); handle each with get_review, then revise_edit or revise_production.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: [...REVIEW_STATES] },
          needs_agent: { type: "boolean", default: false },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const limit = args.limit === undefined ? 20 : Math.min(Math.max(int(args, "limit"), 1), 100);
        const state = str(args, "state");
        if (state && !REVIEW_STATES.includes(state as never)) throw new ToolError(`state must be one of ${REVIEW_STATES.join(", ")}`);
        let list = bool(args, "needs_agent") ? reviews.agentTodo() : state ? reviews.reviews.inState(state as ReviewState).sort((a, b) => b.id - a.id) : reviews.reviews.recent(limit);
        if (state) list = list.filter((r) => r.state === state);
        return { reviews: list.slice(0, limit).map((r) => reviews.view(r)) };
      },
    },
    {
      name: "list_events",
      title: "List FreePoster's events",
      description: "What happened in FreePoster, oldest first: productions and edits ready or failed, reviews waiting, approved, rejected, sent back for a redo, failed or expired, and posts done. Each has an id, event_type, at, a one-sentence summary to pass on, and the ids to follow up (review_id, edit_id, production_id, post_id). With no since, the events no agent has read yet (they count as read once returned); with since (an event id), every event after it. next_since is the id to pass next time. Call it whenever the user comes back to you, so nothing that happened meanwhile is missed.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "integer", minimum: 0, description: "Return events after this event id; omit for the unread ones." },
          types: { type: "array", items: { type: "string", enum: EVENT_TYPES }, description: "Only these event types." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        return readEvents(args);
      },
    },
    {
      name: "wait_for_events",
      title: "Wait for FreePoster's events",
      description: "Like list_events, but when there are none yet it waits up to timeout_sec (default 25, at most 50) for the next one, and returns as soon as one happens. Use it to follow a production, an edit or a review without calling get_* over and over: call it again with next_since until you have what you were waiting for. An empty list means nothing happened in that time.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "integer", minimum: 0, description: "Return events after this event id; omit for the unread ones." },
          types: { type: "array", items: { type: "string", enum: EVENT_TYPES }, description: "Only these event types." },
          timeout_sec: { type: "integer", minimum: 0, maximum: 50, default: 25 },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const timeout = args.timeout_sec === undefined ? 25 : Math.min(Math.max(int(args, "timeout_sec"), 0), 50);
        const until = Date.now() + timeout * 1000;
        for (;;) {
          const found = readEvents(args);
          if (found.events.length || Date.now() >= until) return found;
          await nextEvent(Math.min(until - Date.now(), 5_000));
        }
      },
    },
    {
      name: "revise_edit",
      title: "Revise an edit",
      description: "Makes a new edit of the same video with changed settings, after the user asked for a redo: switch tighten, captions, reframe, audio or punchIn; keep or drop ranges of the source ([{ start, end }] in source seconds: keep overrides the cut plan, drop always cuts); captionFixes ([{ at, from, to }]: the caption word nearest source second `at` that reads `from` shows `to`). Settings not given stay as they were. The old edit is replaced (it can't be posted). Returns the new edit; follow it with get_edit, then request_review.",
      inputSchema: {
        type: "object",
        properties: {
          edit_id: { type: "integer" },
          settings: {
            type: "object",
            properties: {
              tighten: { type: "boolean" }, captions: { type: "boolean" }, reframe: { type: "boolean" }, audio: { type: "boolean" }, punchIn: { type: "boolean" },
              keep: { type: "array", items: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } }, required: ["start", "end"] } },
              drop: { type: "array", items: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } }, required: ["start", "end"] } },
              captionFixes: { type: "array", items: { type: "object", properties: { at: { type: "number" }, from: { type: "string" }, to: { type: "string" } }, required: ["at", "from", "to"] } },
            },
            additionalProperties: false,
          },
        },
        required: ["edit_id", "settings"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const old = store.edit(int(args, "edit_id"));
        if (!old) throw new ToolError("no such edit");
        if (old.approvedAt) throw new ToolError(`edit ${old.id} was approved and posted; make a new edit with create_edit instead`);
        if (!["ready", "failed", "rejected"].includes(old.state)) throw new ToolError(`edit ${old.id} is ${old.state}; revise it once it's ready`);
        let settings;
        try { settings = parseEditSettings(args.settings, old.settings); } catch (err) { throw new ToolError((err as Error).message); }
        const next = store.createEdit(old.sourcePath, old.sha256, settings, old.id);
        if (next.id === old.id) throw new ToolError("those are the edit's settings already; change something");
        store.closeEdit(old.id, "superseded");
        return { ...(await editView(store, publishers, next)), parent_edit_id: old.id, next: "Call get_edit to follow it; when it's ready, request_review with its edit_id." };
      },
    },
    {
      name: "audit_reviews",
      title: "Audit reviews",
      description: "Checks every published post against its review: each one an agent asked for must have been approved by the user (with where and when) before it was made, and every account must have uploaded the exact file that was approved (same sha256). Lists any problem found.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        return reviews.audit();
      },
    },
    {
      name: "create_edit",
      title: "Edit a video",
      description: "Starts an edit of a video file on this computer, run locally in the background: cuts pauses, filler words and retakes, burns in word-synced captions, frames the speaker for 9:16, evens out the sound and zooms on cuts. Every setting defaults to on. Returns at once; follow with get_edit, then request_review with its edit_id so the user can approve, reject or redo it.",
      inputSchema: {
        type: "object",
        properties: {
          video_path: { type: "string", description: "Absolute path of the video file on this computer." },
          settings: {
            type: "object",
            properties: {
              tighten: { type: "boolean", default: true },
              captions: { type: "boolean", default: true },
              reframe: { type: "boolean", default: true },
              audio: { type: "boolean", default: true },
              punchIn: { type: "boolean", default: true },
            },
            additionalProperties: false,
          },
        },
        required: ["video_path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(args) {
        const videoPath = checkedPath(str(args, "video_path"));
        let settings;
        try { settings = parseEditSettings(args.settings); } catch (err) { throw new ToolError((err as Error).message); }
        const saved = await saveUpload(createReadStream(videoPath), videoPath);
        const edit = store.createEdit(saved.path, saved.sha256, settings);
        if (edit.sourcePath !== saved.path) try { unlinkSync(saved.path); } catch {}
        return { ...(await editView(store, publishers, edit)), next: "Call get_edit to follow it. When it's ready, request_review with its edit_id: the user approves it there." };
      },
    },
    {
      name: "list_editing_styles",
      title: "List editing styles",
      description: "Lists the editing styles: named edits a video from the user's Drive folder gets when its filename names one (Name_11.1.26_5.30.pm_Basic.mp4, by its filename_token) or, when it names none, the default style. Each has its steps (which parts of the edit it makes), whether it's built in or the user's, and a thumbnail_url showing an example frame.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        return { styles: allStyles(store).map(styleView), steps: STYLE_STEPS };
      },
    },
    {
      name: "add_editing_style",
      title: "Add an editing style",
      description: "Adds an editing style the user asked for, shown on the Editing Styles tab of the FreePoster window. A Drive video whose filename has the style's filename_token (its name without spaces) is edited with its steps. Agree the name and steps with the user first. The name can't contain an underscore, read as a date, a time or RAW, or match another style or an account set (list_editing_styles and list_accounts show them). Steps left out are on; at least one must be on.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Up to 40 characters, e.g. \"Fast Cuts\" (written FastCuts in a filename)." },
          description: { type: "string", description: "What the style does, in a sentence or two (up to 500 characters), shown with it." },
          steps: {
            type: "object",
            description: "Which parts of the edit it makes. Each defaults to true.",
            properties: Object.fromEntries(STYLE_STEPS.map((step) => [step.key, { type: "boolean", default: true, description: step.help }])),
            additionalProperties: false,
          },
          thumbnail_path: { type: "string", description: "Absolute path of a PNG, JPEG or WebP image on this computer (up to 5 MB) showing an example of the style, ideally 9:16. Leave it out and FreePoster draws one from the steps." },
          make_default: { type: "boolean", default: false, description: "Make it the style Drive videos get when their name gives none. Only when the user asks." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const name = str(args, "name");
        const description = str(args, "description");
        const makeDefault = bool(args, "make_default");
        let image: Buffer | undefined;
        const thumbnailPath = str(args, "thumbnail_path");
        if (thumbnailPath) {
          if (!isAbsolute(thumbnailPath)) throw new ToolError("thumbnail_path must be an absolute path");
          try { image = readFileSync(thumbnailPath); } catch { throw new ToolError(`no file at ${thumbnailPath}`); }
          const problem = thumbnailProblem(image);
          if (problem) throw new ToolError(problem);
        }
        const made = createStyle(store, { name, description, steps: args.steps as never });
        if (typeof made === "string") throw new ToolError(made);
        if (image) saveThumbnail(made.id, image);
        if (makeDefault) setDefaultStyle(store, made.id);
        return { style: styleView(made), next: `Tell the user it's on the Editing Styles tab, and that a Drive video named like Name_11.1.26_5.30.pm_${styleToken(made)}.mp4 is edited this way.` };
      },
    },
    {
      name: "get_edit",
      title: "Get an edit",
      description: "An edit's state (queued, transcribing, editing, ready, failed, rejected, superseded), progress, edited and original length, whether the user approved it, the edit it revises, which accounts each length fits, and preview_path (the edited file on this computer) once ready.",
      inputSchema: {
        type: "object",
        properties: { edit_id: { type: "integer" } },
        required: ["edit_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const edit = store.edit(int(args, "edit_id"));
        if (!edit) throw new ToolError("no such edit");
        return { ...(await editView(store, publishers, edit)), parent_edit_id: edit.parentEditId, preview_path: edit.state === "ready" ? edit.outputPath : null };
      },
    },
    {
      name: "get_post",
      title: "Get a post",
      description: "One post and its job per account: state (queued, running, retry, waiting_quota, published, failed), the published post's url, the platform's error, and when it next runs.",
      inputSchema: {
        type: "object",
        properties: { post_id: { type: "integer" } },
        required: ["post_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        return post(int(args, "post_id"));
      },
    },
    {
      name: "list_posts",
      title: "List posts",
      description: "The most recent posts, newest first, plus every post still waiting to go out (including scheduled ones), each with its per-account jobs.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 30 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const limit = args.limit === undefined ? 30 : int(args, "limit");
        return { posts: store.recentPosts(Math.min(Math.max(limit, 1), 200)).map(view) };
      },
    },
    {
      name: "reschedule_post",
      title: "Reschedule a post",
      description: "Moves a post that hasn't started going out to a new time, or posts it now when schedule_at is omitted. Accounts it has already started on are left as they are.",
      inputSchema: {
        type: "object",
        properties: { post_id: { type: "integer" }, schedule_at: SCHEDULE_PROP },
        required: ["post_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(args) {
        const id = int(args, "post_id");
        post(id);
        const at = when(args, "schedule_at");
        const moved = store.reschedulePost(id, at);
        if (!moved) throw new ToolError("this post has already started going out");
        runner.tick();
        return { moved, ...post(id) };
      },
    },
    {
      name: "cancel_post",
      title: "Cancel a post",
      description: "Cancels a post for every account it hasn't started going out to. Accounts already under way finish (stopping mid-upload could leave half a post), and published posts stay up: delete those on the platform.",
      inputSchema: {
        type: "object",
        properties: { post_id: { type: "integer" } },
        required: ["post_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(args) {
        const id = int(args, "post_id");
        post(id);
        const { cancelled, deleted, orphanedSource } = store.cancelPost(id);
        if (!cancelled) throw new ToolError("nothing to cancel: this post has already started going out");
        if (orphanedSource) try { unlinkSync(orphanedSource); } catch {}
        return { cancelled, post: deleted ? null : post(id) };
      },
    },
    {
      name: "retry_job",
      title: "Retry a failed job",
      description: "Tries a failed job (one post to one account) again from where it stopped. Only for failed jobs; fix what the error says first (e.g. reconnect the account).",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "integer", description: "A job id from get_post." } },
        required: ["job_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async run(args) {
        const job = store.job(int(args, "job_id"));
        if (!job) throw new ToolError("no such job");
        if (job.state !== "failed") throw new ToolError(`only failed jobs can be retried; this one is ${job.state}`);
        const refused = store.retryJob(job.id);
        if (refused) throw new ToolError(refused);
        runner.tick();
        return post(job.postId);
      },
    },
  ];
  tools.push(...productionTools({
    producer: () => producer,
    store,
    publishers,
    reviewChannel,
    fail: (message) => new ToolError(message),
  }));
  tools.push(
    ...analyticsTools({ store, fail: (message) => new ToolError(message) }),
    ...campaignTools({ store, worker: () => campaigns, agent, fail: (message) => new ToolError(message) }),
    ...agentTools({ store, worker: () => campaigns, agent, fail: (message) => new ToolError(message) }),
  );
  return tools;

  /**
   * publish_video and request_review: checks the request like a post (accounts, TikTok choices, caption rules,
   * lengths), then asks for the review. dry_run checks only.
   */
  async function askForReview(args: Args, allowProduction: boolean) {
    const given = ["production_id", "edit_id", "video_path"].filter((k) => args[k] !== undefined);
    if (!allowProduction && args.production_id !== undefined) throw new ToolError("publish_video takes edit_id or video_path; use request_review for a production");
    if (given.length !== 1) throw new ToolError("give exactly one of production_id, edit_id or video_path");
    // A production's spec may say where and how it posts.
    let defaults: Args = {};
    if (args.production_id !== undefined) {
      const p = producer?.productions.get(int(args, "production_id"));
      if (!p) throw new ToolError(`no production ${args.production_id}; get_production lists the recent ones`);
      defaults = (p.spec.post ?? {}) as Args;
      if (args.caption === undefined && defaults.caption === undefined && p.spec.title) defaults = { ...defaults, title: defaults.title ?? p.spec.title };
    }
    const pick = (k: string) => (args[k] !== undefined ? args[k] : defaults[k]);
    const merged: Args = { ...args };
    for (const k of ["account_ids", "caption", "title", "schedule_at", "tiktok"]) if (pick(k) !== undefined) merged[k] = pick(k);
    const ids = merged.account_ids;
    if (!Array.isArray(ids) || !ids.length || !ids.every(Number.isInteger)) throw new ToolError("account_ids must be a list of account ids (list_accounts has them)");
    const tiktok = await tiktokOptions(merged.tiktok, ids as number[]);
    const caption = str(merged, "caption");
    const title = str(merged, "title");
    const scheduledAt = when(merged, "schedule_at");
    const dryRun = bool(args, "dry_run");

    let subject: ReviewRequest["subject"];
    let copied: string | null = null;
    if (args.production_id !== undefined) subject = { kind: "production", id: int(args, "production_id") };
    else if (args.edit_id !== undefined) {
      const edit = store.edit(int(args, "edit_id"));
      if (!edit) throw new ToolError("no such edit; create_edit returns its id");
      subject = { kind: "edit", id: edit.id };
    } else {
      const videoPath = checkedPath(str(args, "video_path"));
      if (dryRun) subject = { kind: "file", path: videoPath };
      else {
        // A copy of its own: the user may move or change their file before it's reviewed.
        copied = (await saveUpload(createReadStream(videoPath), videoPath)).path;
        subject = { kind: "file", path: copied, name: videoPath };
      }
    }

    if (dryRun) {
      const source = subject.kind === "file" ? subject.path
        : subject.kind === "edit" ? store.edit(subject.id)?.outputPath
        : producer?.productions.get(subject.id)?.outputPath;
      if (!source) throw new ToolError(`that ${subject.kind} isn't ready yet`);
      try {
        const draft: Draft = { sourcePath: source, sha256: "", caption, title, accountIds: ids as number[], tiktok, scheduledAt, captionTopic: captionTopicFor(caption, title, subject.kind === "file" ? source : "") };
        const { accounts, durationSec } = await checkDraft(store, publishers, draft, true);
        return { ok: true, dryRun: true, durationSec, accounts: accounts.map((a) => ({ id: a.id, platform: a.platform, name: a.name })), scheduledAt: iso(scheduledAt), captionWrittenByAi: Boolean(draft.captionTopic) };
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    }
    try {
      const review = await reviews.request({
        subject, accountIds: ids as number[], caption, title, scheduledAt, tiktok, allowDuplicate: bool(args, "allow_duplicate"), via: "agent",
        expiresInHours: args.expires_in_hours === undefined ? undefined : Number(args.expires_in_hours),
      });
      return { ...reviews.view(review), next: "The user decides on the review itself (Telegram or the FreePoster window). Follow it with get_review, or wait_for_events for its review.* event. Don't ask them to say yes in chat: that doesn't approve anything." };
    } catch (err) {
      if (copied) try { unlinkSync(copied); } catch {}
      throw new ToolError((err as Error).message);
    }
  }

  /** An absolute path to an existing video file of at most 4 GB. */
  function checkedPath(videoPath: string): string {
    if (!isAbsolute(videoPath)) throw new ToolError("video_path must be an absolute path");
    let size: number;
    try {
      const stat = statSync(videoPath);
      if (!stat.isFile()) throw new Error();
      size = stat.size;
    } catch {
      throw new ToolError(`no file at ${videoPath}`);
    }
    if (size > 4 * 1024 ** 3) throw new ToolError("the file is larger than 4 GB");
    return videoPath;
  }

  /** The agent's TikTok choices, checked against the account's live options as the page's form is. */
  async function tiktokOptions(raw: unknown, accountIds: number[]): Promise<TikTokOptions | null> {
    const tiktokIds = accountIds.filter((id) => store.account(id)?.platform === "tiktok");
    if (!tiktokIds.length) return null;
    if (!raw || typeof raw !== "object") {
      throw new ToolError("posting to TikTok needs tiktok.privacy_level: call get_tiktok_creator_info and ask the user which privacy_level_options to use");
    }
    const t = raw as Args;
    const options: TikTokOptions = {
      privacyLevel: str(t, "privacy_level"),
      disableComment: !bool(t, "allow_comment"),
      disableDuet: !bool(t, "allow_duet"),
      disableStitch: !bool(t, "allow_stitch"),
      brandOrganic: bool(t, "disclose_your_brand"),
      brandContent: bool(t, "disclose_branded_content"),
    };
    for (const id of tiktokIds) {
      const info = await creatorInfo(await runner.freshAccount(tiktokAccount(id)));
      if (!info.privacy_level_options.includes(options.privacyLevel)) {
        throw new ToolError(`TikTok ${info.creator_nickname || id} allows privacy_level ${info.privacy_level_options.join(", ")}; ask the user which one`);
      }
    }
    return options;
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Which tools tools/list shows and which instructions initialize gives; every registry tool stays callable by name. */
type Profile = { kind: "lean" } | { kind: "full" } | { kind: "subset"; names: string[] };

function readProfile(query: unknown, tools: Tool[]): Profile | string {
  const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  const one = (v: unknown) => (Array.isArray(v) ? String(v[0]) : typeof v === "string" ? v : undefined);
  const list = one(q.tools);
  if (list !== undefined) {
    const names = [...new Set(list.split(",").map((n) => n.trim()).filter(Boolean))];
    const unknown = names.filter((n) => !tools.some((t) => t.name === n));
    if (unknown.length || !names.length) return `unknown tools ${unknown.join(", ") || "(none given)"}; valid names: ${tools.map((t) => t.name).join(", ")}`;
    return { kind: "subset", names };
  }
  const profile = one(q.profile);
  if (profile === undefined || profile === "lean") return { kind: "lean" };
  if (profile === "full") return { kind: "full" };
  return `unknown profile ${profile}; use lean or full, or ?tools=a,b,c`;
}

/** The two tools lean clients see; callable on every profile. Their results are text only. */
function gatewayTools(tools: Tool[]): Tool[] {
  const objectArgs = (raw: unknown): Record<string, unknown> => {
    let v = raw ?? {};
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch { /* reported below */ }
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ApiError(400, "args must be an object (or a JSON string of one)");
    return v as Record<string, unknown>;
  };
  const failed = (err: unknown) => (err instanceof ApiError ? new ToolError(err.message) : err);
  const callProps = {
    op: { type: "string", description: "Op name." },
    args: { anyOf: [{ type: "object" }, { type: "string" }], description: "Op arguments (object or JSON string)." },
    fields: { type: "string", description: "Comma-separated result fields to keep." },
  };
  return [
    {
      name: "fp",
      title: "Run a FreePoster op",
      description: "Run a FreePoster op. fp_help lists ops and their args.",
      inputSchema: {
        type: "object",
        properties: {
          ...callProps,
          calls: { type: "array", items: { type: "object", properties: callProps }, description: "Batch of {op,args,fields} instead of op." },
        },
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
      async run(args) {
        try {
          if (args.calls !== undefined) {
            const items = Array.isArray(args.calls)
              ? args.calls.map((c) => (c && typeof c === "object" && !Array.isArray(c) && typeof (c as Args).args === "string" ? { ...c, args: objectArgs((c as Args).args) } : c))
              : args.calls;
            return await runBatch(tools, items);
          }
          if (typeof args.op !== "string") throw new ApiError(400, "op must be a string");
          return (await runOp(tools, args.op, objectArgs(args.args), parseFields(args.fields))) ?? {};
        } catch (err) {
          throw failed(err);
        }
      },
    },
    {
      name: "fp_help",
      title: "FreePoster help",
      description: "FreePoster ops and guides. No args: the op index. op: one op's args. topic: rules|events|production|campaigns|limits.",
      inputSchema: { type: "object", properties: { op: { type: "string" }, topic: { type: "string" } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        try {
          if (typeof args.topic === "string") {
            const guide = guideText(args.topic);
            if (guide === null) throw new ApiError(404, noGuide(args.topic));
            return guide;
          }
          if (typeof args.op === "string") return opDoc(tools, args.op);
          return indexText(tools);
        } catch (err) {
          throw failed(err);
        }
      },
    },
  ];
}

export function registerMcp(app: FastifyInstance, tools: Tool[], setAgent: (name: string) => void) {
  // The server is stateless, so the agent's name for the Autorun log is the clientInfo.name of the latest initialize.
  const gateway = gatewayTools(tools);
  const callable = [...tools, ...gateway.filter((g) => !tools.some((t) => t.name === g.name))];
  const shown = (profile: Profile): Tool[] =>
    profile.kind === "full" ? tools : profile.kind === "lean" ? gateway : profile.names.map((n) => tools.find((t) => t.name === n)!);

  async function handle(msg: any, profile: Profile): Promise<object | null> {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return msg && "id" in msg && !("method" in msg) ? null : rpcError(msg?.id, -32600, "not a JSON-RPC 2.0 request");
    }
    const isNotification = !("id" in msg);
    const reply = (result: object) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        const name = params.clientInfo?.name;
        if (typeof name === "string" && name.trim()) setAgent(name.trim().slice(0, 100));
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: "freeposter", title: "FreePoster", version: VERSION },
          instructions: profile.kind === "full" ? INSTRUCTIONS : leanInstructions(),
        });
      }
      case "ping":
        return reply({});
      case "prompts/list":
        return reply({ prompts: PROMPTS.map(({ text, ...p }) => p) });
      case "prompts/get": {
        const prompt = PROMPTS.find((p) => p.name === params.name);
        if (!prompt) return isNotification ? null : rpcError(msg.id, -32602, `unknown prompt ${params.name}`);
        const args = (params.arguments ?? {}) as Record<string, string>;
        const missing = prompt.arguments.find((a) => a.required && !args[a.name]);
        if (missing) return isNotification ? null : rpcError(msg.id, -32602, `prompt ${prompt.name} needs ${missing.name}`);
        return reply({ description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(args) } }] });
      }
      case "tools/list":
        return reply({ tools: shown(profile).map(({ run, ...t }) => t) });
      case "tools/call": {
        const tool = callable.find((t) => t.name === params.name);
        if (!tool) return isNotification ? null : rpcError(msg.id, -32602, `unknown tool ${params.name}`);
        const args = params.arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args)) return isNotification ? null : rpcError(msg.id, -32602, "arguments must be an object");
        try {
          const isGateway = gateway.includes(tool);
          if (!isGateway) validate(tool.inputSchema, args);
          const result = await tool.run(args);
          // The gateway tools answer in text only (a guide is plain text, a result compact JSON); named tools also carry structuredContent.
          if (isGateway) return reply({ content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] });
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        } catch (err) {
          // Platform and validation errors go back to the model, which can fix its call or tell the user.
          if (!(err instanceof ToolError)) console.error(`mcp ${tool.name}:`, (err as Error).message);
          return reply({ content: [{ type: "text", text: (err as Error).message }], isError: true });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
        return rpcError(msg.id, -32601, `method ${msg.method} not found`);
    }
  }

  app.post("/mcp", async (req, reply) => {
    const refused = trustedRequest(req);
    if (refused) return reply.code(403).send(rpcError(null, -32600, refused));
    const version = req.headers["mcp-protocol-version"];
    if (typeof version === "string" && !PROTOCOL_VERSIONS.includes(version)) {
      return reply.code(400).send(rpcError(null, -32600, `unsupported MCP-Protocol-Version ${version}; use ${PROTOCOL_VERSIONS.join(", ")}`));
    }
    if (!req.headers["content-type"]?.startsWith("application/json") || typeof req.body !== "object" || req.body === null) {
      return reply.code(400).send(rpcError(null, -32700, "send a JSON-RPC message as application/json"));
    }
    const profile = readProfile(req.query, tools);
    if (typeof profile === "string") return reply.code(400).send(rpcError(null, -32602, profile));
    const batch = Array.isArray(req.body);
    const responses = (await Promise.all((batch ? (req.body as unknown[]) : [req.body]).map((m) => handle(m, profile)))).filter(Boolean);
    if (!responses.length) return reply.code(202).send();
    return reply.type("application/json").send(batch ? responses : responses[0]);
  });

  // No server-initiated messages and no sessions to end.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(405).header("allow", "POST").send();
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
