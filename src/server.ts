import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountSets, createAccountSet, defaultAccountIds, deleteAccountSet, noteSignInSet, placeInSet, takeSignInSet, defaultTikTokPrefs, noteConnected, noteRemoving, setDefaultAccounts, renameAccountSet, setDefaultTikTokPrefs, setSharing, sharedFrom, sharingPairs, type Sharing } from "./accounts.ts";
import { findClaude } from "./claude.ts";
import { codeDir, config, dataDir, envFile, isConfigured, isLocalUrl, needsRedirectPage, redirectUri, saveSettings, setting, SETTINGS, type SettingKey } from "./config.ts";
import { randomToken } from "./crypto.ts";
import type { SignIn, Store } from "./db.ts";
import { registerMcp } from "./mcp.ts";
import type { Publisher } from "./platforms/base.ts";
import { creatorInfo } from "./platforms/tiktok.ts";
import { driveAuthorizeUrl, driveRedirectUri, exchangeDriveCode, folderIdFrom } from "./drive/client.ts";
import type { Intake } from "./drive/intake.ts";
import { parseEditSettings } from "./edit/settings.ts";
import { captionTopicFor, checkDraft, DuplicateError, editView, parseSchedule, postView, saveUpload, type Draft } from "./posts.ts";
import { acceptRedirect, addTikTokFile, checkRedirect, folderPath, makeFolder, redirectDone, tiktokFiles } from "./redirect-page.ts";
import type { Runner } from "./runner.ts";
import { PLATFORMS, type Platform } from "./types.ts";

const isPlatform = (p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p);

const setupMarker = () => join(dataDir, "setup-complete");

/** Resolves to the tool's version line, or null when it can't be run. */
const toolVersion = (bin: string, flag = "-version") =>
  new Promise<string | null>((done) =>
    !bin ? done(null) : execFile(bin, [flag], { timeout: 10_000, windowsHide: true }, (err, stdout) => done(err ? null : stdout.split("\n")[0].trim())),
  );

export interface ServerOptions {
  /** Present in the desktop app: lets the page shut FreePoster down. */
  onQuit?: () => void;
  /**
   * Present in the desktop app, whose sign-ins happen in the system browser: receives the result
   * (as the page's query string) so the app window can show it; the browser tab gets a short note.
   */
  onSignIn?: (query: string) => void;
  /** Present in the desktop app: shows a folder in Explorer. */
  showFolder?: (path: string) => void;
}

const NO_REDIRECT_PAGE = "Set up your own redirect URI first (Setup, step 1), so the platform has somewhere to send you back to.";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** What the system browser shows after a sign-in started from the desktop app. */
const signedInPage = (params: Record<string, string>) => `<!doctype html><meta charset="utf-8"><title>FreePoster</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#1c1b19}
@media(prefers-color-scheme:dark){body{background:#161615;color:#ecebe7}}h1{font-size:22px}.err{color:#d14b3f}</style>
${params.connected
  ? `<h1>Connected</h1><p>${esc(params.connected)}</p>`
  : `<h1 class="err">Sign-in didn't finish</h1><p>${esc(params.error ?? "")}</p>`}
<p>You can close this tab and go back to FreePoster.</p>`;

/** The running Drive pipeline, for the settings and review routes. */
export interface DriveServices {
  intake: Intake;
  /** checks the folder now (after it changes) */
  poll: () => Promise<void>;
  /** the Sync button: matches the list to what's in the folder now (null = not connected / folder unreadable) */
  sync: () => Promise<{ removed: string[]; cancelledPosts: number; busy: string[] } | null>;
}

export function buildServer(store: Store, runner: Runner, publishers: Record<Platform, Publisher>, options: ServerOptions = {}, drive?: DriveServices): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.register(multipart, { limits: { fileSize: 4 * 1024 ** 3, files: 1, fields: 20 } });

  // Read per request, so a password saved from the setup screen applies at once.
  app.addHook("onRequest", async (req, reply) => {
    const password = config.appPassword;
    if (!password || req.url === "/api/ping") return;
    if (/^\/callback([/?]|$)/.test(req.url)) return; // protected by the one-time OAuth state instead
    const given = Buffer.from(req.headers.authorization?.match(/^Basic (.+)$/)?.[1] ?? "", "base64").toString().split(":").slice(1).join(":");
    const a = Buffer.from(given);
    const b = Buffer.from(password);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      reply.header("www-authenticate", 'Basic realm="FreePoster"').code(401).send("password required");
    }
  });

  const html = readFileSync(join(codeDir, "public", "index.html"), "utf8");
  app.get("/", (_req, reply) => reply.type("text/html").send(html));

  /** Lets a second launch of the desktop app find this one instead of starting another. */
  app.get("/api/ping", async () => ({ app: "freeposter" }));

  app.get("/api/status", async () => {
    const defaults = defaultAccountIds(store);
    return {
      desktop: Boolean(options.onQuit),
      pendingJobs: store.pendingJobCount(),
      needsRedirectPage: needsRedirectPage(),
      setupComplete: existsSync(setupMarker()),
      platforms: PLATFORMS.map((p) => ({ platform: p, label: publishers[p].label, configured: isConfigured(p) })),
      accounts: store.accounts().map((a) => ({
        id: a.id,
        platform: a.platform,
        name: a.name,
        expiresAt: a.expiresAt,
        // Long-lived refresh tokens (TikTok: 1 year) need a manual reconnect before they run out.
        reconnectSoon: a.refreshExpiresAt !== null && a.refreshExpiresAt - Date.now() < 14 * 86_400_000,
        maxDurationSec: publishers[a.platform].maxDurationSec(a),
        isDefault: defaults.includes(a.id),
        // Meta shares posts to this account from that one, so FreePoster never posts to it itself.
        sharedFrom: sharedFrom(store, a)?.id ?? null,
      })),
      accountSets: accountSets(store),
      sharingPairs: sharingPairs(store).map((p) => ({ pageId: p.pageId, instagramId: p.instagram.id, facebookId: p.facebook.id, sharing: p.sharing })),
      defaultTikTok: { allowComment: true, allowDuet: true, allowStitch: true, ...defaultTikTokPrefs(store) },
    };
  });

  // ---- OAuth ----

  // Google Drive signs in with the YouTube app's Google client, asking only to read files.
  app.get("/connect/drive", async (_req, reply) => {
    if (!isConfigured("youtube")) return reply.code(400).send("Google (YouTube) credentials are missing; add them in Setup");
    if (needsRedirectPage()) return reply.code(400).send(NO_REDIRECT_PAGE);
    const state = `${config.port}.${randomToken(24)}`;
    const verifier = randomToken(48);
    store.putOAuthState(state, "drive", verifier);
    return reply.redirect(driveAuthorizeUrl(state, verifier));
  });

  app.get<{ Params: { platform: string }; Querystring: { set?: string } }>("/connect/:platform", async (req, reply) => {
    const { platform } = req.params;
    if (!isPlatform(platform)) return reply.code(404).send("unknown platform");
    if (!isConfigured(platform)) return reply.code(400).send(`${platform} credentials are missing; add them in Setup`);
    if (needsRedirectPage()) return reply.code(400).send(NO_REDIRECT_PAGE);
    // Starts with the port, so the hosted redirect page knows where to hand the result back.
    const state = `${config.port}.${randomToken(24)}`;
    const verifier = randomToken(48);
    store.putOAuthState(state, platform, verifier);
    if (req.query.set) noteSignInSet(store, state, Number(req.query.set));
    return reply.redirect(publishers[platform].authorizeUrl(state, verifier));
  });

  app.get<{ Params: { platform: string }; Querystring: Record<string, string> }>("/callback/:platform", async (req, reply) => {
    const { platform } = req.params;
    if (platform === "drive") return finishSignIn("drive", req.query, reply);
    if (!isPlatform(platform)) return reply.code(404).send("unknown platform");
    return finishSignIn(platform, req.query, reply);
  });

  // Where the hosted redirect page forwards to: the platform comes from the pending sign-in's state.
  app.get<{ Querystring: Record<string, string> }>("/callback", async (req, reply) => {
    const platform = req.query.state ? store.oauthStatePlatform(req.query.state) : undefined;
    if (!platform) {
      return reply.redirect(`/?${new URLSearchParams({ error: "That sign-in expired or was not started here; press Connect again." })}`);
    }
    return finishSignIn(platform, req.query, reply);
  });

  async function finishSignIn(platform: SignIn, q: Record<string, string>, reply: FastifyReply) {
    const back = (params: Record<string, string>) => {
      if (!options.onSignIn) return reply.redirect(`/?${new URLSearchParams(params)}`);
      options.onSignIn(String(new URLSearchParams(params)));
      return reply.type("text/html").send(signedInPage(params));
    };
    if (q.error) return back({ error: `${platform}: ${q.error_description || q.error}` });
    const verifier = q.state ? store.takeOAuthState(q.state, platform) : undefined;
    if (!verifier) return back({ error: `${platform}: login expired or was not started here; try again` });
    try {
      if (platform === "drive") {
        const { tokens, email } = await exchangeDriveCode(q.code, verifier);
        store.saveDriveTokens(tokens, email);
        return back({ connected: `Google Drive: ${email}` });
      }
      const setId = takeSignInSet(store, q.state);
      const accounts = await publishers[platform].exchangeCode(q.code, verifier);
      const before = new Set(store.accounts().map((a) => a.id));
      const hadAccounts = store.accounts().some((a) => a.platform === platform);
      const saved = accounts.map((a) => store.upsertAccount(a));
      // New accounts join the set the sign-in started from; reconnected ones stay in their own set.
      if (setId !== undefined) placeInSet(store, setId, saved.filter((a) => !before.has(a.id)).map((a) => a.id));
      noteConnected(store, platform, hadAccounts);
      return back({ connected: `${publishers[platform].label}: ${accounts.map((a) => a.name).join(", ")}` });
    } catch (err) {
      return back({ error: `${platform}: ${(err as Error).message}` });
    }
  }

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    const account = store.account(Number(req.params.id));
    if (account) noteRemoving(store, account);
    store.deleteAccount(Number(req.params.id));
    return { ok: true };
  });

  // Where FreePoster posts on its own (Drive videos), and the TikTok options those posts use.
  app.put<{ Body: { accounts?: unknown; tiktok?: Record<string, unknown> } }>("/api/defaults", async (req, reply) => {
    const body = req.body ?? {};
    if (body.accounts !== undefined) {
      const ids = Array.isArray(body.accounts) ? body.accounts.map(Number) : [];
      if (!Array.isArray(body.accounts) || ids.some((id) => !store.account(id))) return reply.code(400).send({ error: "unknown account selected" });
      setDefaultAccounts(store, ids);
    }
    if (body.tiktok !== undefined) {
      const t = body.tiktok ?? {};
      if ("privacyLevel" in t) return reply.code(400).send({ error: "TikTok posts FreePoster makes on its own always go out as Only me" });
      const allowed = ["allowComment", "allowDuet", "allowStitch"];
      if (Object.keys(t).some((k) => !allowed.includes(k)) || Object.values(t).some((v) => typeof v !== "boolean")) {
        return reply.code(400).send({ error: "tiktok takes allowComment, allowDuet and allowStitch (true or false)" });
      }
      setDefaultTikTokPrefs(store, t);
    }
    return { ok: true };
  });

  const setName = (body: { name?: unknown } | undefined) => {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    return name && name.length <= 80 ? name : null;
  };

  app.post<{ Body: { name?: unknown } }>("/api/account-sets", async (req, reply) => {
    const name = setName(req.body);
    if (!name) return reply.code(400).send({ error: "a set name is 1 to 80 characters" });
    return createAccountSet(store, name);
  });

  app.delete<{ Params: { id: string } }>("/api/account-sets/:id", async (req, reply) => {
    const error = deleteAccountSet(store, Number(req.params.id));
    return error ? reply.code(400).send({ error }) : { ok: true };
  });

  app.put<{ Params: { id: string }; Body: { name?: unknown } }>("/api/account-sets/:id", async (req, reply) => {
    const name = setName(req.body);
    if (!name) return reply.code(400).send({ error: "a set name is 1 to 80 characters" });
    if (!renameAccountSet(store, Number(req.params.id), name)) return reply.code(404).send({ error: "no such account set" });
    return { ok: true };
  });

  // What the user set up on Meta's side: Meta shares one account's posts to the other in a linked pair.
  app.put<{ Body: { pageId?: unknown; sharing?: unknown } }>("/api/sharing", async (req, reply) => {
    const pageId = String(req.body?.pageId ?? "");
    const sharing = req.body?.sharing ?? null;
    if (!sharingPairs(store).some((p) => p.pageId === pageId)) return reply.code(400).send({ error: "no connected Instagram account and Facebook Page pair for that Page" });
    if (sharing !== null && sharing !== "ig_to_fb" && sharing !== "fb_to_ig") return reply.code(400).send({ error: "sharing is ig_to_fb, fb_to_ig or null" });
    setSharing(store, pageId, sharing as Sharing | null);
    return { ok: true };
  });

  /** TikTok requires the posting UI to be built from this live response (privacy options, toggles, max duration). */
  app.get<{ Params: { id: string } }>("/api/accounts/:id/tiktok-creator", async (req, reply) => {
    const account = store.account(Number(req.params.id));
    if (account?.platform !== "tiktok") return reply.code(404).send({ error: "not a TikTok account" });
    try {
      return await creatorInfo(await runner.freshAccount(account));
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // ---- setup ----

  const settingsView = async () => {
    const [ffmpeg, ffprobe, claude] = await Promise.all([toolVersion(config.ffmpeg), toolVersion(config.ffprobe), toolVersion(findClaude(), "--version")]);
    const keys = Object.keys(SETTINGS) as SettingKey[];
    return {
      envFile,
      baseUrl: config.baseUrl,
      redirectPage: config.redirectPage,
      redirectOff: config.redirectOff,
      needsRedirectPage: needsRedirectPage(),
      redirectDone: redirectDone(store),
      // the address before the last change: every developer console still has it until the user updates them
      redirectChangedFrom: store.pref<string>("redirect.changedFrom") ?? null,
      redirectFolder: folderPath(),
      tiktokFiles: tiktokFiles(),
      port: config.port,
      redirectUris: { ...Object.fromEntries(PLATFORMS.map((p) => [p, redirectUri(p)])), drive: driveRedirectUri() },
      configured: Object.fromEntries(PLATFORMS.map((p) => [p, isConfigured(p)])),
      tools: { ffmpeg, ffprobe, claude },
      values: Object.fromEntries(keys.filter((k) => !SETTINGS[k].secret).map((k) => [k, setting(k)])),
      secretsSet: Object.fromEntries(keys.filter((k) => SETTINGS[k].secret).map((k) => [k, Boolean(setting(k))])),
    };
  };

  app.get("/api/settings", settingsView);

  // PUT with a JSON body: a cross-site page can't send this without a CORS preflight we never answer.
  app.put<{ Body: { values?: Record<string, unknown> } }>("/api/settings", async (req, reply) => {
    const input = req.body?.values ?? {};
    const out: Partial<Record<SettingKey, string>> = {};
    const problems: string[] = [];
    for (const [key, raw] of Object.entries(input)) {
      if (!(key in SETTINGS)) { problems.push(`${key} is not a setting`); continue; }
      const k = key as SettingKey;
      let value = String(raw ?? "").trim();
      if (SETTINGS[k].secret && !value) continue; // blank secret = keep the saved one
      if (/^(PORT|DAILY_CAP_\w+|X_MAX_\w+)$/.test(k) && value && !(Number.isInteger(Number(value)) && Number(value) > 0)) {
        problems.push(`${k} must be a whole number above 0`);
      }
      if (k === "PORT" && Number(value) > 65535) problems.push("PORT must be 65535 or lower");
      if (k === "REDIRECT_PAGE_URL" && value && value.toLowerCase() !== "off" && !/^https:\/\/[^\s?#]+$/.test(value)) {
        problems.push("REDIRECT_PAGE_URL must be an https address, like https://yourname-freeposter.pages.dev, or off");
      }
      if (k === "SITE_CONTACT_EMAIL" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) problems.push("the contact email doesn't look like an email address");
      if (k === "BASE_URL" && value) {
        value = value.replace(/\/$/, "");
        if (!/^https?:\/\/[^/?#\s]+$/.test(value)) problems.push("BASE_URL must look like https://example.com (no path)");
      }
      out[k] = value;
    }
    // The address as it will be after saving; blank means the localhost default.
    const port = out.PORT !== undefined ? out.PORT || "4400" : String(config.port);
    const baseUrl = out.BASE_URL !== undefined ? out.BASE_URL || `http://localhost:${port}` : config.baseUrl;
    if (!isLocalUrl(baseUrl) && !(out.APP_PASSWORD || config.appPassword)) {
      problems.push(`${baseUrl} is reachable from outside; set an app password so only you can post`);
    }
    if (problems.length) return reply.code(400).send({ error: problems.join("\n") });
    const portBefore = config.port;
    const pageBefore = config.redirectPage;
    saveSettings(out);
    if (pageBefore && config.redirectPage !== pageBefore) store.setPref("redirect.changedFrom", pageBefore);
    return { ...(await settingsView()), restartNeeded: config.port !== portBefore };
  });

  app.put<{ Body: { complete?: boolean } }>("/api/setup", async (req) => {
    if (req.body?.complete === false) { try { unlinkSync(setupMarker()); } catch {} }
    else {
      writeFileSync(setupMarker(), new Date().toISOString());
      store.setPref("redirect.changedFrom", null); // finishing setup means the consoles were updated
    }
    return { ok: true };
  });

  // ---- the user's own redirect page: make the folder to upload, then check the address it went live at ----

  app.post("/api/redirect-page/folder", async (_req, reply) => {
    try {
      return { path: makeFolder() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.put("/api/redirect-page/show", async (_req, reply) => {
    if (!options.showFolder) return reply.code(404).send({ error: "only the desktop app can open folders" });
    options.showFolder(folderPath());
    return { ok: true };
  });

  app.post("/api/redirect-page/check", async () => checkRedirect(store));

  app.post("/api/redirect-page/accept", async (_req, reply) => {
    if (!config.redirectPage) return reply.code(400).send({ error: "paste your Cloudflare address first" });
    acceptRedirect(store);
    return { ok: true };
  });

  app.post<{ Body: { name?: unknown; content?: unknown } }>("/api/redirect-page/tiktok-file", async (req, reply) => {
    try {
      addTikTokFile(String(req.body?.name ?? ""), String(req.body?.content ?? ""));
      return { ok: true, files: tiktokFiles() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  if (options.onQuit) {
    const quit = options.onQuit;
    app.put("/api/quit", async () => {
      setTimeout(quit, 100); // let this response reach the page first
      return { ok: true };
    });
  }

  // ---- posting ----

  app.post("/api/posts", async (req, reply) => {
    const fields: Record<string, string> = {};
    let saved: { path: string; sha256: string } | undefined;
    let filename = "";
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          filename = part.filename;
          saved = await saveUpload(part.file, part.filename);
          if (part.file.truncated) throw new Error("file is larger than 4 GB");
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      // A post of an approved edit names the edit instead of uploading the video again.
      const edit = !saved && fields.editId ? store.edit(Number(fields.editId)) : undefined;
      if (!saved && fields.editId && !edit) throw new Error("unknown edit");
      const source = saved ?? (edit && { path: edit.sourcePath, sha256: edit.sha256 });
      if (!source) throw new Error("attach a video file");

      const draft: Draft = {
        caption: fields.caption ?? "",
        title: fields.title ?? "",
        sourcePath: source.path,
        sha256: source.sha256,
        editId: edit?.id ?? null,
        accountIds: JSON.parse(fields.accounts || "[]").map(Number),
        tiktok: fields.tiktok ? JSON.parse(fields.tiktok) : null,
        scheduledAt: parseSchedule(fields.scheduledAt),
        // A blank caption is written by Claude (see Captioner) before the post goes out.
        captionTopic: captionTopicFor(fields.caption ?? "", fields.title ?? "", filename),
      };
      await checkDraft(store, publishers, draft, fields.allowDuplicate === "true");
      const postId = store.createPost(draft, draft.accountIds);
      runner.tick();
      return { postId };
    } catch (err) {
      if (saved) try { unlinkSync(saved.path); } catch {}
      if (err instanceof DuplicateError) return reply.code(409).send({ error: err.message, duplicate: true });
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get("/api/posts", async () => store.recentPosts().map((p) => postView(store, p)));

  // ---- edits: made in the background, previewed and approved here before they can be posted ----

  app.post("/api/edits", async (req, reply) => {
    const fields: Record<string, string> = {};
    let saved: { path: string; sha256: string } | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          saved = await saveUpload(part.file, part.filename);
          if (part.file.truncated) throw new Error("file is larger than 4 GB");
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      if (!saved) throw new Error("attach a video file");
      const settings = parseEditSettings(fields.settings ? JSON.parse(fields.settings) : undefined);
      const edit = store.createEdit(saved.path, saved.sha256, settings);
      // The same file and settings were edited before: keep that edit and drop this copy.
      if (edit.sourcePath !== saved.path) try { unlinkSync(saved.path); } catch {}
      return { editId: edit.id };
    } catch (err) {
      if (saved) try { unlinkSync(saved.path); } catch {}
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/edits/:id", async (req, reply) => {
    const edit = store.edit(Number(req.params.id));
    if (!edit) return reply.code(404).send({ error: "no such edit" });
    return editView(store, publishers, edit);
  });

  app.get<{ Params: { id: string } }>("/api/edits/:id/video", async (req, reply) => {
    const edit = store.edit(Number(req.params.id));
    if (!edit?.outputPath || !existsSync(edit.outputPath)) return reply.code(404).send({ error: "the edit isn't ready" });
    const size = statSync(edit.outputPath).size;
    reply.type("video/mp4").header("accept-ranges", "bytes");
    // The preview player seeks with Range requests.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send();
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
      return reply.send(createReadStream(edit.outputPath, { start, end }));
    }
    reply.header("content-length", size);
    return reply.send(createReadStream(edit.outputPath));
  });

  app.put<{ Params: { id: string } }>("/api/edits/:id/approve", async (req, reply) => {
    const edit = store.edit(Number(req.params.id));
    if (!edit) return reply.code(404).send({ error: "no such edit" });
    if (edit.state !== "ready") return reply.code(409).send({ error: "the edit isn't finished yet" });
    store.approveEdit(edit.id);
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { scheduledAt?: unknown; caption?: unknown; title?: unknown; useOriginal?: unknown } }>("/api/posts/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const post = store.post(id);
    if (!post) return reply.code(404).send({ error: "no such post" });
    const body = req.body ?? {};
    if (body.useOriginal === true) {
      if (post.requireEdit) return reply.code(409).send({ error: "this Drive video posts its edit; to post a Drive video as uploaded, end its name with _RAW" });
      if (!store.setPostEdit(id, null)) return reply.code(409).send({ error: "this post has already started going out" });
      return { ok: true };
    }
    if (body.caption !== undefined || body.title !== undefined) {
      const caption = String(body.caption ?? post.caption);
      const title = String(body.title ?? post.title);
      const problems = store.jobsForPost(id).flatMap((j) => {
        const account = store.account(j.accountId);
        const reason = account && publishers[j.platform].validate({ ...post, caption, title }, account);
        return reason ? [`${publishers[j.platform].label} (${account!.name}): ${reason}`] : [];
      });
      if (problems.length) return reply.code(400).send({ error: problems.join("\n") });
      if (!store.updatePostText(id, caption, title)) return reply.code(409).send({ error: "this post has already started going out" });
      return { ok: true };
    }
    let at: number | null;
    try {
      at = parseSchedule(req.body?.scheduledAt);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const moved = store.reschedulePost(id, at);
    if (!moved) return reply.code(409).send({ error: "this post has already started going out" });
    runner.tick();
    return { ok: true, moved };
  });

  app.delete<{ Params: { id: string } }>("/api/posts/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!store.post(id)) return reply.code(404).send({ error: "no such post" });
    const { cancelled, orphanedSource } = store.cancelPost(id);
    if (!cancelled) return reply.code(409).send({ error: "this post has already started going out" });
    if (orphanedSource) try { unlinkSync(orphanedSource); } catch {}
    return { ok: true, cancelled };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req) => {
    store.retryJob(Number(req.params.id));
    runner.tick();
    return { ok: true };
  });

  // ---- Google Drive: the watched folder, and what became of each file in it ----

  const driveView = () => {
    const conn = store.driveConnection();
    return {
      configured: isConfigured("youtube"),
      connected: Boolean(conn),
      email: conn?.email ?? null,
      folderId: conn?.folderId ?? null,
      folderUrl: conn?.folderId ? `https://drive.google.com/drive/folders/${conn.folderId}` : null,
      error: conn?.error ?? null,
      files: store.driveFiles(30).map((f) => ({
        id: f.driveId, name: f.name, state: f.state, scheduledAt: f.scheduledAt, note: f.note,
        postId: f.postId, editId: f.editId, title: f.title, caption: f.caption, createdAt: f.createdAt,
      })),
    };
  };

  app.get("/api/drive", async () => driveView());

  app.put<{ Body: { folder?: unknown } }>("/api/drive", async (req, reply) => {
    const body = req.body ?? {};
    if (body.folder !== undefined) {
      if (!store.driveConnection()) return reply.code(400).send({ error: "connect Google Drive first" });
      const folderId = folderIdFrom(String(body.folder ?? ""));
      if (!folderId) return reply.code(400).send({ error: "paste the folder's link, like https://drive.google.com/drive/folders/…" });
      store.setDriveFolder(folderId);
    }
    if (body.folder !== undefined) void drive?.poll().catch((err) => console.error(`drive poll: ${(err as Error).message}`));
    return driveView();
  });

  app.delete("/api/drive", async () => {
    store.deleteDriveConnection();
    return { ok: true };
  });

  app.post("/api/drive/sync", async (_req, reply) => {
    if (!drive) return reply.code(503).send({ error: "Drive isn't running" });
    if (!store.driveConnection()?.folderId) return reply.code(400).send({ error: "connect Google Drive and add a folder first" });
    try {
      const result = await drive.sync();
      if (!result) return reply.code(502).send({ error: store.driveConnection()?.error ?? "FreePoster couldn't read the Drive folder; try again in a moment" });
      return { ...result, view: driveView() };
    } catch (err) {
      return reply.code(502).send({ error: `couldn't reach Google Drive: ${(err as Error).message}` });
    }
  });

  app.post<{ Params: { id: string } }>("/api/drive/files/:id/retry-edit", async (req, reply) => {
    if (store.driveFile(req.params.id)?.state !== "edit_failed") return reply.code(409).send({ error: "only files whose edit failed can be retried" });
    void drive?.intake.retryEdit(req.params.id);
    return { ok: true };
  });

  registerMcp(app, store, runner, publishers);

  return app;
}
