# Using FreePoster from any AI agent

FreePoster works with whichever agent you prefer: Claude Code, Codex, Cursor, Claude Desktop, Hermes Agent, or anything else that speaks MCP. You ask your agent for a video, it makes it with FreePoster (an edit or a production), and asks FreePoster to send it to you for review. Everything waits for your approval: your tap on **Approve**, on Telegram or in the FreePoster window, posts it. An agent can't post a video on its own unless you've let that type post without approval, and telling an agent "yes" still doesn't count.

Every agent gets the same three things, and none of them is tied to one agent:

| What | Needed? | What it does |
|---|---|---|
| [The MCP server, API or CLI](#1-the-mcp-server-the-api-and-the-command-line) | Yes | The agent calls FreePoster: accounts, edits, productions, reviews, posts. |
| [The event feed](#2-the-event-feed) | Built in | The agent finds out what happened: a video is ready, you approved, rejected or asked for a redo, a post went out. |
| [A webhook](#3-a-webhook-optional) | Optional | FreePoster pushes each event the moment it happens, for agents that run all the time. |

Reviews on Telegram work with any agent too ([section 4](#4-reviews-on-telegram)). For Hermes's ready-made pieces, see [hermes.md](hermes.md).

## 1. The MCP server, the API and the command line

**Agents that can run shell commands: use the API or the CLI (cheapest).** Nothing is loaded into the conversation up front; the agent reads what it needs, when it needs it:

```bash
curl -s http://localhost:4400/agent/v1                       # every op, one line each
curl -s http://localhost:4400/agent/v1/request_review        # one op's arguments
curl -s -X POST http://localhost:4400/agent/v1/list_accounts -H 'content-type: application/json' -d '{}'
```

`GET /agent/v1/guide/rules` (also `events`, `production`, `campaigns`, `limits`) is the long-form advice. Results are compact JSON; `?fields=a.b,c` keeps only some fields and `POST /agent/v1` runs up to 20 ops in one request. The `freeposter` command line ([section 5](#5-the-command-line)) does the same.

**Everything else uses MCP** (Streamable HTTP) at `http://localhost:4400/mcp`. The app's **AI agents** panel shows the setup line for each agent:

```bash
claude mcp add --transport http freeposter http://localhost:4400/mcp   # Claude Code
codex mcp add freeposter --url http://localhost:4400/mcp               # Codex
```

Cursor, VS Code, Windsurf and others take it in their MCP settings file:

```json
{ "mcpServers": { "freeposter": { "type": "http", "url": "http://localhost:4400/mcp" } } }
```

By default the server is **lean**: it lists just two tools, `fp(op, args)` and `fp_help(op | topic)`, and a short set of instructions. Every FreePoster op still works through `fp` (several at once with `calls`, a few result fields with `fields`), and `fp_help` shows the op index, one op's arguments, or a guide. Clients that want every tool typed ask for it in the URL:

| URL | What the agent sees |
|---|---|
| `/mcp` (or `?profile=lean`) | `fp` and `fp_help` |
| `/mcp?profile=full` | every tool with its full schema and the full instructions |
| `/mcp?tools=claim_brief,submit_brief` | exactly those tools, typed (an unknown name is refused, listing the valid ones) |

In lean mode every op sits behind the one `fp` tool, so a client's per-tool permission ("always allow") covers all of them; nothing posts without your tap on Approve either way, and `?profile=full` keeps a permission prompt per op.

Every tool can be called by name on every profile, listed or not. What each costs a session (characters, about 4 per token):

| Profile | Instructions + tool list | About |
|---|---|---|
| `full` (how it was) | 41,769 chars | 10.4k tokens |
| lean (default) | 1,988 chars | 0.5k tokens |
| `?tools=` the five brief tools | 4,403 chars | 1.1k tokens |

The other sizes, measured the same way and held by `test/token-budget.test.ts`:

| What | Size | Budget |
|---|---|---|
| `GET /agent/v1` (every op, one line each) | 4,943 chars | 5,000 |
| `POST /agent/v1/list_accounts` with one account | 335 chars | 400 |
| any one op's doc (`GET /agent/v1/<op>`) | at most 4,000 chars | 4,000 |

An agent that only runs local commands can use `npx mcp-remote http://localhost:4400/mcp`. If you set an app password, agents send it as HTTP Basic auth (any user name).

The server also offers two **prompts**, which agents that support prompts show as ready-made requests (often slash commands):

- `check_freeposter`: catch up on everything that happened and act on it.
- `handle_redo` (`review_id`): make the change you asked for on a review.

## 2. The event feed

Most agents only run while you're talking to them, so they can't take a webhook. FreePoster keeps a log of everything that happens instead, for a week, and agents read it with two tools:

- **`list_events`** returns the events no agent has read yet (or, with `since`, every event after that id). Agents call it when you come back to them, so nothing that happened in between is missed.
- **`wait_for_events`** does the same, but if there's nothing yet it waits (up to 50 seconds a call) and returns the moment something happens. Agents use it to follow a render or a review without calling `get_*` over and over.

Each event has an `id`, `event_type`, `at`, a one-sentence `summary` the agent can pass on, and the ids to follow up (`review_id`, `edit_id`, `production_id`, `post_id`):

| Event | When |
|---|---|
| `production.ready`, `production.failed` | A production finished rendering, or couldn't. |
| `edit.ready`, `edit.failed` | An edit finished, or couldn't. |
| `review.waiting` | A review reached you. |
| `review.approved`, `review.rejected` | You decided. |
| `review.redo` | You asked for changes. `handled_by` is `"freeposter"` when FreePoster makes the new version itself, `"agent"` when it's the agent's to make. |
| `review.failed`, `review.expired` | A review couldn't be made or posted, or ran out of time. |
| `post.done` | Every account has posted (or failed), with the links. |

The MCP server's instructions tell the agent what to do with each one.

**Redos nobody picks up.** When you ask for a change that's the agent's to make, `list_reviews` with `needs_agent: true` lists it until a new version exists. If no agent has read it within 10 minutes (through the feed, the webhook, or `get_review`), FreePoster tells you once on Telegram, under the review, so it never stalls silently. Ask your agent to "check FreePoster" and it picks it up.

## 3. A webhook (optional)

If your agent runs all the time and takes webhooks (Hermes Agent, n8n, a server of your own), FreePoster can push each event to it as well. Set it in **Setup → Production tools → Your agent**:

- **Webhook address**: where to POST each event (JSON, the same fields as the feed, minus `id`).
- **Webhook secret**: any long random text, also given to the receiver.

Each delivery is signed twice with that secret, so most receivers can check it as they stand:

- **[Standard Webhooks](https://www.standardwebhooks.com/)**: `webhook-id`, `webhook-timestamp`, and `webhook-signature: v1,<base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<body>">`. A secret starting `whsec_` is base64 after the prefix, as the spec says. Anything else is used as plain text.
- **The plain scheme**: `X-Webhook-Timestamp` and `X-Webhook-Signature-V2: <hex HMAC-SHA256 of "<timestamp>.<body>">`.

Failed deliveries are retried with backoff, 5 times in all. Events that happened while no webhook was set aren't pushed later: agents read those from the feed.

## 4. Reviews on Telegram

Set this up in **Setup → Production tools → Review on Telegram**. Each review arrives as the video, who it posts to and when, the caption, the file's fingerprint, and **Approve**, **Reject** and **Redo** buttons. There are two ways to set it up.

### A separate bot (works with any agent)

Make a bot with @BotFather, choose **A separate bot only FreePoster uses**, paste its token, and send it the 6-digit code. FreePoster reads that bot's messages itself, so taps never pass through any agent.

### The bot your agent already uses (one chat)

If your agent already talks to you through a Telegram bot and you want reviews in that chat, choose **The bot my agent already talks to me through**. Telegram lets only one program read a bot's messages, and that's your agent, so it has to pass FreePoster's part of them on. This is the **relay**:

1. **Which updates.** Only these: callback queries whose `data` starts with `fp:`; text messages replying to a bot message that starts with `🔁 FreePoster redo`; the `/freeposter` command (pairing); and the `/stop` command (the campaigns' kill switch). Everything else stays your agent's.
2. **Where.** POST each one, as the raw Telegram update JSON, to `http://localhost:4400/api/telegram/relay`. Setup shows the address, and **Show the relay secret** gives the secret.
3. **Signed.** Sign the exact body bytes with the relay secret, either way the webhook is signed: `X-Webhook-Timestamp` + `X-Webhook-Signature-V2`, or Standard Webhooks headers. Timestamps more than 5 minutes off are refused.
4. **Pair.** Send `/freeposter <code>` to the bot in your private chat with it. `/stop` works the same way: forward it and FreePoster stops every campaign (only the window resumes them).

A tap counts only when Telegram itself confirms it (FreePoster calls `answerCallbackQuery`, which only succeeds for a tap Telegram really delivered). It must also come from your account in your chat, carry the current buttons' one-time code, and the review must still be waiting. So a relay that's tampered with can't approve anything with a made-up tap.

Hermes Agent has this relay ready-made as a plugin ([hermes.md](hermes.md#reviews-on-hermess-telegram-bot)). For another agent, a relay is a few lines in whatever plugin or handler system it has. [templates/hermes/freeposter-review/__init__.py](../templates/hermes/freeposter-review/__init__.py) is a complete example.

### Redo

**Redo** asks what kind of change (cuts, captions, framing, sound, zooms, something else), then asks you to reply with a note (add a time like 0:14 for one spot). If you pick zooms, framing or sound with no note on a Drive video, FreePoster makes the new edit itself. Anything else goes to your agent as `review.redo`, with the time mapped to the source video and the words said there, and the new version comes back to you as a new review.

## 5. The command line

Every `freeposter` command is one call to the compact agent API (`/agent/v1`), so agents that only run shell commands get the same abilities, at the lowest token cost:

```bash
freeposter events                 # what happened since an agent last looked
freeposter events --watch         # keeps printing events as they happen (one JSON per line when piped)
freeposter reviews --needs-agent  # redos waiting for an agent
freeposter production 12 --watch
freeposter ops                    # every op with its arguments, one line each
freeposter help claim_brief       # one op's doc; `freeposter help events` prints a guide (rules events production campaigns limits)
freeposter get_post post_id=3     # any op as key=value (values are read as JSON when they parse, else text)
freeposter list_reviews needs_agent=true --fields reviews.id,reviews.state
freeposter call request_review '{"production_id":12,"caption":"123"}'   # a JSON object of arguments
```

`--fields` applies to the generic `<op>` form and to `call`; named commands (`events`, `production --watch` and the rest) always print whole results. In `key=value`, values are read as JSON when they parse, so `caption=123` sends the number 123; to force text or pass objects, use `call <op> '<json>'`.

The installed app ships the CLI in `%LOCALAPPDATA%\Programs\FreePoster\resources\app.asar.unpacked\cli\`. Add that folder to your PATH, or from a source checkout run `npm run cli -- <command>`. `freeposter help` lists the commands. It needs Node 24 or later on PATH.

`freeposter audit` (or the `audit_reviews` tool) checks every published post: each one an agent asked for was approved by you before it was made, and every account uploaded the exact file you approved.

## 6. Making campaign films

A campaign row can ask your agent to make the film, in one of the Lemo styles of the lemo-opuscar skill. FreePoster writes a **brief** and your agent makes the film; FreePoster doesn't edit a Lemo film afterwards. It reviews it and sends it to you on Telegram like any other campaign video. The agent never posts, schedules or labels anything, and `request_review` keeps refusing these videos.

Once, and again whenever the skill's library changes, the agent can tell FreePoster which Lemo styles it offers. FreePoster also reads the library on this computer (`$LEMO_OPUSCAR_HOME`, else `~/lemo-opuscar`) at startup and when the Campaigns tab opens, so this is only needed for a library kept elsewhere:

- `sync_looks` (`producer: "lemo-opuscar"`, `library_version`, `looks`, the API name for the list of Lemo styles: each with `key` like `lemo:impasto-oil`, `name`, `description`, `needs_image_gen`). Send the whole list: a style left out is hidden, not deleted, so videos already labelled with it keep their name.

When a brief is due, FreePoster logs `brief.requested` (a film is wanted) or `brief.expired` (the agent holding it ran out of time and it's offered again). When Setup's **Start Claude for campaign films** is on, these events carry `handled_by: "freeposter"`: FreePoster starts Claude for the brief itself, so another agent shouldn't claim it. Otherwise the agent:

1. **Claims** it with `claim_brief` (`task_id`; `list_briefs` shows the open ones). The brief is the `look` (the Lemo style key), hook, angle, cta (`text`, `url`), `sec` (length in seconds, or null), `instructions`, `language`, `needs_image_gen`, `deadline`, `post_at`, `script` and `model`. `script` is the script FreePoster wrote for a Create row; `model` is the Claude model the row chose, or null. The claim is a lease of up to two hours, never past the deadline, and comes with a `claim_token`: `renew_brief`, `submit_brief` and `give_up_brief` need it, so two agents under the same client name can't both hold a brief. A brief can be offered twice; after that the task fails.
2. **Makes the film** with the lemo-opuscar skill, using the brief's `look`, language and instructions as the answers to the skill's questions. It doesn't ask you anything. When the brief has a `script`, the agent films that script as written and doesn't write another; FreePoster adds no voiceover or music. When `script` is null, the agent writes its own treatment. It uses the brief's `model` when there is one. If `needs_image_gen` is true and the agent has no image generator, it calls `give_up_brief` at once.
3. **Renews** with `renew_brief` at least every 30 minutes while it works; a lease that runs out frees the brief.
4. **Delivers** with `submit_brief` (`task_id`, `claim_token`, `video_path`, `library_version`, optionally `treatment_path`, `caption`, `title`). The film is in the brief's Lemo style; the agent doesn't choose it. The agent writes the caption and title: the only link allowed in them is the brief's CTA link, and when there is one the caption must include it. Delivering the same file again is harmless.

The file must be portrait 9:16, pass FreePoster's usual video checks, and last within 20% (at least 2 seconds) of the brief's `sec` when it has one. A video that fails comes back as an error saying why, and the agent can fix and deliver again before the deadline. The deadline is 30 minutes before the post time, so you have time to review; a brief with no post time is due within a day. If nothing arrives by then, the slot is skipped.

If it can't make the film, the agent calls `give_up_brief` with a reason: the task fails and you get a Telegram message saying the agent gave up and why.

If you tap Redo on an agent film, FreePoster gives the agent a new round of the brief, with your note added to its instructions, for the same slot (the `review.redo` event says `handled_by: "freeposter"`).
