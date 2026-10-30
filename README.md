# FreePoster

Upload one short vertical video once; FreePoster publishes it to **TikTok, Instagram Reels, Facebook Page Reels, X, and YouTube Shorts** through each platform's official publishing API. No browser automation, no "copy this caption" step.

## Desktop app (Windows)

FreePoster is a standalone app (Electron) with its own window, icon and taskbar entry.

```bash
npm install
node node_modules/electron/install.js   # only if npm skipped Electron's download (install scripts disabled)
npm run build:app       # → dist/FreePoster-win32-x64/FreePoster.exe
npm run desktop         # or: run the app from source, without packaging
```

Run `dist/FreePoster-win32-x64/FreePoster.exe` (keep it with the rest of that folder; you can move the whole folder and pin the exe to Start or the taskbar). Closing the window, or pressing **Quit**, stops it. Launching it again while it runs brings its window forward.

The first time, a **setup screen** asks for everything FreePoster needs: it checks ffmpeg, then walks through each platform's developer console with the exact redirect URIs to register, takes the keys, and ends with signing in to your accounts. Skip any platform you don't use; reopen it any time with **Setup**.

**Signing in to accounts happens in your web browser**, because Google, Meta and others refuse sign-in inside app windows. Press **Connect**, sign in on the page that opens, and the FreePoster window updates by itself; the browser tab can be closed.

The app keeps its settings and data in `%APPDATA%\FreePoster` (`.env`, `data/`, and `data/freeposter.log`), separate from a source checkout's. `ffmpeg`/`ffprobe` must be installed (on PATH, or their paths entered in setup).

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

## Sign-in redirect page (one time, for whoever distributes FreePoster)

Platforms send the browser back to an **https** address after sign-in, and TikTok (sometimes Meta) won't accept `http://localhost`. Instead of every user running a tunnel, FreePoster uses a tiny static page, [redirect-page/](redirect-page/), hosted once. It forwards each sign-in to `http://localhost:<port>/callback` on the user's own computer, reading the port from the sign-in's `state` (FreePoster starts every sign-in with `state=<port>.<random>`). It forwards nowhere else, stores nothing, and loads nothing from other sites. The code it passes along is useless without the user's app secret and PKCE verifier, which never leave their computer.

The same site hosts FreePoster's **Terms of Service** and **Privacy Policy** (`terms.html`, `privacy.html`), which TikTok's developer portal asks for: `https://freeposter.pages.dev/terms` and `https://freeposter.pages.dev/privacy`.

1. Deploy the `redirect-page/` folder (all its files) as a static site:
   - **Cloudflare Pages** (free): dashboard → Workers & Pages → Create → Pages → *Upload assets*, name it (e.g. `freeposter-signin`), drop in the folder. You get `https://freeposter-signin.pages.dev`. The `_headers` file adds the security headers there.
   - **GitHub Pages** (free): put the files at the root of a repo's Pages branch. You get `https://<user>.github.io/<repo>/`.
2. Set `BUILT_IN_REDIRECT_PAGE` in [src/config.ts](src/config.ts) to that address and rebuild (`npm run build:app`).

FreePoster's page is live at **`https://freeposter.pages.dev/`**, and that's the built-in address. Users register it as the redirect URI on every platform, the setup screen shows it to them, and its Address step disappears. To try a different page without rebuilding, set `REDIRECT_PAGE_URL` in `.env`. Set `REDIRECT_PAGE_URL=off` for the older setup: redirect URIs of `{BASE_URL}/callback/{platform}`, with a tunnel where https is required.

## Platform setup (one time)

Register the redirect page address from above (or, without one, `{BASE_URL}/callback/{platform}`) as each app's redirect URI.

| Platform | App / product | Scopes requested | Account requirement |
|---|---|---|---|
| YouTube | Google Cloud OAuth client (Web), YouTube Data API v3 enabled | `youtube.upload`, `youtube.readonly` | A channel. Unaudited projects: uploads are forced private. |
| TikTok | Login Kit + Content Posting API (Direct Post) | `user.info.basic`, `video.publish` | Unaudited apps can only post `SELF_ONLY`. |
| Instagram | Meta Business app: Facebook Login for Business + Instagram API with Facebook Login | `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management` | Business/Creator account **linked to a Facebook Page** |
| Facebook | Same Meta app | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management` | A **Page** (profiles can't be posted to via API) |
| X | OAuth 2.0 "Web App" client | `tweet.read tweet.write users.read media.write offline.access` | API tier that permits posting |

Without the redirect page, if a console refuses `http://localhost` redirect URIs, run a tunnel (e.g. `cloudflared tunnel --url http://localhost:4400`), set `BASE_URL` to the https address, and set `APP_PASSWORD`. The app refuses to start on a public URL without one.

## How it works

- **One render for all platforms.** ffmpeg normalizes any input to 1080×1920, H.264 High, 30 fps, AAC 48 kHz stereo, faststart. Wrong aspect ratios are letterboxed and silent clips get a silent track. The render is verified with ffprobe before any upload.
- **Rejected before upload, not after.** Caption limits (X 280 weighted chars, TikTok/IG 2200, IG 30 hashtags), per-platform durations (FB Reels 3–90 s, X 140 s, Shorts 180 s, TikTok per-account max), and TikTok privacy rules are checked when you press Publish.
- **Scheduling.** Choose *Schedule for* to post at a set time (up to a year ahead). Upcoming posts can be moved, posted early, or cancelled until they start going out. FreePoster has to be running at that time; a post whose time passed while it was closed goes out as soon as it starts. In the desktop app, closing the window while posts are scheduled keeps FreePoster running in the system tray until they're out; click the tray icon (or open the app again) to get the window back.
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
src/mcp.ts             the MCP server at /mcp, for AI agents
src/runner.ts          job loop, retries, quotas, token refresh
src/media.ts           ffprobe + ffmpeg render and spec check
src/db.ts              SQLite (data/freeposter.db)
src/platforms/*.ts     one module per platform, against its official API
public/index.html      the UI, including the setup screen
redirect-page/         the hosted https page sign-ins return through (deploy once; see above)
scripts/build-app.ts   bundles the desktop app and packages it into dist/FreePoster-win32-x64/
scripts/icon.ts        draws the app icon
```
