import "./isolated-home.ts"; // first: config.ts reads FREEPOSTER_HOME when it loads
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { homeFolder } from "../src/config.ts";
import { tmp } from "./helpers.ts";

const withData = (dir: string, env: string) => {
  mkdirSync(join(dir, "data", "window"), { recursive: true });
  writeFileSync(join(dir, ".env"), env);
  writeFileSync(join(dir, "data", "freeposter.db"), "accounts");
  writeFileSync(join(dir, "data", "secret.key"), "key");
  writeFileSync(join(dir, "data", "window", "Cache"), "chromium");
};

test("every build uses the per-user folder, so accounts stay connected across updates", () => {
  const user = join(tmp(), "FreePoster");
  withData(user, "PORT=4400\n");
  const checkout = tmp();
  withData(checkout, "PORT=5500\n");
  assert.equal(homeFolder(user, checkout), user);
  assert.equal(readFileSync(join(user, ".env"), "utf8"), "PORT=4400\n", "the per-user folder is never overwritten");
});

test("a checkout's settings and data are copied into a per-user folder that has none yet", () => {
  const user = join(tmp(), "FreePoster");
  const checkout = tmp();
  withData(checkout, "YOUTUBE_CLIENT_ID=abc\n");
  assert.equal(homeFolder(user, checkout), user);
  assert.equal(readFileSync(join(user, ".env"), "utf8"), "YOUTUBE_CLIENT_ID=abc\n");
  assert.equal(readFileSync(join(user, "data", "freeposter.db"), "utf8"), "accounts");
  assert.equal(readFileSync(join(user, "data", "secret.key"), "utf8"), "key", "the key that decrypts the tokens comes too");
  assert.ok(!existsSync(join(user, "data", "window")), "Chromium's cache is left behind");
  assert.ok(existsSync(join(checkout, "data", "freeposter.db")), "the checkout's copy stays");
});

test("a fresh install with nothing to bring over starts empty", () => {
  const user = join(tmp(), "FreePoster");
  assert.equal(homeFolder(user, tmp()), user);
  assert.equal(homeFolder(user), user);
  assert.ok(!existsSync(join(user, ".env")));
});

test("the window has an Analytics tab and its panel", async () => {
  const { buildServer } = await import("../src/server.ts");
  const { Runner } = await import("../src/runner.ts");
  const { publishers } = await import("../src/platforms/index.ts");
  const { newStore } = await import("./helpers.ts");
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  const res = await app.inject("/");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes(`id="tabAnalytics"`), "the Analytics tab button");
  assert.ok(res.body.includes(`id="analytics"`), "the Analytics panel");
});

test("the window has a Campaigns tab, its panel and the Autorun warning", async () => {
  const { buildServer } = await import("../src/server.ts");
  const { Runner } = await import("../src/runner.ts");
  const { publishers } = await import("../src/platforms/index.ts");
  const { newStore } = await import("./helpers.ts");
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  const res = await app.inject("/");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes(`id="tabCampaigns"`), "the Campaigns tab button");
  assert.ok(res.body.includes(`id="campaigns"`), "the Campaigns panel");
  assert.ok(res.body.includes(`id="autorun-warning"`), "the dialog that says what Autorun may and may not do");
});

test("the window's own script parses (a syntax slip would leave every tab blank)", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s));
});
