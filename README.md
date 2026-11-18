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

The tab also compares **labels** (hook, angle, CTA, style, type) by median score, with an interval and the number of videos. A label shows "enough" once it has n ≥ 3 videos. For videos you record yourself, hooks, angles and CTAs are tracked as labels you pick or name; FreePoster never generates them over your footage.

> [!IMPORTANT]
> Reading metrics needs new platform permissions (TikTok `video.list`, Instagram `instagram_manage_insights`, Facebook `read_insights`, X `tweet.read`, YouTube `yt-analytics.readonly`). **Existing accounts must sign in again** to grant them.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Campaigns

Write your week in free-form text ("On Sunday make and post …") in the Campaigns tab.

- **Translated once, then confirmed.** Plain code reads the text first; at most one AI call handles the lines it couldn't read. A confirm table follows, and **nothing runs until you confirm**.
- **"make" without "post"** means the video is made, approved and kept in the library.
- **Post lines** use the `{name}_{time}_{style}` file names.
- **Rules live in the text**, e.g. "When analytics show a hook is working, make 3 variants".
- **Types.** Define your own video types. A type can be allowed to post without approval; everything else waits for your approval.
- **Daily post cap** (3 by default).
- **Autorun** is off by default. When on, the connected agent may change that campaign within limits: it can't change CTAs or use one the campaign doesn't already use, can't attach a type that posts without approval, can only lower the daily cap, and can't switch Autorun or the campaign on or off. Every change comes with a reason and can be undone.
- **Stop everything.** Send `/stop` on Telegram or use the window. Only the window resumes.

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

The app's **AI agents** panel shows the setup line for each agent. It works the same with any agent: they hear what happened through FreePoster's event feed (`list_events`, `wait_for_events`), with an optional webhook for agents that run all the time. Prefer a terminal? Run `freeposter help`. Analytics and campaign tools: `get_analytics`, `get_video_metrics`, `list_campaigns`, `get_campaign`, `update_campaign`, `list_library`, `add_library_entry`, `stop_campaigns`. See [docs/agents.md](docs/agents.md) for the event feed, webhooks and reviews on Telegram, and [docs/hermes.md](docs/hermes.md) for Hermes Agent.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Run from source

Requires Node 24+ and `ffmpeg`/`ffprobe` on PATH.

```bash
npm install
npm start           # http://localhost:4400
npm run desktop     # same app, in its own window
npm run build:app   # builds the Windows installer
npm test
node scripts/backtest.ts          # how well 24h/72h scores predict later ones (read-only)
node scripts/reconcile.ts --n 10  # compares the tab's 7d views with a fresh platform read
```

Releases are built and attested by GitHub Actions: `npm version <x.y.z> && git push --follow-tags`.
