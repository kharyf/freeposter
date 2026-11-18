// The Campaigns MCP tools. Reading is open to any agent; changing is only for campaigns the user switched Autorun on
// for, always with a reason, and only within Autorun's limits (autorun.ts). stop_campaigns is the kill switch: any
// agent may stop every campaign, none may start them again (only the window's Resume does).
import type { Store } from "../db.ts";
import type { ToolDef } from "../produce/mcp-tools.ts";
import { applyAgentChange, campaignVocabulary, REASON_MAX, type AgentChange } from "./autorun.ts";
import { CampaignStore, type Campaign, type LibraryKind } from "./store.ts";
import type { CampaignWorker } from "./worker.ts";

type Args = Record<string, unknown>;

export const CAMPAIGN_INSTRUCTIONS = `Campaigns run the user's weekly posting plans by themselves (list_campaigns, get_campaign), and get_analytics / get_video_metrics show how videos did. Only a campaign the user switched Autorun on for can be changed by you: update_campaign (its text, compiled schedule, or a lower daily post cap) and add_library_entry (new hooks and angles), each with a reason the user sees. Autorun can never change CTAs or use one the campaign doesn't already use, raise the daily post cap, change a type's "post without approval", or turn Autorun or the kill switch on or off. Every change is logged (under the name your MCP client gave, which is advisory) and the user can undo it; hooks and angles you add belong to that campaign. stop_campaigns stops every campaign at once (the user asked you to, or something is clearly wrong); only the user can resume them.`;

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function campaignTools(opts: {
  store: Store;
  worker: () => CampaignWorker | undefined;
  /** the connected MCP client's name, for the audit log */
  agent: () => string;
  fail: (message: string) => Error;
}): ToolDef[] {
  const { store, fail } = opts;
  let own: CampaignStore | undefined;
  const cs = () => opts.worker()?.campaigns ?? (own ??= new CampaignStore(store));
  const id = (args: Args, key = "campaign_id") => {
    const v = args[key];
    if (!Number.isInteger(v)) throw fail(`${key} must be a whole number`);
    return v as number;
  };
  const campaign = (cid: number) => {
    const c = cs().campaign(cid);
    if (!c) throw fail(`no campaign ${cid}; list_campaigns lists them`);
    return c;
  };
  const brief = (c: Campaign) => ({
    id: c.id, name: c.name, enabled: c.enabled, autorun: c.autorun, runnable: cs().isRunnable(c), daily_post_cap: c.dailyPostCap,
    confirmed_at: iso(c.confirmedAt),
  });
  const reasonOf = (args: Args) => {
    const r = args.reason;
    if (typeof r !== "string" || !r.trim()) throw fail("reason is required: say in a sentence why you're making this change (the user sees it)");
    return r;
  };
  /** Applies a change or turns its problems into the tool's error. */
  const apply = async (cid: number, change: AgentChange, reason: string) => {
    const campaigns = cs();
    campaign(cid);
    const r = await applyAgentChange(campaigns, cid, change, opts.agent(), reason, campaignVocabulary(store, campaigns), { ai: opts.worker()?.ai ?? null });
    if (!r.ok) throw fail(`refused: ${r.problems.join("; ")}`);
    return r.changeId;
  };

  return [
    {
      name: "list_campaigns",
      title: "List campaigns",
      description: "Every campaign with whether it's on, runnable (its schedule is confirmed for its text), Autorun, and its daily post cap; and whether the kill switch has stopped them all.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        return { killed: cs().killed(), campaigns: cs().campaigns().map(brief) };
      },
    },
    {
      name: "get_campaign",
      title: "Get a campaign",
      description: "One campaign: its text, its confirmed compiled schedule (days of make/post lines and rules), cap, default post times, what its rules stopped using, the styles and video types a schedule may name, and the Autorun change log (each with its reason, and whether the user undid it).",
      inputSchema: {
        type: "object",
        properties: { campaign_id: { type: "integer" } },
        required: ["campaign_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const c = campaign(id(args));
        const vocab = campaignVocabulary(store, cs());
        return {
          ...brief(c), text: c.text, compiled: c.compiled, default_post_times: c.defaultPostTimes, account_set_id: c.accountSetId,
          excluded: cs().excluded(c.id), killed: cs().killed(),
          styles: vocab.styles.map((s) => s.id), types: vocab.types,
          changes: cs().changes(c.id).map((ch) => ({ id: ch.id, agent: ch.agent, at: iso(ch.at), reason: ch.reason, undone_at: iso(ch.undoneAt) })),
        };
      },
    },
    {
      name: "update_campaign",
      title: "Change an Autorun campaign",
      description: "Changes a campaign the user switched Autorun on for: either its plain-English text (translated as the user's edits are; any line that can't be understood refuses the change) or its compiled schedule (the same JSON get_campaign shows, checked strictly; the text is rewritten to say it, and a schedule the text can't say is refused), not both, and/or a lower daily post cap. Refused while the user is editing the text and hasn't confirmed it. Only videos not yet made pick up the change: today's tasks already made keep what they were given, and undoing a change doesn't touch tasks made in between. It may only use CTAs, and types that post without approval, the campaign already uses, never another campaign's own hooks or angles, and never raises the cap. reason is required and the user sees it; they can undo the change. The change is logged under the name your MCP client introduced itself with (advisory: FreePoster can't verify it).",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "integer" },
          reason: { type: "string", maxLength: REASON_MAX, description: "Why: one or two sentences, e.g. what the analytics showed." },
          text: { type: "string", description: "The campaign's new text." },
          compiled: { type: "object", description: "A new compiled schedule, shaped like get_campaign's compiled." },
          daily_post_cap: { type: "integer", minimum: 1, description: "A lower daily post cap (it can't go up)." },
        },
        required: ["campaign_id", "reason"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const cid = id(args);
        const reason = reasonOf(args);
        const change: AgentChange = {};
        if (args.text !== undefined) change.text = args.text as string;
        if (args.compiled !== undefined) change.compiled = args.compiled;
        if (args.daily_post_cap !== undefined) change.dailyPostCap = args.daily_post_cap as number;
        if (!Object.keys(change).length) throw fail("give text, compiled or daily_post_cap to change");
        const changeId = await apply(cid, change, reason);
        const c = campaign(cid);
        return { change_id: changeId, campaign: { ...brief(c), text: c.text, compiled: c.compiled } };
      },
    },
    {
      name: "list_library",
      title: "List the library",
      description: "The hooks, angles and CTAs campaigns use, with their ids (for named picks in a compiled schedule), text, keywords, and owner_campaign_id: null for the user's own (any campaign may use them), else the campaign whose Autorun added it (only that campaign uses it).",
      inputSchema: {
        type: "object",
        properties: { kind: { type: "string", enum: ["hook", "angle", "cta"] } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const kind = args.kind;
        if (kind !== undefined && !["hook", "angle", "cta"].includes(kind as string)) throw fail("kind must be hook, angle or cta");
        return { entries: cs().entries(kind as LibraryKind | undefined).map((e) => ({ id: e.id, kind: e.kind, name: e.name, text: e.text, keywords: e.keywords, url: e.url, owner_campaign_id: e.ownerCampaignId ?? null })) };
      },
    },
    {
      name: "add_library_entry",
      title: "Add a hook or angle",
      description: "Adds a hook or angle to the library for an Autorun campaign (never a CTA). It belongs to that campaign: only its random and best picks use it, and no other campaign can name it. Logged as a change to that campaign, with your reason; undoing it removes the entry if nothing uses it yet. Name it in update_campaign afterwards to use it by name. The change is logged under the name your MCP client introduced itself with (advisory: FreePoster can't verify it).",
      inputSchema: {
        type: "object",
        properties: {
          campaign_id: { type: "integer", description: "The Autorun campaign it's for." },
          kind: { type: "string", enum: ["hook", "angle"] },
          name: { type: "string", maxLength: 100 },
          text: { type: "string", maxLength: 2000, description: "What's said: the hook line, or the angle's idea." },
          keywords: { type: "array", items: { type: "string" }, maxItems: 20, description: "Words that spot it in recorded videos' transcripts." },
          reason: { type: "string", maxLength: REASON_MAX },
        },
        required: ["campaign_id", "kind", "name", "text", "reason"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async run(args) {
        const cid = id(args);
        const reason = reasonOf(args);
        const entry = { kind: args.kind, name: args.name, text: args.text, ...(args.keywords !== undefined ? { keywords: args.keywords } : {}) } as NonNullable<AgentChange["addEntries"]>[number];
        const changeId = await apply(cid, { addEntries: [entry] }, reason);
        const added = (cs().change(changeId)?.after as { addedEntryIds?: number[] } | undefined)?.addedEntryIds?.[0] ?? null;
        return { change_id: changeId, entry_id: added };
      },
    },
    {
      name: "stop_campaigns",
      title: "Stop all campaigns",
      description: "The kill switch: stops every campaign at once. Nothing new is scheduled or started, and every campaign post not yet out is held. Only the user can resume them (in the FreePoster window); no tool can.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run() {
        const worker = opts.worker();
        if (!worker) throw fail("campaigns aren't running in this FreePoster");
        const held = worker.stopAll();
        return { stopped: true, held_posts: held, next: "Every campaign is stopped. Only the user can resume them, from the FreePoster window." };
      },
    },
  ];
}
