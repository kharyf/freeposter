// npm run dev:copy-home [-- --replace]
// Makes the development folder (%APPDATA%\FreePoster-dev) a copy of the installed app's (%APPDATA%\FreePoster),
// for testing a source checkout against real accounts and media. The installed app's folder is only read.
//
// The copy is made quiet, so running it never acts on its own beside the installed app:
// - nothing waiting to post: queued and retrying jobs are dropped (else both copies would publish them);
// - campaigns are switched off, Google Drive is disconnected and Telegram review is unpaired
//   (two copies polling one bot take each other's messages), and the agent webhook is cleared;
// - X and TikTok accounts lose their refresh tokens. X rotates them (refreshing in one copy signs the other out)
//   and TikTok may too, so the development copy can use them until the access token expires, then shows them
//   as needing reconnection. Reconnect those in development only with test accounts if you can.
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const hasData = (home: string) => existsSync(join(home, ".env")) || existsSync(join(home, "data", "freeposter.db"));

/** Rows that start work by themselves. Each table may be missing in an older database. */
const QUIET = [
  "DELETE FROM jobs WHERE state IN ('queued', 'running', 'retry', 'waiting_quota')",
  "DELETE FROM drive_connection",
  "DELETE FROM prefs WHERE key LIKE 'telegram.%'",
  "UPDATE campaigns SET enabled = 0, autorun = 0",
  "DELETE FROM notify_outbox",
  "UPDATE accounts SET refresh_token = NULL, refresh_expires_at = NULL WHERE platform IN ('x', 'tiktok')",
];
/** .env settings that point outside this computer at something only one copy should drive. */
const CLEARED_SETTINGS = ["NOTIFY_WEBHOOK_URL", "NOTIFY_WEBHOOK_SECRET", "PORT", "BASE_URL"];

/** Every stored absolute path under `from` now points under `to`, as written and inside JSON. */
function movePaths(db: DatabaseSync, from: string, to: string) {
  const forms: [string, string][] = [[from + sep, to + sep]];
  if (sep === "\\") forms.push([JSON.stringify(from + sep).slice(1, -1), JSON.stringify(to + sep).slice(1, -1)], [from.replaceAll("\\", "/") + "/", to.replaceAll("\\", "/") + "/"]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]).filter((c) => /TEXT|^$/i.test(c.type));
    for (const c of cols) {
      for (const [a, b] of forms) db.prepare(`UPDATE "${name}" SET "${c.name}" = replace("${c.name}", ?, ?) WHERE instr("${c.name}", ?) > 0`).run(a, b, a);
    }
  }
}

export function copyHome(from: string, to: string, { replace = false } = {}): { backup?: string } {
  from = resolve(from);
  to = resolve(to);
  if (from === to) throw new Error("the installed and development folders are the same folder");
  if (!hasData(from)) throw new Error(`${from} has no settings or data to copy`);
  let backup: string | undefined;
  if (hasData(to)) {
    if (!replace) throw new Error(`${to} already has settings or data. Run again with --replace to set it aside and copy over it.`);
    backup = `${to}.before-copy-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(to, backup);
  } else if (existsSync(to)) {
    // Only empty folders the development build made when it started: set aside so the copy lands cleanly.
    backup = `${to}.empty-${Date.now()}`;
    renameSync(to, backup);
  }

  const fromData = join(from, "data");
  const toData = join(to, "data");
  const skip = new Set(["window", "freeposter.db", "freeposter.db-wal", "freeposter.db-shm", "freeposter.db-journal", "freeposter.log"].map((n) => join(fromData, n)));
  cpSync(from, to, { recursive: true, filter: (src) => !skip.has(resolve(src)) });

  // A consistent snapshot even while the installed app is running and writing.
  const source = new DatabaseSync(join(fromData, "freeposter.db"), { readOnly: true });
  try { source.prepare("VACUUM INTO ?").run(join(toData, "freeposter.db")); } finally { source.close(); }

  const db = new DatabaseSync(join(toData, "freeposter.db"));
  try {
    db.exec("BEGIN");
    movePaths(db, fromData, toData);
    for (const sql of QUIET) {
      try { db.exec(sql); } catch (e) { if (!/no such table|no such column/.test((e as Error).message)) throw e; }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  const envFile = join(to, ".env");
  if (existsSync(envFile)) {
    const kept = readFileSync(envFile, "utf8").split(/\r?\n/).filter((line) => !CLEARED_SETTINGS.some((k) => line.startsWith(`${k}=`)));
    writeFileSync(envFile, kept.join("\n"), { mode: 0o600 });
  }
  return { backup };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Not config.ts: loading it would open (and create) the development folder this is about to fill.
  const appData = process.env.APPDATA;
  if (!appData) {
    console.error("APPDATA isn't set; this script is for Windows.");
    process.exit(2);
  }
  const from = join(appData, "FreePoster");
  const to = join(appData, "FreePoster-dev");
  try {
    const { backup } = copyHome(from, to, { replace: process.argv.includes("--replace") });
    console.log(`Copied ${from}\n    to ${to}`);
    if (backup) console.log(`The development folder that was there is now ${backup}`);
    console.log(`The copy is quiet: nothing queued to post, campaigns off, Drive and Telegram disconnected, webhook cleared.
X and TikTok accounts work until their access token expires, then need reconnecting (use test accounts in development).
Quit any running development copy before starting it again.`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
