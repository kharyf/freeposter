import "./isolated-home.ts"; // first: config.ts reads FREEPOSTER_HOME when it loads
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { config, envFile, redirectUri, reloadConfig } from "../src/config.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { mockFetch, newStore, tmp } from "./helpers.ts";

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

test("the redirect folder is made from the templates with the owner's details, and keeps TikTok's files", async () => {
  writeFileSync(envFile, "");
  reloadConfig();
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, payload });

  assert.equal((await post("/api/redirect-page/folder")).statusCode, 400, "details first");
  assert.equal((await app.inject({ method: "PUT", url: "/api/settings", payload: { values: { SITE_CONTACT_EMAIL: "nope" } } })).statusCode, 400);
  await app.inject({ method: "PUT", url: "/api/settings", payload: { values: { SITE_OWNER_NAME: "Kim & Co", SITE_CONTACT_EMAIL: "kim@example.com" } } });
  const res = await post("/api/redirect-page/folder");
  assert.equal(res.statusCode, 200, res.body);
  const dir = res.json().path;
  assert.deepEqual(readdirSync(dir).sort(), ["_headers", "forward.js", "index.html", "privacy.html", "terms.html"]);
  for (const name of ["terms.html", "privacy.html"]) {
    const text = readFileSync(join(dir, name), "utf8");
    assert.ok(!text.includes("{{"), `${name} has no placeholders left`);
    assert.match(text, /Kim &amp; Co/);
    assert.match(text, /mailto:kim@example\.com/);
    assert.ok(!/sign-in/i.test(text));
  }
  assert.match(readFileSync(join(dir, "index.html"), "utf8"), /<meta name="freeposter-redirect" content="1">/);

  assert.equal((await post("/api/redirect-page/tiktok-file", { name: "evil.html", content: "x" })).statusCode, 400);
  assert.equal((await post("/api/redirect-page/tiktok-file", { name: "tiktokAbc123.txt", content: "tiktok-developers-site-verification=abc" })).statusCode, 200);
  await post("/api/redirect-page/folder");
  assert.ok(existsSync(join(dir, "tiktokAbc123.txt")), "kept across regenerations");
  assert.deepEqual((await app.inject("/api/settings")).json().tiktokFiles, ["tiktokAbc123.txt"]);

  await app.close();
  writeFileSync(envFile, "");
  reloadConfig();
});

test("the address check opens the page, and Continue anyway lasts until the details change", async () => {
  writeFileSync(envFile, "SITE_OWNER_NAME=Kim\nSITE_CONTACT_EMAIL=kim@example.com\nYOUTUBE_CLIENT_ID=a\nYOUTUBE_CLIENT_SECRET=b\n");
  reloadConfig();
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  const check = async () => (await app.inject({ method: "POST", url: "/api/redirect-page/check" })).json();
  const view = async () => (await app.inject("/api/settings")).json();

  assert.equal((await app.inject("/connect/youtube")).statusCode, 400, "no Connect without a redirect URI");
  assert.equal((await app.inject("/api/status")).json().needsRedirectPage, true);
  await app.inject({ method: "PUT", url: "/api/settings", payload: { values: { REDIRECT_PAGE_URL: "https://kim-freeposter.pages.dev" } } });
  assert.equal((await app.inject("/connect/youtube")).statusCode, 302);

  const pages: Record<string, string> = {};
  const fake = mockFetch((url) => (url in pages ? new Response(pages[url]) : new Response("not found", { status: 404 })));
  try {
    assert.match((await check()).reason, /didn't open/);
    pages["https://kim-freeposter.pages.dev/"] = "<html>someone else's site</html>";
    assert.match((await check()).reason, /isn't your FreePoster redirect page/);
    pages["https://kim-freeposter.pages.dev/"] = '<meta name="freeposter-redirect" content="1">';
    pages["https://kim-freeposter.pages.dev/terms"] = "Old Name old@example.com";
    pages["https://kim-freeposter.pages.dev/privacy"] = "privacy";
    assert.match((await check()).reason, /old details/);
    pages["https://kim-freeposter.pages.dev/terms"] = "Kim kim@example.com";
    assert.deepEqual(await check(), { ok: true });
    assert.equal((await view()).redirectDone, true);
  } finally {
    fake.restore();
  }

  // new details make the deployed Terms stale
  await app.inject({ method: "PUT", url: "/api/settings", payload: { values: { SITE_OWNER_NAME: "Kim Lee" } } });
  assert.equal((await view()).redirectDone, false);
  await app.inject({ method: "POST", url: "/api/redirect-page/accept" });
  assert.equal((await view()).redirectDone, true, "Continue anyway");

  // a new address: every console still has the old one until setup is finished
  await app.inject({ method: "PUT", url: "/api/settings", payload: { values: { REDIRECT_PAGE_URL: "https://kim2.pages.dev" } } });
  assert.equal((await view()).redirectChangedFrom, "https://kim-freeposter.pages.dev/");
  await app.inject({ method: "PUT", url: "/api/setup", payload: { complete: true } });
  assert.equal((await view()).redirectChangedFrom, null);

  await app.close();
  writeFileSync(envFile, "");
  reloadConfig();
});
