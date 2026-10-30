import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeDir, config, dataDir, envFile, isConfigured, isLocalUrl, redirectUri, saveSettings, setting, SETTINGS, type SettingKey } from "./config.ts";
import { randomToken } from "./crypto.ts";
import type { Store } from "./db.ts";
import { registerMcp } from "./mcp.ts";
import type { Publisher } from "./platforms/base.ts";
import { creatorInfo } from "./platforms/tiktok.ts";
import { checkDraft, DuplicateError, parseSchedule, postView, saveUpload, type Draft } from "./posts.ts";
import type { Runner } from "./runner.ts";
import { PLATFORMS, type Platform } from "./types.ts";

const isPlatform = (p: string): p is Platform => (PLATFORMS as readonly string[]).includes(p);

const setupMarker = () => join(dataDir, "setup-complete");

/** Resolves to the tool's version line, or null when it can't be run. */
const toolVersion = (bin: string) =>
  new Promise<string | null>((done) =>
    execFile(bin, ["-version"], { timeout: 10_000, windowsHide: true }, (err, stdout) => done(err ? null : stdout.split("\n")[0].trim())),
  );

export interface ServerOptions {
  /** Present in the desktop app: lets the page shut FreePoster down. */
  onQuit?: () => void;
  /**
   * Present in the desktop app, whose sign-ins happen in the system browser: receives the result
   * (as the page's query string) so the app window can show it; the browser tab gets a short note.
   */
  onSignIn?: (query: string) => void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** What the system browser shows after a sign-in started from the desktop app. */
const signedInPage = (params: Record<string, string>) => `<!doctype html><meta charset="utf-8"><title>FreePoster</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 20px;color:#1c1b19}
@media(prefers-color-scheme:dark){body{background:#161615;color:#ecebe7}}h1{font-size:22px}.err{color:#d14b3f}</style>
${params.connected
  ? `<h1>Connected</h1><p>${esc(params.connected)}</p>`
  : `<h1 class="err">Sign-in didn't finish</h1><p>${esc(params.error ?? "")}</p>`}
<p>You can close this tab and go back to FreePoster.</p>`;

export function buildServer(store: Store, runner: Runner, publishers: Record<Platform, Publisher>, options: ServerOptions = {}): FastifyInstance {
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

  app.get("/api/status", async () => ({
    desktop: Boolean(options.onQuit),
    pendingJobs: store.pendingJobCount(),
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
    })),
  }));

  // ---- OAuth ----

  app.get<{ Params: { platform: string } }>("/connect/:platform", async (req, reply) => {
    const { platform } = req.params;
    if (!isPlatform(platform)) return reply.code(404).send("unknown platform");
    if (!isConfigured(platform)) return reply.code(400).send(`${platform} credentials are missing; add them in Setup`);
    // Starts with the port, so the hosted redirect page knows where to hand the result back.
    const state = `${config.port}.${randomToken(24)}`;
    const verifier = randomToken(48);
    store.putOAuthState(state, platform, verifier);
    return reply.redirect(publishers[platform].authorizeUrl(state, verifier));
  });

  app.get<{ Params: { platform: string }; Querystring: Record<string, string> }>("/callback/:platform", async (req, reply) => {
    const { platform } = req.params;
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

  async function finishSignIn(platform: Platform, q: Record<string, string>, reply: FastifyReply) {
    const back = (params: Record<string, string>) => {
      if (!options.onSignIn) return reply.redirect(`/?${new URLSearchParams(params)}`);
      options.onSignIn(String(new URLSearchParams(params)));
      return reply.type("text/html").send(signedInPage(params));
    };
    if (q.error) return back({ error: `${platform}: ${q.error_description || q.error}` });
    const verifier = q.state ? store.takeOAuthState(q.state, platform) : undefined;
    if (!verifier) return back({ error: `${platform}: login expired or was not started here; try again` });
    try {
      const accounts = await publishers[platform].exchangeCode(q.code, verifier);
      for (const a of accounts) store.upsertAccount(a);
      return back({ connected: `${publishers[platform].label}: ${accounts.map((a) => a.name).join(", ")}` });
    } catch (err) {
      return back({ error: `${platform}: ${(err as Error).message}` });
    }
  }

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    store.deleteAccount(Number(req.params.id));
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
    const [ffmpeg, ffprobe] = await Promise.all([toolVersion(config.ffmpeg), toolVersion(config.ffprobe)]);
    const keys = Object.keys(SETTINGS) as SettingKey[];
    return {
      envFile,
      baseUrl: config.baseUrl,
      redirectPage: config.redirectPage,
      port: config.port,
      redirectUris: Object.fromEntries(PLATFORMS.map((p) => [p, redirectUri(p)])),
      configured: Object.fromEntries(PLATFORMS.map((p) => [p, isConfigured(p)])),
      tools: { ffmpeg, ffprobe },
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
        problems.push("REDIRECT_PAGE_URL must be an https address, like https://freeposter.pages.dev, or off");
      }
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
    saveSettings(out);
    return { ...(await settingsView()), restartNeeded: config.port !== portBefore };
  });

  app.put<{ Body: { complete?: boolean } }>("/api/setup", async (req) => {
    if (req.body?.complete === false) { try { unlinkSync(setupMarker()); } catch {} }
    else writeFileSync(setupMarker(), new Date().toISOString());
    return { ok: true };
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

      const draft: Draft = {
        caption: fields.caption ?? "",
        title: fields.title ?? "",
        sourcePath: saved.path,
        sha256: saved.sha256,
        accountIds: JSON.parse(fields.accounts || "[]").map(Number),
        tiktok: fields.tiktok ? JSON.parse(fields.tiktok) : null,
        scheduledAt: parseSchedule(fields.scheduledAt),
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

  app.patch<{ Params: { id: string }; Body: { scheduledAt?: unknown } }>("/api/posts/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!store.post(id)) return reply.code(404).send({ error: "no such post" });
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
    const { cancelled, deleted } = store.cancelPost(id);
    if (!cancelled) return reply.code(409).send({ error: "this post has already started going out" });
    if (deleted) try { unlinkSync(deleted.sourcePath); } catch {}
    return { ok: true, cancelled };
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req) => {
    store.retryJob(Number(req.params.id));
    runner.tick();
    return { ok: true };
  });

  registerMcp(app, store, runner, publishers);

  return app;
}
