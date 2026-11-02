import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// From source, settings and data live in the checkout (the desktop dev build is started from it);
// the installed app keeps them per user. FREEPOSTER_HOME overrides both (tests use it to keep their .env away from yours).
const root = process.env.FREEPOSTER_HOME?.trim()
  || (packaged ? join(process.env.APPDATA || homedir(), "FreePoster")
    : import.meta.dirname ? resolve(import.meta.dirname, "..") : process.cwd());

export const envFile = join(root, ".env");
export const dataDir = join(root, "data");
mkdirSync(join(dataDir, "uploads"), { recursive: true });
mkdirSync(join(dataDir, "renders"), { recursive: true });
mkdirSync(join(dataDir, "edits"), { recursive: true });
mkdirSync(join(dataDir, "models"), { recursive: true });

/**
 * The hosted redirect page (redirect-page/ in this repo) that every platform sends sign-ins back to.
 * Set this to its https address once it is deployed; users then register this one address with every
 * platform and never need a tunnel. Empty = sign-ins return straight to BASE_URL/callback/<platform>.
 */
export const BUILT_IN_REDIRECT_PAGE = "https://freeposter.pages.dev";

/** Every key the setup screen may write to .env. Secrets are never sent back to the browser. */
export const SETTINGS = {
  PORT: { secret: false },
  BASE_URL: { secret: false },
  REDIRECT_PAGE_URL: { secret: false },
  APP_PASSWORD: { secret: true },
  FFMPEG_PATH: { secret: false },
  FFPROBE_PATH: { secret: false },
  WHISPER_MODEL_PATH: { secret: false },
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

function build() {
  const port = Number(setting("PORT", "4400"));
  return {
    root,
    port,
    baseUrl: setting("BASE_URL", `http://localhost:${port}`).replace(/\/$/, ""),
    appPassword: setting("APP_PASSWORD"),
    redirectPage: normalizePage(setting("REDIRECT_PAGE_URL", BUILT_IN_REDIRECT_PAGE)),
    ffmpeg: setting("FFMPEG_PATH", "ffmpeg"),
    ffprobe: setting("FFPROBE_PATH", "ffprobe"),
    whisperModel: setting("WHISPER_MODEL_PATH", join(dataDir, "models", "ggml-base.bin")),
    graphVersion: setting("META_GRAPH_VERSION", "v24.0"),
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
export const redirectUri = (platform: Platform) => config.redirectPage || `${config.baseUrl}/callback/${platform}`;
export const isConfigured = (platform: Platform) =>
  Boolean(config.credentials[platform].id && config.credentials[platform].secret);
