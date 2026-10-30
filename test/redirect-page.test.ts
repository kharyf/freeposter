import "./isolated-home.ts"; // first: config.ts reads FREEPOSTER_HOME when it loads
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { config, envFile, redirectUri, reloadConfig } from "../src/config.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { newStore, tmp } from "./helpers.ts";

test("sign-ins go through the hosted redirect page and come back to /callback", async () => {
  writeFileSync(envFile, "YOUTUBE_CLIENT_ID=yt-id\nYOUTUBE_CLIENT_SECRET=yt-secret\n");
  reloadConfig();
  const store = newStore();
  const signIns: string[] = [];
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers, { onSignIn: (q) => signIns.push(q) });
  const put = (values: Record<string, string>) => app.inject({ method: "PUT", url: "/api/settings", payload: { values } });

  // only an https page is accepted
  assert.equal((await put({ REDIRECT_PAGE_URL: "http://relay.example" })).statusCode, 400);
  const res = await put({ REDIRECT_PAGE_URL: "https://relay.example" });
  assert.equal(res.statusCode, 200, res.body);
  const view = res.json();
  assert.equal(view.redirectPage, "https://relay.example/");
  assert.deepEqual(new Set(Object.values(view.redirectUris)), new Set(["https://relay.example/"]), "one address for every platform");
  assert.equal(redirectUri("tiktok"), "https://relay.example/");

  // the sign-in starts with the port in state, and tells Google to return to the page
  const connect = await app.inject("/connect/youtube");
  assert.equal(connect.statusCode, 302);
  const google = new URL(connect.headers.location as string);
  assert.equal(google.searchParams.get("redirect_uri"), "https://relay.example/");
  const state = google.searchParams.get("state")!;
  assert.match(state, new RegExp(`^${config.port}\\.`));

  // a public address with a password: the forwarded callback still gets through without one
  await put({ BASE_URL: "https://me.example.com", APP_PASSWORD: "hunter2" });
  const back = await app.inject(`/callback?${new URLSearchParams({ state, error: "access_denied", error_description: "You cancelled" })}`);
  assert.equal(back.statusCode, 200);
  assert.match(back.body, /You can close this tab/);
  assert.deepEqual(signIns.map((q) => Object.fromEntries(new URLSearchParams(q))), [{ error: "youtube: You cancelled" }],
    "the platform is worked out from state");

  // a state that wasn't started here
  const stray = await app.inject("/callback?state=4400.nope&code=x");
  assert.equal(stray.statusCode, 302);
  assert.match(new URL(stray.headers.location as string, "http://x").searchParams.get("error")!, /expired or was not started here/);

  await app.close();
  writeFileSync(envFile, "");
  reloadConfig();
});
