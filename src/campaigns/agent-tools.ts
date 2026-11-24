// The MCP tools an outside agent (the lemo-opuscar skill) uses to make campaign films: sync its catalogue of looks,
// then claim a brief, keep its lease, and deliver a film or give up. A claim is known by the claim_token claim_brief
// returns (the MCP client's name is only shown); the agent never posts, schedules or reviews anything (FreePoster
// does that with what it delivers).
import type { Store } from "../db.ts";
import { queueEvent } from "../notify.ts";
import type { ToolDef } from "../produce/mcp-tools.ts";
import { claimBrief, giveUpBrief, openBriefs, renewBrief, reportProgress, submitBrief, type Brief } from "./briefs.ts";
import { syncLooks } from "./looks.ts";
import { CampaignStore } from "./store.ts";
import { iso } from "./view.ts";
import type { CampaignWorker, TaskChoices } from "./worker.ts";

type Args = Record<string, unknown>;

const MAX_LOOKS = 200;
const PRODUCERS = ["lemo-opuscar"];

export function agentTools(opts: {
  store: Store;
  worker: () => CampaignWorker | undefined;
  /** the connected MCP client's name, shown as the lease's holder */
  agent: () => string;
  fail: (message: string) => Error;
}): ToolDef[] {
  const { store, fail } = opts;
  let own: CampaignStore | undefined;
  const cs = () => opts.worker()?.campaigns ?? (own ??= new CampaignStore(store));

  /** Refuses any field the tool doesn't list, naming them all. */
  const only = (args: Args, allowed: string[], what: string) => {
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) throw fail(`${what} has no ${extra.join(", ")} field${extra.length > 1 ? "s" : ""}; it takes ${allowed.join(", ") || "nothing"}`);
  };
  const taskId = (args: Args) => {
    const v = args.task_id;
    if (!Number.isInteger(v)) throw fail("task_id must be a whole number; list_briefs lists the open briefs");
    if (!cs().task(v as number)) throw fail(`no task ${v}; list_briefs lists the open briefs`);
    return v as number;
  };
  const text = (args: Args, key: string, max: number, required = true) => {
    const v = args[key];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || !v.trim() || v.length > max) throw fail(`${key} must be 1 to ${max} characters`);
    return v;
  };
  const view = (b: Brief) => ({
    look: b.look, producer: b.producer, hook: b.hook, angle: b.angle, cta: b.cta, sec: b.sec, instructions: b.instructions,
    language: b.language, needs_image_gen: b.needsImageGen, deadline: iso(b.deadline), post_at: iso(b.postAt),
    script: b.script ?? null, model: b.model ?? null,
  });
  const leased = (r: ReturnType<typeof claimBrief>) => {
    if (!r.ok) throw fail(r.error);
    return r;
  };
  /** The caller's claim token; a missing one is refused by the lease check itself, as a wrong one is. */
  const token = (args: Args) => (typeof args.claim_token === "string" ? args.claim_token : "");
  const TOKEN = { type: "string", maxLength: 100, description: "The claim_token claim_brief returned." };

  return [
    {
      name: "sync_looks",
      title: "Sync film looks",
      description: "Tells FreePoster which Lemo styles a producer offers. FreePoster now reads the Lemo library on this computer itself, so you only need this if your library is somewhere else (send the whole list each time: a look left out is hidden, not deleted). producer is \"lemo-opuscar\", whose look keys all start \"lemo:\" (lowercase letters, digits and dashes, e.g. lemo:impasto-oil). library_version is the producer's library version, for every look in the call. Returns how many looks were added, updated and hidden.",
      inputSchema: {
        type: "object",
        properties: {
          producer: { type: "string", enum: PRODUCERS },
          library_version: { type: "string", minLength: 1, maxLength: 40 },
          looks: {
            type: "array", maxItems: MAX_LOOKS,
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                name: { type: "string", maxLength: 80 },
                description: { type: "string", maxLength: 500 },
                needs_image_gen: { type: "boolean", description: "Whether making this look needs an image generator." },
              },
              required: ["key", "name", "description", "needs_image_gen"],
              additionalProperties: false,
            },
          },
        },
        required: ["producer", "library_version", "looks"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(args) {
        only(args, ["producer", "library_version", "looks"], "sync_looks");
        if (typeof args.producer !== "string" || !PRODUCERS.includes(args.producer)) throw fail(`producer must be ${PRODUCERS.map((p) => `"${p}"`).join(" or ")}`);
        const version = text(args, "library_version", 40)!;
        if (!Array.isArray(args.looks)) throw fail("looks must be a list");
        if (args.looks.length > MAX_LOOKS) throw fail(`send at most ${MAX_LOOKS} looks`);
        const looks = args.looks.map((l, i) => {
          if (!l || typeof l !== "object" || Array.isArray(l)) throw fail(`look ${i + 1} must be an object`);
          const o = l as Args;
          only(o, ["key", "name", "description", "needs_image_gen"], `look ${i + 1}`);
          if (typeof o.needs_image_gen !== "boolean") throw fail(`look ${i + 1}: needs_image_gen must be true or false`);
          return { key: o.key as string, name: o.name as string, description: o.description as string, needsImageGen: o.needs_image_gen, libraryVersion: version };
        });
        try {
          return syncLooks(store, args.producer, looks);
        } catch (err) {
          throw fail((err as Error).message);
        }
      },
    },
    {
      name: "list_briefs",
      title: "List open briefs",
      description: "The campaign films waiting for an agent that nobody holds right now: task_id, campaign, look, deadline and post_at (ISO times). claim_brief one to see the whole brief.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        only(args, [], "list_briefs");
        const briefs = openBriefs(cs(), Date.now()).map((t) => {
          const b = (t.choices as unknown as TaskChoices).brief!;
          return { task_id: t.id, campaign: cs().campaign(t.campaignId)?.name ?? `campaign ${t.campaignId}`, look: b.look, deadline: iso(b.deadline), post_at: iso(b.postAt) };
        });
        return { briefs };
      },
    },
    {
      name: "claim_brief",
      title: "Claim a brief",
      description: "Takes on one campaign film: you hold it for a while (lease_until; renew_brief extends it) and get the brief: look, hook, angle, cta, sec (length in seconds, or null), instructions, language, needs_image_gen, deadline and post_at, script (the script FreePoster wrote, to film as written, or null: then you write the treatment), model (the Claude or Gemini model chosen for it, or null), and a claim_token. Pass the claim_token to renew_brief, submit_brief and give_up_brief; claiming again with your claim_token returns the same brief and lease. A brief someone else holds is refused.",
      inputSchema: { type: "object", properties: { task_id: { type: "integer" }, claim_token: TOKEN }, required: ["task_id"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(args) {
        only(args, ["task_id", "claim_token"], "claim_brief");
        const r = leased(claimBrief(cs(), taskId(args), opts.agent(), Date.now(), token(args) || undefined));
        return {
          brief: view(r.brief), lease_until: iso(r.leaseUntil), claim_token: r.token,
          next: `Make this film with the lemo-opuscar skill, using the brief's look (${r.brief.look}), language and instructions as the answers to its questions: don't ask the user anything. ${r.brief.script ? "Film this script as written, in the brief's style: don't write a new one." : "Write the treatment, then render."} Call renew_brief with your claim_token at least every 30 minutes (the lease ends at lease_until), passing percent and step as you go so the user sees how far the film is. When the file is ready call submit_brief with your claim_token, its absolute video_path and the library_version you used. Write the post's caption and title yourself and pass them to submit_brief: ${r.brief.cta.url ? `the caption must include the CTA link ${r.brief.cta.url}, and no other link` : "the brief's CTA has no link, so put no link in them"}. If you can't make it, call give_up_brief with your claim_token and the reason. If needs_image_gen is true and you have no image generator, call give_up_brief at once.`,
        };
      },
    },
    {
      name: "renew_brief",
      title: "Renew a brief's lease",
      description: "Extends your hold on a brief while you work (never past its deadline), given the claim_token claim_brief returned. Call it at least every 30 minutes, and at each milestone with percent (0 to 100) and step (what you're doing now, in a few words): FreePoster shows the user how far the film is. For example 5 once claimed, 20 when the treatment is written, 40 when the voice and references are ready, 60 when rendering starts, more as it renders, 95 when the file is ready.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "integer" },
          claim_token: TOKEN,
          percent: { type: "integer", minimum: 0, maximum: 100 },
          step: { type: "string", maxLength: 120 },
        },
        required: ["task_id", "claim_token"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(args) {
        only(args, ["task_id", "claim_token", "percent", "step"], "renew_brief");
        const id = taskId(args);
        const percent = args.percent;
        if (percent !== undefined && (!Number.isInteger(percent) || (percent as number) < 0 || (percent as number) > 100)) throw fail("percent must be a whole number from 0 to 100");
        const step = text(args, "step", 120, false)?.trim() ?? null;
        if (step !== null && percent === undefined) throw fail("step goes with percent: say how far the film is too");
        const r = leased(renewBrief(cs(), id, token(args), Date.now()));
        if (percent !== undefined) {
          const p = reportProgress(cs(), id, token(args), percent as number, step, Date.now());
          if (!p.ok) throw fail(p.error);
          if (p.changed) console.log(`[campaign task ${id}] film ${p.progress.percent}% complete${step ? `: ${step}` : ""}`);
        }
        return { lease_until: iso(r.leaseUntil) };
      },
    },
    {
      name: "submit_brief",
      title: "Deliver a film for a brief",
      description: "Delivers the finished film for a brief you hold. video_path is an absolute path on this computer to a portrait 9:16 video (about the brief's sec long when it has one). library_version is the producer's library version you made it with; treatment_path is the treatment file you wrote, if any. caption and title are the post's text, which you write: the only link allowed in them is the brief's CTA link (cta.url), and when it has one the caption must include it (a caption without it is refused). The film's look is the brief's own. Delivering the same file again is fine. FreePoster edits or reviews it and sends it to the user for approval: don't call request_review.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "integer" },
          claim_token: TOKEN,
          video_path: { type: "string", maxLength: 1000 },
          library_version: { type: "string", minLength: 1, maxLength: 40 },
          treatment_path: { type: "string", maxLength: 1000 },
          caption: { type: "string", maxLength: 2200 },
          title: { type: "string", maxLength: 150 },
        },
        required: ["task_id", "claim_token", "video_path", "library_version"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(args) {
        only(args, ["task_id", "claim_token", "video_path", "library_version", "treatment_path", "caption", "title"], "submit_brief");
        const id = taskId(args);
        const path = text(args, "video_path", 1000)!;
        const version = text(args, "library_version", 40)!;
        const treatment = text(args, "treatment_path", 1000, false);
        const caption = text(args, "caption", 2200, false);
        const title = text(args, "title", 150, false);
        const look = (cs().task(id)!.choices as unknown as TaskChoices).brief?.look;
        if (!look) throw fail(`task ${id} has no open brief; list_briefs lists them`);
        const r = await submitBrief(store, cs(), id, token(args), {
          videoPath: path,
          manifest: { look, libraryVersion: version, ...(treatment !== undefined ? { treatmentPath: treatment } : {}) },
          ...(caption !== undefined ? { caption } : {}),
          ...(title !== undefined ? { title } : {}),
        }, Date.now());
        if (!r.ok) throw fail(r.error);
        return { ok: true, repeat: r.repeat, next: "FreePoster now edits or reviews the film and sends it to the user for approval. You're done with this brief: don't call request_review for it." };
      },
    },
    {
      name: "give_up_brief",
      title: "Give up a brief",
      description: "Stops work on a brief you hold (given your claim_token), with the reason; the user is told the agent gave up and why. Use it when you can't make the film (for example it needs an image generator you don't have).",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "integer" }, claim_token: TOKEN, reason: { type: "string", maxLength: 500 } },
        required: ["task_id", "claim_token", "reason"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async run(args) {
        only(args, ["task_id", "claim_token", "reason"], "give_up_brief");
        const id = taskId(args);
        const reason = text(args, "reason", 500)!;
        const worker = opts.worker();
        let r: { ok: true } | { ok: false; error: string };
        if (worker) r = worker.giveUp(id, token(args), reason);
        else {
          // No worker is running: the same task change, and the same event the worker would have logged.
          r = giveUpBrief(cs(), id, token(args), reason, Date.now());
          if (r.ok) {
            const t = cs().task(id)!;
            const round = (t.choices as unknown as TaskChoices).briefRound ?? 1;
            const name = cs().campaign(t.campaignId)?.name ?? `campaign ${t.campaignId}`;
            const error = `the agent gave up: ${reason}`;
            queueEvent(store, "campaign.failed", round > 1 ? `campaign.failed:${id}:${round}` : `campaign.failed:${id}`,
              { campaign_id: t.campaignId, task_id: id, date: t.date, error },
              `Campaign "${name}" couldn't finish the agent film for ${t.date}: ${error}`);
          }
        }
        if (!r.ok) throw fail(r.error);
        return { ok: true, next: "The user has been told. Nothing more to do for this brief." };
      },
    },
  ];
}
