// Each user's own redirect page: the folder they upload to Cloudflare Pages (forwarding page, Terms of Service,
// Privacy Policy, TikTok's verification files), made from the templates in redirect-page/, and the check that
// the address they paste really serves it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codeDir, config, dataDir } from "./config.ts";
import type { Store } from "./db.ts";

/** What gets uploaded; regenerated in full each time. */
export const folderPath = () => join(dataDir, "redirect-page");
/** TikTok verification files the user added, kept apart so every regeneration still includes them. */
const tiktokDir = () => join(dataDir, "tiktok-verification");

const TEMPLATES = ["index.html", "forward.js", "terms.html", "privacy.html", "_headers"];
const MARKER = '<meta name="freeposter-redirect" content="1">';
const DONE_PREF = "redirect.done";

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const tiktokFiles = () => (existsSync(tiktokDir()) ? readdirSync(tiktokDir()).filter((f) => /^tiktok\w*\.txt$/.test(f)).sort() : []);

/** Writes the folder with the owner's details filled in; returns where it went. */
export function makeFolder(now = new Date()): string {
  if (!config.siteOwner || !config.siteEmail) throw new Error("enter your name or business name and a contact email first");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.siteEmail)) throw new Error("the contact email doesn't look like an email address");
  const values: Record<string, string> = {
    OWNER: config.siteOwner,
    EMAIL: config.siteEmail,
    DATE: now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
  };
  const out = folderPath();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of TEMPLATES) {
    const text = readFileSync(join(codeDir, "redirect-page", name), "utf8");
    writeFileSync(join(out, name), text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in values ? escHtml(values[key]) : m)));
  }
  for (const f of tiktokFiles()) copyFileSync(join(tiktokDir(), f), join(out, f));
  return out;
}

/** Keeps a verification file TikTok handed out, and adds it to the folder. */
export function addTikTokFile(name: string, content: string) {
  const file = basename(name);
  if (!/^tiktok\w*\.txt$/.test(file)) throw new Error('TikTok\'s verification file is named like "tiktokAbC123.txt"');
  if (Buffer.byteLength(content) > 4096) throw new Error("that file is too big to be TikTok's verification file");
  mkdirSync(tiktokDir(), { recursive: true });
  writeFileSync(join(tiktokDir(), file), content);
  if (config.siteOwner && config.siteEmail) makeFolder();
}

/** The details the deployed page was checked (or accepted) with; the step is done while they still match. */
interface Done { url: string; owner: string; email: string; checked: boolean }

export function redirectDone(store: Store) {
  const d = store.pref<Done>(DONE_PREF);
  return Boolean(d && config.redirectPage && d.url === config.redirectPage && d.owner === config.siteOwner && d.email === config.siteEmail);
}

/** "Continue anyway": the user says the page is there even though the check didn't pass. */
export function acceptRedirect(store: Store) {
  store.setPref(DONE_PREF, { url: config.redirectPage, owner: config.siteOwner, email: config.siteEmail, checked: false } satisfies Done);
}

/** Opens the address the way a platform would, and says in plain words what isn't right yet. */
export async function checkRedirect(store: Store): Promise<{ ok: true } | { ok: false; reason: string }> {
  const base = config.redirectPage;
  if (!base) return { ok: false, reason: "Paste your Cloudflare address first." };
  const get = async (path: string) => {
    try {
      const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const [home, terms, privacy] = await Promise.all([get(""), get("terms"), get("privacy")]);
  if (home === null) return { ok: false, reason: `${base} didn't open. Cloudflare can take a minute after Deploy; check the address and try again.` };
  if (!home.includes(MARKER)) return { ok: false, reason: `${base} opens, but it isn't your FreePoster redirect page. Upload the folder FreePoster made, then try again.` };
  if (terms === null || privacy === null) return { ok: false, reason: "The Terms of Service or Privacy Policy page is missing there. Make the folder again and upload all of it." };
  if (!terms.includes(escHtml(config.siteOwner)) || !terms.includes(escHtml(config.siteEmail))) {
    return { ok: false, reason: "The Terms page there still has old details. Make the folder again and upload it as a new deployment." };
  }
  store.setPref(DONE_PREF, { url: base, owner: config.siteOwner, email: config.siteEmail, checked: true } satisfies Done);
  return { ok: true };
}
