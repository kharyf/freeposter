# FreePoster

Upload one short vertical video once; FreePoster publishes it to **TikTok, Instagram Reels, Facebook Page Reels, X, and YouTube Shorts** through each platform's official publishing API. No browser automation, no "copy this caption" step.

## Desktop app (Windows)

FreePoster is a standalone app (Electron) with its own window, icon and taskbar entry.

```bash
npm install
node node_modules/electron/install.js   # only if npm skipped Electron's download (install scripts disabled)
npm run build:app       # → dist/FreePoster-Setup-<version>.exe, the installer
npm run desktop         # or: run the app from source, without packaging
```

Run `dist/FreePoster-Setup-<version>.exe`. It installs FreePoster for your Windows user (no admin prompt) and adds it to the Start menu and desktop; uninstall it from Windows Settings → Apps. `dist/win-unpacked/FreePoster.exe` is the same app without installing. Closing the window, or pressing **Quit**, stops it. Launching it again while it runs brings its window forward.

If you run the build from a VS Code terminal, it sets `ELECTRON_RUN_AS_NODE=1`, which makes `FreePoster.exe` start as plain Node. Unset it before launching the built app from that terminal.

The first time, a **setup screen** asks for everything FreePoster needs. It starts by making your own redirect URI on Cloudflare (free), checks ffmpeg, then walks through each platform's developer console with that redirect URI to register, takes the keys, and ends with connecting your accounts. Skip any platform you don't use; reopen it any time with **Setup**.

**Connecting accounts happens in your web browser**, because Google, Meta and others refuse to let you sign in to them inside app windows. Press **Connect**, sign in on the page that opens, and the FreePoster window updates by itself; the browser tab can be closed.

The app keeps its settings and data in `%APPDATA%\FreePoster` (`.env`, `data/`, and `data/freeposter.log`). Uninstalling or upgrading leaves that folder in place, and running from source (`npm start`, `npm run desktop`) uses the same folder, so your connected accounts carry over whichever way you run or update FreePoster. Set `FREEPOSTER_HOME` to use a different folder. `ffmpeg`/`ffprobe` must be installed (on PATH, or their paths entered in setup).

### Windows says it's protected your PC?

FreePoster's installer isn't code-signed, so Windows doesn't know who made it and warns you the first time you run it. To install anyway:

1. If your browser says the file isn't commonly downloaded, choose **Keep**.
2. When the blue "Windows protected your PC" box appears, click **More info**, then **Run anyway**.

Windows 11 with **Smart App Control** turned on blocks unsigned apps without offering **Run anyway**, and work or school computers may do the same.

To check your download, compare its hash with `SHA256SUMS.txt` on the release page. To go further, the GitHub CLI can confirm the file was built by this repository's GitHub Actions from its public source:

```powershell
Get-FileHash .\FreePoster-Setup-<version>.exe   # must match the line for this file in SHA256SUMS.txt
gh attestation verify .\FreePoster-Setup-<version>.exe --repo kharyf/freeposter   # optional, with the GitHub CLI
```

## Run from source

Requires Node 24+ (uses built-in SQLite and TypeScript) and `ffmpeg`/`ffprobe` on PATH.

```bash
npm install
npm start               # http://localhost:4400 (or: npm run desktop, to open it in an app window)
npm test                # units, ffmpeg renders, runner, per-platform API contracts, setup, end-to-end
```

Open the page and follow the setup screen (or copy `.env.example` to `.env` and fill it in by hand). Then pick a video, write the caption, tick the accounts, and press **Publish**. Each platform's status updates live, and ends with the post's link or the platform's own reason for rejecting it.

## Use it from AI agents (MCP)

FreePoster has an [MCP](https://modelcontextprotocol.io) server built in: whenever the app runs, any agent that speaks MCP (Claude Code, Claude Desktop, Codex, Cursor, VS Code…) can check your accounts and post for you at

```
http://localhost:4400/mcp
```

The main window's **AI agents** panel shows this address and the line to add it to each agent, for example:

```bash
claude mcp add --transport http freeposter http://localhost:4400/mcp
```

For apps configured with a JSON file: `{"mcpServers": {"freeposter": {"type": "http", "url": "http://localhost:4400/mcp"}}}`. An agent that only runs local (stdio) servers can reach it through `npx mcp-remote http://localhost:4400/mcp`.

| Tool | What it does |
|---|---|
| `list_accounts` | Connected accounts and their ids, per-platform length and caption limits, which platforms are set up (with a link to connect more) |
| `get_tiktok_creator_info` | A TikTok account's live privacy options and locked interaction settings, for the user to choose from |
| `publish_video` | Posts a file from this computer to chosen accounts, now or at `schedule_at` (ISO 8601). Runs every check the window does first; `dry_run` checks without queueing |
| `get_post` / `list_posts` | Each account's job state, the published post's link, or the platform's reason for refusing it |
| `reschedule_post` / `cancel_post` | Move, post early, or cancel a post that hasn't started going out |
| `retry_job` | Try a failed account again from where it stopped |

It deliberately can't read or change settings, keys or tokens, or connect and remove accounts: those stay in the window. It speaks MCP's Streamable HTTP transport (protocol 2025-03-26 through 2025-11-25), statelessly with plain JSON responses: `publish_video` returns at once and the job runner does the posting, as it does for the window. It only answers on this computer: requests from web pages (any `Origin` other than FreePoster's own) and from other host names are refused, and with an app password set, agents must send it as HTTP Basic auth.

## Your redirect URI (one time, in setup's first step)

After you connect an account, the platform sends your browser back to an **https** address you registered with it, and TikTok (sometimes Meta) won't accept `http://localhost`. So each FreePoster user has their own small static page, made from the templates in [redirect-page/](redirect-page/), that forwards the platform's response to `http://localhost:<port>/callback` on their own computer. It reads the port from the `state` parameter (FreePoster starts every connection with `state=<port>.<random>`). It forwards nowhere else, stores nothing, and loads nothing from other sites. The authorization code it passes along is useless without your app secret and PKCE verifier, which never leave your computer.

The same site hosts your **Terms of Service** and **Privacy Policy** (`/terms`, `/privacy`), which TikTok's developer portal asks for.

Setup's first step does all of it:

1. Enter the name (or business name) and contact email to show on the Terms and Privacy pages.
2. Press **Make the folder**. FreePoster writes the pages, with your details filled in, to `data/redirect-page/`.
3. In the Cloudflare dashboard (free account): **Workers & Pages → Create → Pages → Upload assets**, name the project (the name becomes `https://<name>.pages.dev`), drag the folder in, and press **Deploy**.
4. Paste the address back into FreePoster. It opens the page to check it, then shows it as the redirect URI in every platform step, and `<address>terms` / `<address>privacy` in the TikTok step.

If TikTok asks you to verify those URLs, add its `tiktok….txt` file in the TikTok step; FreePoster keeps it in the folder, and you upload the folder again as a new deployment. If you change your name or email, make the folder and upload it again.

Prefer no page? Under **Use a tunnel instead** in that step (or `REDIRECT_PAGE_URL=off` in `.env`), redirect URIs are `{BASE_URL}/callback/{platform}`, with a tunnel where https is required.

## Platform setup (one time)

Register your redirect URI from above (or, with a tunnel, `{BASE_URL}/callback/{platform}`) as each app's redirect URI.

| Platform | App / product | Scopes requested | Account requirement |
|---|---|---|---|
| YouTube | Google Cloud OAuth client (Web), YouTube Data API v3 enabled | `youtube.upload`, `youtube.readonly` | A channel. Unaudited projects: uploads are forced private. |
| TikTok | Login Kit + Content Posting API (Direct Post) | `user.info.basic`, `video.publish` | Unaudited apps can only post `SELF_ONLY`. |
| Instagram | Meta Business app: Facebook Login for Business + Instagram API with Facebook Login | `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management` | Business/Creator account **linked to a Facebook Page** |
| Facebook | Same Meta app | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management` | A **Page** (profiles can't be posted to via API) |
| X | OAuth 2.0 "Web App" client | `tweet.read tweet.write users.read media.write offline.access` | API tier that permits posting |

With a tunnel instead of a redirect page, if a console refuses `http://localhost` redirect URIs, run a tunnel (e.g. `cloudflared tunnel --url http://localhost:4400`), set `BASE_URL` to the https address, and set `APP_PASSWORD`. The app refuses to start on a public URL without one.

## How it works

- **One render for all platforms.** ffmpeg normalizes any input to 1080×1920, H.264 High, 30 fps, AAC 48 kHz stereo, faststart. Wrong aspect ratios are letterboxed and silent clips get a silent track. The render is verified with ffprobe before any upload.
- **Rejected before upload, not after.** Caption limits (X 280 weighted chars, TikTok/IG 2200, IG 30 hashtags), per-platform durations (FB Reels 3–90 s, X 140 s, Shorts 180 s, TikTok per-account max), and TikTok privacy rules are checked when you press Publish.
- **Scheduling.** Choose *Schedule for* to post at a set time (up to a year ahead). Upcoming posts can be moved, posted early, or cancelled until they start going out. FreePoster has to be running at that time; a post whose time passed while it was closed goes out as soon as it starts. In the desktop app, closing the window while posts are scheduled keeps FreePoster running in the system tray until they're out; click the tray icon (or open the app again) to get the window back.
- **Default accounts.** Videos that arrive without you at the screen (from Google Drive) go to the accounts ticked **Default** under Accounts. At first that's the first account you connected on each platform; change it any time. Drive only hands FreePoster the files.
- **Titles and captions on the AI plan you already pay for.** Connect one or more providers under **AI Providers** on the main screen. Each runs the program that comes with your plan, signed in on this computer, so it counts against your plan's usage, not an API bill:

  | Provider | Program | Plans | Looks at images (silent videos) |
  |---|---|---|---|
  | Claude | [Claude Code](https://claude.com/claude-code) (`claude -p`) | Pro, Max | yes |
  | ChatGPT | [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) (`codex exec`) | Plus, Pro, Business | yes |
  | Google AI (Gemini) | [Antigravity CLI](https://antigravity.google/docs/cli/) (`agy -p`) | AI Pro, AI Ultra | no |
  | GitHub Copilot | [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) (`copilot -p`) | Pro, Pro+ (premium requests) | yes |
  | Cursor | [Cursor CLI](https://cursor.com/cli) (`cursor-agent -p`) | Pro, Pro+, Ultra | no |
  | Grok *(experimental)* | [Grok Build](https://docs.x.ai/build/overview) (`grok`) | SuperGrok, SuperGrok Heavy | no |
  | Muse Code *(experimental)* | [Muse Code](https://dev.meta.ai) (`muse exec`) | Everyday, High, Power, Maximum | no |

  Or connect [OpenRouter](https://openrouter.ai), which you sign in to from FreePoster and which is paid per use from your OpenRouter credits; the panel shows your balance, each job's estimated cost and what each use actually cost. Connect asks the provider a tiny test question first. Each job (captions from speech, captions from still frames, spotting song lyrics) asks your providers in the order you set, and moves on to the next when one fails or is out of plan usage. If none can answer, the caption is `#fyp` and you can change it under Upcoming. Each caption uses roughly 1–2k tokens.
- **Meta's automatic sharing.** If Meta shares your Instagram posts to the linked Facebook Page (or the reverse), tick that under the Instagram account. FreePoster then never posts to the receiving account itself, so nothing goes up twice.
- **One job per (post, account).** Each job runs independently: a platform failing never blocks the others.
- **Never posts twice.** Every step saves a checkpoint (upload session, container id, byte offset). A crash or retry resumes from there. If the final "publish" request was sent but its response was lost, the job looks the post up on the platform instead of publishing again. Re-uploading the same file to the same account asks first.
- **Retries:** network errors, 5xx and 429 retry with backoff (30 s → 30 min, 6 attempts). Policy/spec errors fail immediately with the platform's message. "Still processing" re-checks without using attempts.
- **Tokens:** encrypted at rest (AES-256-GCM, key in `data/secret.key`), refreshed before expiry and swept every 6 h. A 401 triggers one refresh, then asks you to reconnect.
- **Daily caps** (`DAILY_CAP_*`): over-cap jobs wait for the rolling 24 h window instead of failing.
- **TikTok UX compliance:** the post form is built from live `creator_info` (nickname, allowed privacy levels with no default, interaction toggles off by default and locked when disabled on the account, commercial content disclosure, Music Usage / Branded Content consent), as TikTok's audit requires.

## Where things live

```
src/main.ts            startup (server only)
src/desktop.ts         the desktop app (Electron): window, tray, single instance, sign-ins via the browser
src/app.ts             shared startup: database, server, job runner
src/config.ts          settings from .env; the setup screen saves back to it
src/server.ts          HTTP routes: setup, OAuth connect/callback, upload, history, retry
src/posts.ts           checks and queues a post; shared by the upload route and the MCP server
src/accounts.ts        default accounts, and Meta's automatic sharing between linked accounts
src/redirect-page.ts   makes the redirect page folder and checks the address it went live at
src/mcp.ts             the MCP server at /mcp, for AI agents
src/runner.ts          job loop, retries, quotas, token refresh
src/media.ts           ffprobe + ffmpeg render and spec check
src/db.ts              SQLite (data/freeposter.db)
src/platforms/*.ts     one module per platform, against its official API
public/index.html      the UI, including the setup screen
redirect-page/         templates for each user's redirect page, Terms and Privacy (made in setup; see above)
scripts/build-app.ts   bundles the desktop app and builds the installer, dist/FreePoster-Setup-<version>.exe
scripts/checksums.ts   writes dist/SHA256SUMS.txt for the installer
scripts/icon.ts        draws the app icon
.github/workflows/release.yml   builds, tests and attests a release when a version tag is pushed
```

## Making a release

Releases are built by GitHub Actions from a clean checkout, never on your own machine, so nothing local (your `.env`, `data/`) can end up in them.

```bash
npm version 1.0.0        # sets the version in package.json and creates the tag v1.0.0
git push --follow-tags   # the tag starts .github/workflows/release.yml
```

The workflow tests the code, then builds the installer, `SHA256SUMS.txt` and the build attestation. It puts them on a **draft** release with notes made from the commits since the last release. Read the draft under **Releases**, edit the notes if you like, and press **Publish**. A tag that doesn't match `package.json`'s version stops the workflow before it builds anything.
