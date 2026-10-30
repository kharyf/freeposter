import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, multipart, newStore, tmp, verticalSilent } from "./helpers.ts";

test("upload → render → publish → history, with the duplicate guard", async () => {
  const dir = tmp();
  const video = readFileSync(verticalSilent(dir));
  const store = newStore();
  const xAcct = store.upsertAccount(account("x"));
  const published: string[] = [];
  const fakeX: Publisher = {
    ...real.x,
    async publish(ctx) {
      published.push(ctx.post.caption);
      return { url: "https://x.com/xuser/status/42" };
    },
  };
  const runner = new Runner(store, { ...real, x: fakeX } as Record<Platform, Publisher>, dir);
  const app = buildServer(store, runner, { ...real, x: fakeX });

  // caption too long for X is rejected before anything is queued
  let res = await app.inject({ method: "POST", url: "/api/posts", ...multipart({ caption: "a".repeat(300), accounts: `[${xAcct.id}]` }, { name: "v.mp4", data: video }) });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /X .*280/);

  res = await app.inject({ method: "POST", url: "/api/posts", ...multipart({ caption: "ship it", accounts: `[${xAcct.id}]` }, { name: "v.mp4", data: video }) });
  assert.equal(res.statusCode, 200, res.body);
  // wait for the background job the request kicked off
  for (let i = 0; i < 100 && store.jobsForPost(res.json().postId)[0].state !== "published"; i++) await new Promise((r) => setTimeout(r, 100));

  const history = (await app.inject("/api/posts")).json();
  assert.equal(history[0].jobs[0].state, "published");
  assert.equal(history[0].jobs[0].url, "https://x.com/xuser/status/42");
  assert.deepEqual(published, ["ship it"]);

  // same file again → 409 unless explicitly allowed
  res = await app.inject({ method: "POST", url: "/api/posts", ...multipart({ caption: "again", accounts: `[${xAcct.id}]` }, { name: "v.mp4", data: video }) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().duplicate, true);

  // tokens never leave the server
  const status = (await app.inject("/api/status")).body;
  assert.ok(!status.includes("access-1") && !status.includes("refresh-1"));
  // and are encrypted at rest
  const raw = store.db.prepare("SELECT access_token FROM accounts").get() as { access_token: string };
  assert.notEqual(raw.access_token, "access-1");

  await app.close();
});
