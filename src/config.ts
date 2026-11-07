import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { Platform } from "./types.ts";

/** True in the installed desktop app; `electron build/app` during development sets process.defaultApp. */
export const packaged = Boolean(process.versions.electron) && !(process as { defaultApp?: boolean }).defaultApp;

/**
 * Where public/ lives. Running from source that's the checkout; the desktop app runs a bundle
 * (no import.meta there) with public/ copied next to it.
 */
export const codeDir = import.meta.dirname ? resolve(import.meta.dirname, "..") : __dirname;

/**
 * Settings and data (.env, data/: the database with the connected accounts, and the key that encrypts their tokens)
 * live in one folder per user, however FreePoster is started: the installer, `npm run desktop` or `npm start`.
 * They used to live in the checkout when run from source, so moving between an installed version and a source build
 * (or updating from one to the other) opened an empty database and every account looked disconnected.
 * A per-user folder that doesn't exist yet starts as a copy of the checkout's settings and data, if it has any;
 * the checkout's copy is left as it was.
 */
export function homeFolder(userDir: string, legacyDir?: string): string {
  const hasData = (dir: string) => existsSync(join(dir, ".env")) || existsSync(join(dir, "data", "freeposter.db"));
  if (legacyDir && resolve(legacyDir) !== resolve(userDir) && !hasData(userDir) && hasData(legacyDir)) {
    mkdirSync(userDir, { recursive: true });
    if (existsSync(join(legacyDir, ".env"))) cpSync(join(legacyDir, ".env"), join(userDir, ".env"));
    // window/ is Chromium's cache, which the app rebuilds.
    if (existsSync(join(legacyDir, "data"))) cpSync(join(legacyDir, "data"), join(userDir, "data"), {
      recursive: true,
      filter: (src) => resolve(src) !== resolve(legacyDir, "data", "window"),
    });
  }
  return userDir;
}

// FREEPOSTER_HOME overrides it (tests use it to keep their .env and data away from yours).
const root = process.env.FREEPOSTER_HOME?.trim() || homeFolder(
  join(process.env.APPDATA || homedir(), "FreePoster"),
  // Where a source checkout kept them before; the installed app always used the per-user folder.
  packaged ? undefined : import.meta.dirname ? resolve(import.meta.dirname, "..") : process.cwd(),
);

export const envFile = join(root, ".env");
export const dataDir = join(root, "data");
mkdirSync(join(dataDir, "uploads"), { recursive: true });
mkdirSync(join(dataDir, "renders"), { recursive: true });
mkdirSync(join(dataDir, "edits"), { recursive: true });
mkdirSync(join(dataDir, "models"), { recursive: true });
mkdirSync(join(dataDir, "productions"), { recursive: true });
mkdirSync(join(dataDir, "sfx"), { recursive: true });

/** Every key the setup screen may write to .env. Secrets are never sent back to the browser. */
export const SETTINGS = {
  PORT: { secret: false },
  BASE_URL: { secret: false },
  REDIRECT_PAGE_URL: { secret: false },
  SITE_OWNER_NAME: { secret: false },
  SITE_CONTACT_EMAIL: { secret: false },
  APP_PASSWORD: { secret: true },
  FFMPEG_PATH: { secret: false },
  FFPROBE_PATH: { secret: false },
  WHISPER_MODEL_PATH: { secret: false },
  CLAUDE_CODE_PATH: { secret: false },
  YOUTUBE_CLIENT_ID: { secret: false },
  YOUTUBE_CLIENT_SECRET: { secret: true },
  TIKTOK_CLIENT_KEY: { secret: false },
  TIKTOK_CLIENT_SECRET: { secret: true },
  FACEBOOK_APP_ID: { secret: false },
  FACEBOOK_APP_SECRET: { secret: true },
  X_CLIENT_ID: { secret: false },
  X_CLIENT_SECRET: { secret: true },
  META_GRAPH_VERSION: { secret: false },
  DAILY_CAP_YOUTUBE: { secret: false },
  DAILY_CAP_TIKTOK: { secret: false },
  DAILY_CAP_INSTAGRAM: { secret: false },
  DAILY_CAP_FACEBOOK: { secret: false },
  DAILY_CAP_X: { secret: false },
  X_MAX_CHARS: { secret: false },
  X_MAX_VIDEO_SECONDS: { secret: false },
  // Productions (HyperFrames, WanGP, Blender) and the agent's reach.
  AGENT_APPROVAL: { secret: false },
  NOTIFY_WEBHOOK_URL: { secret: false },
  NOTIFY_WEBHOOK_SECRET: { secret: true },
  HYPERFRAMES_CMD: { secret: false },
  WANGP_DIR: { secret: false },
  WANGP_MODEL: { secret: false },
  WANGP_TIMEOUT_MIN: { secret: false },
  BLENDER_PATH: { secret: false },
  CPU_LANE_CONCURRENCY: { secret: false },
  SHOT_RETENTION_DAYS: { secret: false },
} as const;
export type SettingKey = keyof typeof SETTINGS;

// Values saved in .env win over the shell environment, so what the setup screen saves is what runs.
let fileVars: NodeJS.Dict<string> = {};
export const setting = (name: string, fallback = "") => fileVars[name]?.trim() || process.env[name]?.trim() || fallback;

/** "https://x.pages.dev" → "https://x.pages.dev/", the exact form platforms compare against; "off" = no page. */
function normalizePage(url: string) {
  if (!url || url.toLowerCase() === "off") return "";
  try { return new URL(url).href; } catch { return ""; }
}

/** A whole number above zero, else the fallback. */
const positive = (raw: string, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

function build() {
  const port = Number(setting("PORT", "4400"));
  return {
    root,
    port,
    baseUrl: setting("BASE_URL", `http://localhost:${port}`).replace(/\/$/, ""),
    appPassword: setting("APP_PASSWORD"),
    // Each user's own redirect page (made in setup's first step, from redirect-page/). "off" = BASE_URL callbacks.
    redirectPage: normalizePage(setting("REDIRECT_PAGE_URL")),
    redirectOff: setting("REDIRECT_PAGE_URL").toLowerCase() === "off",
    siteOwner: setting("SITE_OWNER_NAME"),
    siteEmail: setting("SITE_CONTACT_EMAIL"),
    ffmpeg: setting("FFMPEG_PATH", "ffmpeg"),
    ffprobe: setting("FFPROBE_PATH", "ffprobe"),
    whisperModel: setting("WHISPER_MODEL_PATH", join(dataDir, "models", "ggml-base.bin")),
    // Meta's URLs need the "v" ("/v24.0/..."); "24.0" alone gives Facebook's "Request Couldn't be Processed".
    graphVersion: setting("META_GRAPH_VERSION", "v24.0").replace(/^(?=\d)/, "v"),
    credentials: {
      youtube: { id: setting("YOUTUBE_CLIENT_ID"), secret: setting("YOUTUBE_CLIENT_SECRET") },
      tiktok: { id: setting("TIKTOK_CLIENT_KEY"), secret: setting("TIKTOK_CLIENT_SECRET") },
      // Instagram publishing goes through the same Meta app via Facebook Login for Business.
      instagram: { id: setting("FACEBOOK_APP_ID"), secret: setting("FACEBOOK_APP_SECRET") },
      facebook: { id: setting("FACEBOOK_APP_ID"), secret: setting("FACEBOOK_APP_SECRET") },
      x: { id: setting("X_CLIENT_ID"), secret: setting("X_CLIENT_SECRET") },
    } satisfies Record<Platform, { id: string; secret: string }>,
    dailyCap: {
      youtube: Number(setting("DAILY_CAP_YOUTUBE", "6")),
      tiktok: Number(setting("DAILY_CAP_TIKTOK", "15")),
      instagram: Number(setting("DAILY_CAP_INSTAGRAM", "50")),
      facebook: Number(setting("DAILY_CAP_FACEBOOK", "30")),
      x: Number(setting("DAILY_CAP_X", "50")),
    } satisfies Record<Platform, number>,
    xMaxChars: Number(setting("X_MAX_CHARS", "280")),
    xMaxVideoSeconds: Number(setting("X_MAX_VIDEO_SECONDS", "140")),
    produce: {
      /** "on": an agent may approve a production or edit once the user says yes in chat. Only the window changes it. */
      agentApproval: setting("AGENT_APPROVAL").toLowerCase() === "on",
      webhookUrl: setting("NOTIFY_WEBHOOK_URL"),
      webhookSecret: setting("NOTIFY_WEBHOOK_SECRET"),
      /** empty = FreePoster's own pinned HyperFrames install (tools.ts) */
      hyperframesCmd: setting("HYPERFRAMES_CMD"),
      /** empty = looked for (tools.ts) */
      wangpDir: setting("WANGP_DIR"),
      wangpModel: setting("WANGP_MODEL"),
      wangpTimeoutMin: positive(setting("WANGP_TIMEOUT_MIN"), 30),
      /** empty = the newest blender.exe under Program Files (tools.ts) */
      blenderPath: setting("BLENDER_PATH"),
      cpuLane: positive(setting("CPU_LANE_CONCURRENCY"), 2),
      shotRetentionDays: positive(setting("SHOT_RETENTION_DAYS"), 14),
    },
  };
}

export const config = build();

/** Re-reads .env in place; callers keep their reference to `config`. */
export function reloadConfig() {
  fileVars = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  Object.assign(config, build());
}
reloadConfig();

/** Writes the given keys into .env, keeping every other line (and comment) as it was. */
export function saveSettings(values: Partial<Record<SettingKey, string>>) {
  let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw ?? "").replace(/[\r\n]/g, "").trim();
    // .env has no escapes: quote with whichever quote character the value does not contain.
    const quote = /[\s#"'`]/.test(value) ? ["'", '"', "`"].find((q) => !value.includes(q)) : "";
    if (quote === undefined) throw new Error(`${key} cannot contain all three quote characters`);
    const line = `${key}=${quote}${value}${quote}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, () => line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(envFile, text, { mode: 0o600 });
  reloadConfig();
}

export const isLocalUrl = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(url);
/** No redirect page yet, and the tunnel route isn't chosen: accounts can't be connected until setup's first step is done. */
export const needsRedirectPage = () => !config.redirectPage && !config.redirectOff;
export const redirectUri = (platform: Platform) => config.redirectPage || `${config.baseUrl}/callback/${platform}`;
export const isConfigured = (platform: Platform) =>
  Boolean(config.credentials[platform].id && config.credentials[platform].secret);
