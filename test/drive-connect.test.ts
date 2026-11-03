import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { json, mockFetch, newStore, tmp } from "./helpers.ts";

test("connecting Google Drive asks for read-only access and stores the sign-in", async (t) => {
  const saved = config.credentials.youtube;
  config.credentials.youtube = { id: "google-client", secret: "google-secret" };
  t.after(() => { config.credentials.youtube = saved; });
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);

  const refused = await app.inject("/connect/drive");
  assert.equal(refused.statusCode, 400, "no redirect URI yet");
  assert.match(refused.body, /redirect URI/);
  const page = config.redirectPage;
  config.redirectPage = "https://me-freeposter.pages.dev/";
  t.after(() => { config.redirectPage = page; });

  const start = await app.inject("/connect/drive");
  assert.equal(start.statusCode, 302);
  const auth = new URL(start.headers.location as string);
  assert.equal(auth.host, "accounts.google.com");
  assert.equal(auth.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.readonly");
  assert.equal(auth.searchParams.get("client_id"), "google-client");
  const state = auth.searchParams.get("state")!;

  const fake = mockFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    if (url.includes("/drive/v3/about")) return json({ user: { emailAddress: "me@example.com" } });
    return new Response("", { status: 404 });
  });
  t.after(fake.restore);
  const back = await app.inject(`/callback?state=${encodeURIComponent(state)}&code=abc`);
  assert.equal(back.statusCode, 302);
  assert.match(String(back.headers.location), /connected=/);
  const conn = store.driveConnection()!;
  assert.equal(conn.email, "me@example.com");
  assert.equal(conn.refreshToken, "rt");
  assert.equal(store.accounts().length, 0, "Drive is not a posting account");
});
