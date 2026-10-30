import "./isolated-home.ts"; // first: config.ts reads FREEPOSTER_HOME when it loads
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { config, envFile, reloadConfig } from "../src/config.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { newStore, tmp } from "./helpers.ts";

const put = (url: string, body: unknown) => ({ method: "PUT" as const, url, payload: body as object });

test("setup screen saves settings to .env, hides secrets, and enables platforms", async () => {
  writeFileSync(envFile, "# my notes\nYOUTUBE_CLIENT_ID=old\nOTHER=kept\n");
  reloadConfig();
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);

  let status = (await app.inject("/api/status")).json();
  assert.equal(status.setupComplete, false);
  assert.equal(status.platforms.find((p: any) => p.platform === "facebook").configured, false);

  let res = await app.inject(put("/api/settings", { values: {
    YOUTUBE_CLIENT_ID: "yt-id", YOUTUBE_CLIENT_SECRET: "yt secret#1", FACEBOOK_APP_ID: "fb-id", FACEBOOK_APP_SECRET: "fb-secret", DAILY_CAP_X: "7",
  } }));
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json();
  assert.deepEqual([view.configured.youtube, view.configured.facebook, view.configured.instagram, view.configured.x], [true, true, true, false]);
  assert.equal(view.redirectUris.instagram, "https://freeposter.pages.dev/", "the hosted redirect page by default");
  assert.ok(!res.body.includes("yt secret#1") && !res.body.includes("fb-secret"), "secrets are never sent back");
  assert.equal(view.secretsSet.YOUTUBE_CLIENT_SECRET, true);

  // .env keeps unrelated lines, updates in place, and quotes values that need it
  const text = readFileSync(envFile, "utf8");
  assert.match(text, /^# my notes$/m);
  assert.match(text, /^OTHER=kept$/m);
  assert.match(text, /^YOUTUBE_CLIENT_ID=yt-id$/m);
  assert.match(text, /^YOUTUBE_CLIENT_SECRET='yt secret#1'$/m);
  assert.equal(config.credentials.youtube.secret, "yt secret#1");
  assert.equal(config.dailyCap.x, 7);

  // a blank secret keeps the saved one
  await app.inject(put("/api/settings", { values: { YOUTUBE_CLIENT_SECRET: "" } }));
  assert.equal(config.credentials.youtube.secret, "yt secret#1");

  // bad input is refused as a whole
  res = await app.inject(put("/api/settings", { values: { DAILY_CAP_X: "lots", NOT_A_SETTING: "x" } }));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /DAILY_CAP_X/);
  assert.match(res.json().error, /NOT_A_SETTING/);
  assert.equal(config.dailyCap.x, 7);

  // a blank address means localhost, which needs no password
  res = await app.inject(put("/api/settings", { values: { BASE_URL: "", PORT: "", APP_PASSWORD: "" } }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(config.baseUrl, "http://localhost:4400");

  // a public address needs a password, which then guards every page
  res = await app.inject(put("/api/settings", { values: { BASE_URL: "https://me.example.com/" } }));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /password/);
  res = await app.inject(put("/api/settings", { values: { BASE_URL: "https://me.example.com/", APP_PASSWORD: "hunter2" } }));
  assert.equal(res.statusCode, 200);
  assert.equal(config.baseUrl, "https://me.example.com");
  assert.equal((await app.inject("/api/settings")).statusCode, 401);
  const auth = { authorization: `Basic ${Buffer.from("me:hunter2").toString("base64")}` };
  assert.equal((await app.inject({ url: "/api/settings", headers: auth })).statusCode, 200);
  // with the redirect page switched off, sign-ins return to the public address directly
  await app.inject({ ...put("/api/settings", { values: { REDIRECT_PAGE_URL: "off" } }), headers: auth });
  assert.equal((await app.inject({ url: "/api/settings", headers: auth })).json().redirectUris.x, "https://me.example.com/callback/x");
  assert.equal((await app.inject("/api/ping")).statusCode, 200, "the desktop launcher can still find a running copy");

  await app.inject({ ...put("/api/setup", { complete: true }), headers: auth });
  status = (await app.inject({ url: "/api/status", headers: auth })).json();
  assert.equal(status.setupComplete, true);
  assert.equal(status.desktop, false);
  assert.equal((await app.inject({ ...put("/api/quit", {}), headers: auth })).statusCode, 404, "quit only exists in the desktop app");

  await app.close();
  writeFileSync(envFile, "");
  reloadConfig();
});
