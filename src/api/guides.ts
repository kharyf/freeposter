// The long-form guides an agent reads once, on demand (GET /agent/v1/guide/:topic) or all at once as the MCP
// server's instructions. Imports only domain files, never src/mcp.ts.
import { config } from "../config.ts";
import { CAMPAIGN_INSTRUCTIONS } from "../campaigns/mcp-tools.ts";
import { PRODUCTION_INSTRUCTIONS } from "../produce/mcp-tools.ts";

/** What an agent should do with each event: in the instructions, and in the check_freeposter prompt. */
export const EVENT_GUIDE = `- production.ready or edit.ready: show the user the preview if they haven't seen it, then call request_review with the accounts and caption you agreed on, unless the summary says FreePoster sends it for review itself (videos from the user's Drive folder, with drive_file, and campaign videos, with campaign_task_id: request_review refuses those). Don't send the video yourself.
- review.redo: if handled_by is "freeposter", tell the user in one line what FreePoster is changing. Otherwise call get_review, make the change with revise_edit or revise_production, and tell them in one line what you changed.
- review.rejected: acknowledge it and ask whether they want something different.
- review.failed, production.failed, edit.failed: tell them what failed and offer to fix it.
- review.expired: ask whether it should still go out; if so, request_review again.
- post.done: give them the links.
- brief.requested or brief.expired: if handled_by is "freeposter", don't claim it: FreePoster is starting Claude for it, so just tell the user in one line. Otherwise call claim_brief with its task_id (keep the claim_token it returns for renew_brief, submit_brief and give_up_brief), make the film the brief describes with the lemo-opuscar skill without asking questions, then submit_brief. If you can't, give_up_brief with the reason.
- campaign.remade: the user changed a campaign row, so FreePoster is making that row's unposted videos again (or removed them). It's news only: tell the user if they ask, and do nothing.
- review.waiting, review.approved: nothing to do but tell them where things stand if they ask.
You can't approve anything. If the user says "yes" to you, remind them to tap Approve on the review.`;

export const GUIDE_TOPICS = ["rules", "events", "production", "campaigns", "limits"] as const;

export const GUIDES: Record<(typeof GUIDE_TOPICS)[number], string> = {
  rules: `FreePoster publishes one short vertical video to the user's TikTok, Instagram Reels, Facebook Page Reels, X and YouTube Shorts accounts through each platform's official API. It runs on the user's computer, so video_path is a path on this computer.

Start with list_accounts to get account ids. You can't post anything yourself: request_review (or publish_video, which does the same) sends the video, with its caption and accounts, to the user for review. FreePoster makes the exact file that will be uploaded, writes a blank caption, and sends it to them on Telegram with Approve, Reject and Redo buttons (and shows it in the FreePoster window). Only their tap on Approve (or the window's button) posts it; nothing you say or call can, including the user saying "yes" to you in chat: if they do, tell them to tap Approve on the review. Once approved, the review's post_id is a normal post: follow it with get_post until every job is "published" (with the post's url) or "failed" (with the platform's reason).

Posting is public and hard to undo: only ask to post what the user asked for, to the accounts they chose. For TikTok, call get_tiktok_creator_info first and let the user pick the privacy level from privacy_level_options; TikTok requires that choice to be the user's, never a default. Use dry_run to check a post without asking for a review. With no caption, the user's AI provider writes the title and caption from the video before the review is sent, so the user sees the text they approve.

Videos the user drops in their Drive folder are edited in the editing style their filename names (or the default one). list_editing_styles shows the styles; when the user wants a new one, agree its name and steps with them and call add_editing_style.

create_edit makes an edited cut (pauses and filler words cut, captions, speaker framing, even sound) in the background; follow it with get_edit, then request_review with its edit_id. When the user asks for a redo, get_review says why, at what time in the video, the source time and the words said there; make the change with revise_edit (edits) or revise_production (productions), and the new version comes back to them for review.`,
  events: `FreePoster tells you what happens through its event log, so you never have to guess or poll each thing: production.ready / production.failed, edit.ready / edit.failed, review.waiting / approved / rejected / redo / failed / expired, and post.done, each with a one-sentence summary you can pass on. wait_for_events waits (up to about a minute per call) and returns them as they happen; list_events returns what you haven't read yet, so call it whenever the user comes back to you. list_reviews with needs_agent shows redos waiting for you. How to handle each event:
${EVENT_GUIDE}`,
  production: PRODUCTION_INSTRUCTIONS,
  campaigns: CAMPAIGN_INSTRUCTIONS,
  get limits() {
    return [
      `X: ${config.xMaxChars} weighted characters (URLs count 23, most emoji 2)`,
      "TikTok: 2200",
      "Instagram: 2200 characters, 30 hashtags",
      "YouTube: title 100 characters; description 5000",
    ].join("\n");
  },
};
