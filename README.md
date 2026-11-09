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
- **You approve what agents post.** An agent can only ask: you get the exact file on Telegram (or in the window) with Approve, Reject and Redo, and only your tap posts it.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Get started

Download `FreePoster-Setup-<version>.exe` from **[Releases](https://github.com/kharyf/freeposter/releases)** and run it.

> [!NOTE]
> The installer isn't code-signed. If Windows warns you, click **More info → Run anyway**. Verify the download against `SHA256SUMS.txt` on the release page.

The first launch opens a **setup screen** that walks you through your free Cloudflare redirect page, ffmpeg, each platform's developer keys, and connecting your accounts. Skip any platform you don't use.

Settings and data live in `%APPDATA%\FreePoster`.

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Use it from AI agents

While the app runs, any MCP agent can check accounts, post, schedule and produce videos at:

```
http://localhost:4400/mcp
```

```bash
claude mcp add --transport http freeposter http://localhost:4400/mcp
```

The app's **AI agents** panel shows the setup line for each agent. Prefer a terminal? Run `freeposter help`. For webhook-driven agents and reviews on Telegram, see [docs/hermes.md](docs/hermes.md).

<img src="docs/assets/divider.svg" width="100%" height="6" alt="">

## 🔷 Run from source

Requires Node 24+ and `ffmpeg`/`ffprobe` on PATH.

```bash
npm install
npm start           # http://localhost:4400
npm run desktop     # same app, in its own window
npm run build:app   # builds the Windows installer
npm test
```

Releases are built and attested by GitHub Actions: `npm version <x.y.z> && git push --follow-tags`.
