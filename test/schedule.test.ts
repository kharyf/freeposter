import "./isolated-home.ts"; // first: keeps uploads out of the real data/ folder
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Store } from "../src/db.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, multipart, newStore, tmp, verticalSilent } from "./helpers.ts";

const HOUR = 3_600_000;

test("scheduled posts wait for their time, and can be moved, posted early, or cancelled", async () => {
  const dir = tmp();
  const video = { name: "v.mp4", data: readFileSync(verticalSilent(dir)) };
  const store = newStore();
  const xAcct = store.upsertAccount(account("x"));
  const published: string[] = [];
  const fakeX: Publisher = {
    ...real.x,
    async publish(ctx) {
      published.push(ctx.post.caption);
      return { url: `https://x.com/xuser/status/${published.length}` };
    },
  };
  const runner = new Runner(store, { ...real, x: fakeX } as Record<Platform, Publisher>, dir);
  const app = buildServer(store, runner, { ...real, x: fakeX });
  const schedule = (caption: string, scheduledAt: number, extra: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/api/posts", ...multipart({ caption, accounts: `[${xAcct.id}]`, scheduledAt: String(scheduledAt), ...extra }, video) });
  const settle = async () => { await Promise.all(runner.tick()); };

  // a time in the past is refused before anything is queued
  let res = await schedule("too late", Date.now() - HOUR);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /already passed/);
  res = await schedule("too far", Date.now() + 400 * 24 * HOUR);
  assert.equal(res.statusCode, 400);

  const at = Date.now() + 2 * HOUR;
  res = await schedule("later", at);
  assert.equal(res.statusCode, 200, res.body);
  const postId = res.json().postId;
  await settle();
  assert.equal(store.jobsForPost(postId)[0].state, "queued", "not due yet, so the runner leaves it");
  assert.deepEqual(published, []);
  assert.equal(store.pendingJobCount(), 1);
  let listed = (await app.inject("/api/posts")).json()[0];
  assert.equal(listed.scheduledAt, at);
  assert.equal(listed.jobs[0].nextRunAt, at);

  // the same video can't be queued twice by accident
  res = await schedule("again", at);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().duplicate, true);

  // move it
  const moved = at + HOUR;
  res = await app.inject({ method: "PATCH", url: `/api/posts/${postId}`, payload: { scheduledAt: moved } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.jobsForPost(postId)[0].nextRunAt, moved);
  assert.equal(store.post(postId)!.scheduledAt, moved);
  res = await app.inject({ method: "PATCH", url: `/api/posts/${postId}`, payload: { scheduledAt: Date.now() - HOUR } });
  assert.equal(res.statusCode, 400);

  // post it now instead
  res = await app.inject({ method: "PATCH", url: `/api/posts/${postId}`, payload: { scheduledAt: null } });
  assert.equal(res.statusCode, 200, res.body);
  for (let i = 0; i < 100 && store.jobsForPost(postId)[0].state !== "published"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.jobsForPost(postId)[0].state, "published");
  assert.deepEqual(published, ["later"]);
  assert.equal(store.post(postId)!.scheduledAt, null);

  // once it has gone out it can't be moved or cancelled
  assert.equal((await app.inject({ method: "PATCH", url: `/api/posts/${postId}`, payload: { scheduledAt: moved } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/posts/${postId}` })).statusCode, 409);

  // cancelling removes the post and its uploaded video
  res = await schedule("never", Date.now() + HOUR, { allowDuplicate: "true" });
  assert.equal(res.statusCode, 200, res.body);
  const cancelId = res.json().postId;
  const upload = store.post(cancelId)!.sourcePath;
  assert.ok(existsSync(upload));
  res = await app.inject({ method: "DELETE", url: `/api/posts/${cancelId}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.post(cancelId), undefined);
  assert.equal(existsSync(upload), false);
  assert.equal(store.pendingJobCount(), 0);
  assert.deepEqual(published, ["later"]);

  await app.close();
});

test("a scheduled job becomes due at its time, and old databases gain the schedule column", async () => {
  const dir = tmp();
  const path = join(dir, "old.db");
  // the posts table as it was before scheduling
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, caption TEXT NOT NULL, title TEXT NOT NULL, source_path TEXT NOT NULL, sha256 TEXT NOT NULL, tiktok TEXT, created_at INTEGER NOT NULL)");
  old.exec("INSERT INTO posts VALUES (1, 'old post', '', '/x.mp4', 'abc', NULL, 1)");
  old.close();

  const store = new Store(path, randomBytes(32));
  assert.equal(store.post(1)!.scheduledAt, null);
  const acct = store.upsertAccount(account("x"));
  const postId = store.createPost({ caption: "hi", title: "", sourcePath: "/x.mp4", sha256: "def", tiktok: null, scheduledAt: Date.now() + HOUR }, [acct.id]);
  assert.equal(store.claimNextJob(new Set()), undefined);
  store.db.prepare("UPDATE jobs SET next_run_at = ? WHERE post_id = ?").run(Date.now() - 1, postId);
  assert.equal(store.claimNextJob(new Set())?.postId, postId);
  store.close();
});
