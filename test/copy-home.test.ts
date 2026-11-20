import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { copyHome } from "../scripts/copy-home.ts";
import { tmp } from "./helpers.ts";

function installedHome() {
  const home = join(tmp(), "FreePoster");
  const data = join(home, "data");
  mkdirSync(join(data, "window"), { recursive: true });
  mkdirSync(join(data, "uploads"), { recursive: true });
  writeFileSync(join(data, "uploads", "a.mp4"), "video");
  writeFileSync(join(data, "window", "Cache"), "chromium");
  writeFileSync(join(data, "secret.key"), "key");
  writeFileSync(join(home, ".env"), "YOUTUBE_CLIENT_ID=abc\nPORT=4400\nNOTIFY_WEBHOOK_URL=http://localhost:8644/hook\n");
  const db = new DatabaseSync(join(data, "freeposter.db"));
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, platform TEXT, refresh_token TEXT, refresh_expires_at INTEGER);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, source_path TEXT, meta TEXT);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, state TEXT);
    CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY, enabled INTEGER, autorun INTEGER);
    CREATE TABLE drive_connection (id INTEGER PRIMARY KEY);
  `);
  const file = join(data, "uploads", "a.mp4");
  db.prepare("INSERT INTO posts (source_path, meta) VALUES (?, ?)").run(file, JSON.stringify({ file }));
  db.exec(`
    INSERT INTO accounts (platform, refresh_token, refresh_expires_at) VALUES ('x', 'rx', 1), ('tiktok', 'rt', 1), ('youtube', 'ry', NULL);
    INSERT INTO jobs (state) VALUES ('queued'), ('retry'), ('published'), ('failed');
    INSERT INTO prefs VALUES ('telegram.token', 't'), ('accounts.sets', '[]');
    INSERT INTO campaigns (enabled, autorun) VALUES (1, 1);
    INSERT INTO drive_connection (id) VALUES (1);
  `);
  db.close();
  return home;
}

test("the development folder becomes a quiet copy of the installed one, which is left as it was", () => {
  const from = installedHome();
  const to = join(tmp(), "FreePoster-dev");
  copyHome(from, to);

  assert.equal(readFileSync(join(to, "data", "secret.key"), "utf8"), "key", "the key that decrypts the tokens comes too");
  assert.equal(readFileSync(join(to, "data", "uploads", "a.mp4"), "utf8"), "video");
  assert.ok(!existsSync(join(to, "data", "window")), "Chromium's cache is left behind");
  assert.equal(readFileSync(join(to, ".env"), "utf8").trim(), "YOUTUBE_CLIENT_ID=abc", "its own port, no webhook");

  const db = new DatabaseSync(join(to, "data", "freeposter.db"), { readOnly: true });
  const post = db.prepare("SELECT source_path, meta FROM posts").get() as { source_path: string; meta: string };
  const moved = join(to, "data", "uploads", "a.mp4");
  assert.equal(post.source_path, moved, "paths point at the copy's own files");
  assert.equal(JSON.parse(post.meta).file, moved, "including paths inside JSON");
  assert.deepEqual(db.prepare("SELECT state FROM jobs ORDER BY id").all().map((r: any) => r.state), ["published", "failed"], "nothing left to post");
  assert.deepEqual(db.prepare("SELECT key FROM prefs").all().map((r: any) => r.key), ["accounts.sets"], "Telegram unpaired");
  assert.deepEqual({ ...(db.prepare("SELECT enabled, autorun FROM campaigns").get() as object) }, { enabled: 0, autorun: 0 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM drive_connection").get() as { n: number }).n, 0, "Drive disconnected");
  assert.deepEqual(db.prepare("SELECT platform, refresh_token FROM accounts ORDER BY id").all().map((r: any) => [r.platform, r.refresh_token]),
    [["x", null], ["tiktok", null], ["youtube", "ry"]], "rotating refresh tokens stay with the installed app");
  db.close();

  const original = new DatabaseSync(join(from, "data", "freeposter.db"), { readOnly: true });
  assert.equal((original.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, 4);
  assert.equal((original.prepare("SELECT source_path FROM posts").get() as { source_path: string }).source_path, join(from, "data", "uploads", "a.mp4"));
  original.close();
  assert.match(readFileSync(join(from, ".env"), "utf8"), /NOTIFY_WEBHOOK_URL/);
});

test("a development folder with data is only replaced when asked, and then set aside rather than deleted", () => {
  const from = installedHome();
  const to = join(tmp(), "FreePoster-dev");
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, ".env"), "MINE=1\n");
  assert.throws(() => copyHome(from, to), /--replace/);
  assert.equal(readFileSync(join(to, ".env"), "utf8"), "MINE=1\n");

  const { backup } = copyHome(from, to, { replace: true });
  assert.equal(readFileSync(join(backup!, ".env"), "utf8"), "MINE=1\n");
  assert.match(readFileSync(join(to, ".env"), "utf8"), /YOUTUBE_CLIENT_ID/);
});

test("nothing is copied from an installed folder that has no data", () => {
  assert.throws(() => copyHome(join(tmp(), "FreePoster"), join(tmp(), "FreePoster-dev")), /no settings or data/);
});
