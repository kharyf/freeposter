<h1 align="center">
  <img src="docs/assets/icon.svg" width="72" height="72" alt="" align="center">&nbsp;FreePoster
</h1>

<p align="center">
  <b>Upload one vertical video. Publish it everywhere.</b><br>
  Official APIs only: no browser automation, no copy-paste.
</p>

<p align="center">
  <img src="docs/assets/badges/tiktok.svg" alt="TikTok">
  <img src="docs/assets/badges/instagram.svg" alt="Instagram Reels">
  <img src="docs/assets/badges/facebook.svg" alt="Facebook Reels">
  <img src="docs/assets/badges/x.svg" alt="X">
  <img src="docs/assets/badges/youtube.svg" alt="YouTube Shorts">
</p>

<p align="center">
  <img src="docs/assets/badges/windows.svg" alt="Windows desktop app">
  <img src="docs/assets/badges/mcp.svg" alt="MCP built in">
  <img src="docs/assets/badges/node.svg" alt="Node 24+">
</p>

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 What it does

- **One render, every platform.** ffmpeg normalizes your clip to 1080×1920 and checks it before upload.
- **Caught before posting.** Caption, hashtag, duration and TikTok privacy rules are checked when you press Publish.
- **Never posts twice.** Every step is checkpointed; crashes and retries resume where they stopped.
- **Schedule** posts up to a year ahead.
- **AI captions** on the plan you already pay for (Claude, ChatGPT, Gemini, Copilot, Cursor) or OpenRouter.
- **Productions:** render new videos from shots (HyperFrames, WanGP, Blender) on your own machine.
- **You approve what agents post.** An agent can only ask: you get the exact file on Telegram (or in the window) with Approve, Reject and Redo. Everything waits for your approval unless you let a type post on its own.
- **See what works.** The Analytics tab scores every video against your own history, and the Campaigns tab runs your weekly posting plan from plain text.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Get started

Download `FreePoster-Setup-<version>.exe` from **[Releases](https://github.com/kharyf/freeposter/releases)** and run it.

> [!NOTE]
> The installer isn't code-signed. If Windows warns you, click **More info → Run anyway**. Verify the download against `SHA256SUMS.txt` on the release page.

The first launch opens a **setup screen** that walks you through your free Cloudflare redirect page, ffmpeg, each platform's developer keys, and connecting your accounts. Skip any platform you don't use.

Settings and data live in `%APPDATA%\FreePoster`.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Analytics

FreePoster reads each post's metrics from the platforms and scores every video at **24h, 72h and 7d**. A score is a percentile (0 to 100) against that account's own recent videos, compared at the same age, so a small account is never judged against a big one. A score is marked **provisional** while the account has fewer than 8 baseline videos.

The tab also compares **labels** (hook, angle, CTA, style, type, Lemo style, producer) by median score, with an interval and the number of videos. A label shows "enough" once it has n ≥ 3 videos. For videos you record yourself, hooks, angles and CTAs are tracked as labels you pick or name; FreePoster never generates them over your footage.

> [!IMPORTANT]
> Reading metrics needs new platform permissions (TikTok `video.list`, Instagram `instagram_manage_insights`, Facebook `read_insights`, X `tweet.read`, YouTube `yt-analytics.readonly`). **Existing accounts must sign in again** to grant them.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Campaigns

Each campaign is a table in the Campaigns tab, one row per kind of video. Press **+** (Add Video) for a new row. Changes to the table are kept in the window until you press **Save Changes** (next to Stop Campaign); until then the campaign runs on the table as last saved. The account set and Autorun still save at once. A green pulsing dot means the campaign is running; a red dot means it's stopped.

- **Columns:** Origin, Model, Quantity (1–10), Hook, Angle, CTA (Random, Best performing, or one from the library), Editing Style, Type, Time (hour, minute, AM/PM), Days (S M T W T F S), Length (5–300 seconds), and File Name / Instructions.
- **Origin.** *Create* makes a video from the row. Its Instructions column holds extra direction for the script. *Drive* posts a recorded file from your Drive folder. Its File Name is the `{name}` part of `{name}_{time}_{style}`. On a Drive row, the hook, angle, CTA and length only label the video for analytics, and Quantity is ignored. *Agent* has a connected agent (Claude with the lemo-opuscar skill) make the film in the Lemo style you pick. Its Instructions column is direction for the agent.
- **Model.** The AI model that writes for the row. On a Create row it can be "Use AI settings", or one model you pick. On an Agent row it can be "Default (Claude Code's setting)", which runs on the model Claude Code is set to, or one Claude model.
- **Editing Style.** Your own editing styles, plus the Lemo styles. A Lemo style needs a Claude model: the Claude provider, not OpenRouter's Anthropic models. A Create row with a Lemo style has FreePoster write the script with the row's model, then Claude Code films that script as written, with no FreePoster voiceover or music. An Agent row takes only Lemo styles and Claude models, and Claude writes its own treatment. A Drive row can't use a Lemo style. FreePoster never edits a Lemo film afterwards: Lemo does its own captions and sound.
- **How an Agent row's brief works.** FreePoster offers the brief 6 hours before the slot, and an agent claims it for up to 2 hours at a time. If nothing has arrived 30 minutes before the slot, that slot is skipped. A Create row with a Lemo style doesn't wait or get skipped: like any Create video, its script is written and its brief goes out at once. It's due within a day, and if the film arrives after its slot, it posts once you approve it. You still approve every post. Turn on **Start Claude for campaign films** in Setup to have FreePoster start Claude on this computer when a brief is due. The launched Claude can run commands on this computer, as it does when you use it yourself. While Claude makes a film it holds the GPU, so Create videos and their voice and music wait until it's done.
- **Lemo styles.** FreePoster reads the Lemo catalogue itself from the library on this computer (`$LEMO_OPUSCAR_HOME`, else `~/lemo-opuscar`), at startup and when the Campaigns tab opens. Agents that keep their library elsewhere can still send it with `sync_looks`. Lemo styles fill the Editing Style menu, show up in Analytics, and don't appear on the Editing Styles tab. A row whose Lemo style has gone from the catalogue says so and doesn't run.
- **A time already passed today** (or this very minute) is next week's: a row added or changed late runs today only if its time is at least a minute away. A video that missed its slot today is made again if you move its row to a time still ahead.
- **No time** on a Create row means the video is made, approved and kept in the library, not posted. A Drive row needs a time.
- **A row runs once it's complete.** It needs at least one day ticked, a length (Create and Agent), a Lemo style (Agent), and a file name and time (Drive). A row that can't run is listed under "Not running yet" with the reason.
- **Types.** Define your own video types. A type can be allowed to post without approval; everything else waits for your approval.
- **Stop Campaign / Start Campaign.** Stop Campaign is the red button on each campaign. It holds that campaign's scheduled posts and makes nothing new. Start Campaign lets the held posts go out again.
- **Autorun** is off by default. When on, the connected agent may change that campaign's table within limits. It can't change CTAs or use one the campaign doesn't already use. It can't attach a type that posts without approval, start or stop the campaign, or switch Autorun. Every change comes with a reason and can be undone.
- **Stop everything.** Send `/stop` on Telegram (or an agent calls `stop_campaigns`). Only the window's Resume starts them again.

Generated videos use **WanGP** for video, speech and music (music is mixed at -18 dB). Choose its models in Setup, or set `WANGP_MODEL`, `WANGP_SPEECH_MODEL`, `WANGP_AUDIO_MODEL` and `WANGP_PRESENTER_MODEL`.

**AI budget:** campaign, script and label jobs share 50 calls and 200k tokens a day (`src/ai/budget.ts`); normal captioning isn't counted.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Use it from AI agents

While the app runs, any MCP agent can check accounts, post, schedule and produce videos at:

```
http://localhost:4400/mcp
```

```bash
claude mcp add --transport http freeposter http://localhost:4400/mcp
```

Agents with a shell can skip MCP: `GET /agent/v1` lists every op and `POST /agent/v1/<op>` runs one, or use the `freeposter` CLI. Over MCP the default is lean (two tools, `fp` and `fp_help`); add `?profile=full` for every tool typed, or `?tools=a,b,c` for a few.

The app's **AI agents** panel shows the setup line for each agent. It works the same with any agent: they hear what happened through FreePoster's event feed (`list_events`, `wait_for_events`), with an optional webhook for agents that run all the time. Prefer a terminal? Run `freeposter help`. Analytics and campaign tools: `get_analytics`, `get_video_metrics`, `list_campaigns`, `get_campaign`, `update_campaign`, `list_library`, `add_library_entry`, `stop_campaigns`. See [docs/agents.md](docs/agents.md) for the event feed, webhooks and reviews on Telegram, and [docs/hermes.md](docs/hermes.md) for Hermes Agent.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Run from source

Requires Node 24+ and `ffmpeg`/`ffprobe` on PATH.

```bash
npm install
npm start           # http://localhost:4401
npm run desktop     # same app, in its own window, titled "FreePoster (dev)"
npm run build:app   # builds the Windows installer
npm test
node scripts/backtest.ts          # how well 24h/72h scores predict later ones (read-only)
node scripts/reconcile.ts --n 10  # compares the tab's 7d views with a fresh platform read
```

**Using FreePoster while you develop it.** A source checkout is a separate copy from the installed app, so both run at once on one computer:

| | Installed app | Source checkout |
|---|---|---|
| Settings and data | `%APPDATA%\FreePoster` | `%APPDATA%\FreePoster-dev` |
| Address and MCP | `http://localhost:4400` | `http://localhost:4401` |
| Window | FreePoster | FreePoster (dev) |

Post with the installed app day to day. Update it by installing a newer release, or your own `npm run build:app` from a commit you trust. The checkout starts empty: connect test accounts, or run `npm run dev:copy-home` to copy the installed app's settings, accounts and media into it (`-- --replace` sets an existing development folder aside first). The copy never acts by itself: nothing is left queued to post, campaigns are off, Google Drive and Telegram are disconnected, and the agent webhook is cleared. X and TikTok accounts keep working there until their access token expires, then need reconnecting. Those platforms can rotate refresh tokens, and a refresh in one copy would sign the other out. To point an agent or the CLI at the checkout, use port 4401 (`FREEPOSTER_URL=http://localhost:4401`). `FREEPOSTER_HOME` picks a different folder for either copy.

Releases are built and attested by GitHub Actions: `npm version <x.y.z> && git push --follow-tags`.
