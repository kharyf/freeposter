// Hermes Agent's extras. Hermes talks to FreePoster like any agent (MCP, the event feed, the optional webhook);
// the only thing it gets beyond that is a ready-made relay for reviews on Telegram: when the bot FreePoster sends
// reviews with is the one Hermes already reads (Telegram's "shared" mode), the freeposter-review Hermes plugin
// passes FreePoster's taps and redo replies to the relay endpoint, the contract any other agent's relay can follow
// too (docs/agents.md). This module installs and checks that plugin; nothing else in FreePoster knows about Hermes.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codeDir } from "../config.ts";

export const PLUGIN_NAME = "freeposter-review";

/** Hermes Agent's home folder (HERMES_HOME, else %LOCALAPPDATA%\hermes). */
export const hermesHome = () => process.env.HERMES_HOME?.trim() || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes");

/** Whether Hermes looks installed on this computer (its home folder exists). */
export const hermesDetected = () => existsSync(hermesHome());

/** Where the plugin's files ship: templates/, unpacked beside the bundle in the installed app. */
const pluginSource = () => join(codeDir.replace(/app\.asar$/, "app.asar.unpacked"), "templates", "hermes", PLUGIN_NAME);

const pluginDir = () => join(hermesHome(), "plugins", PLUGIN_NAME);

/** Whether Hermes's config.yaml lists the plugin under plugins.enabled. */
export function pluginEnabled(yaml: string): boolean {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^plugins:\s*$/.test(l));
  if (start < 0) return false;
  let inEnabled = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key
    if (/^\s+enabled:\s*$/.test(line)) { inEnabled = true; continue; }
    if (/^\s+\w+:/.test(line)) { inEnabled = false; continue; }
    if (inEnabled && line.replace(/^\s*-\s*/, "").replace(/["']/g, "").trim() === PLUGIN_NAME && /^\s*-/.test(line)) return true;
  }
  return false;
}

/** Whether the plugin is in Hermes's plugins folder, set up for this relay, and enabled in config.yaml. */
export function hermesPluginStatus(relayUrl: string, secret: string | null) {
  const dir = pluginDir();
  let configured = false;
  try {
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    configured = Boolean(secret) && s.url === relayUrl && s.secret === secret;
  } catch {}
  let enabled = false;
  try { enabled = pluginEnabled(readFileSync(join(hermesHome(), "config.yaml"), "utf8")); } catch {}
  return { detected: hermesDetected(), installed: existsSync(join(dir, "__init__.py")), configured, enabled, dir };
}

/** Copies the plugin into Hermes's plugins folder with the relay's address and secret. */
export function installHermesPlugin(relayUrl: string, secret: string | null) {
  if (!secret) throw new Error("connect the shared bot first");
  const src = pluginSource();
  if (!existsSync(join(src, "__init__.py"))) throw new Error(`the plugin's files are missing from ${src}`);
  const dir = pluginDir();
  mkdirSync(dir, { recursive: true });
  cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("__pycache__") });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ url: relayUrl, secret }, null, 2), { mode: 0o600 });
  return hermesPluginStatus(relayUrl, secret);
}
