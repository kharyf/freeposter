import "./isolated-home.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { main } from "../src/cli.ts";
import { config } from "../src/config.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { account, newStore, tmp } from "./helpers.ts";

let app: ReturnType<typeof buildServer>;
let url: string;
const saved = { port: config.port, baseUrl: config.baseUrl, appPassword: config.appPassword };

before(async () => {
  const store = newStore();
  store.upsertAccount(account("x"));
  app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  // The MCP endpoint only answers its own host name.
  config.port = port;
  config.baseUrl = `http://localhost:${port}`;
  url = `http://localhost:${port}`;
});
after(async () => {
  Object.assign(config, saved);
  await app.close();
});

function io(env: Record<string, string> = {}, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: { FREEPOSTER_URL: url, ...env }, isTTY: false, stdin: async () => stdin },
    out: () => out.join("\n"),
    err: () => err.join("\n"),
  };
}

test("accounts prints the tool's JSON", async () => {
  const t = io();
  assert.equal(await main(["accounts"], t.io), 0);
  const parsed = JSON.parse(t.out());
  assert.equal(parsed.accounts[0].platform, "x");
});

test("call runs any tool with JSON arguments", async () => {
  const t = io();
  assert.equal(await main(["call", "list_posts", '{"limit": 5}'], t.io), 0);
  assert.deepEqual(JSON.parse(t.out()).posts, []);
});

test("an unknown command is a usage error", async () => {
  const t = io();
  assert.equal(await main(["frobnicate"], t.io), 2);
  assert.match(t.err(), /usage/i);
});

test("a tool error exits 1 with the message on stderr", async () => {
  const t = io();
  assert.equal(await main(["posts", "999"], t.io), 1);
  assert.match(t.err(), /no post 999/);
});

test("FreePoster not running exits 3", async () => {
  const t = io({ FREEPOSTER_URL: "http://localhost:1" });
  assert.equal(await main(["accounts"], t.io), 3);
  assert.match(t.err(), /isn't running/);
});

test("a wrong app password exits 4", async () => {
  config.appPassword = "right";
  try {
    const t = io({ FREEPOSTER_PASSWORD: "wrong" });
    assert.equal(await main(["accounts"], t.io), 4);
    const ok = io({ FREEPOSTER_PASSWORD: "right" });
    assert.equal(await main(["accounts"], ok.io), 0);
  } finally {
    config.appPassword = saved.appPassword;
  }
});

test("produce - reads the spec from stdin", async () => {
  const t = io({}, JSON.stringify({ shots: [{ id: "a", kind: "wan", duration_sec: 2 }] }));
  // No production worker in this server, but the spec still reaches the tool: it answers with the tool's error.
  assert.equal(await main(["produce", "-", "--dry-run"], t.io), 1);
  assert.match(t.err(), /productions aren't available/);
});
