import "./isolated-home.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAccountSet } from "../src/accounts.ts";
import { publishers } from "../src/platforms/index.ts";
import { resourcesDir } from "../src/resources/store.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { makeVideo, mcpFixture, multipart, newStore, tmp } from "./helpers.ts";

const png = () => readFileSync(makeVideo(tmp(), "a.png", ["-f", "lavfi", "-i", "color=red:s=64x64", "-frames:v", "1"]));
const mp3 = () => readFileSync(makeVideo(tmp(), "a.mp3", ["-f", "lavfi", "-i", "sine=frequency=440", "-t", "3"]));

function setup() {
  const store = newStore();
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers);
  const upload = (name: string, data: Buffer, fields: Record<string, string> = { setId: "1" }) =>
    app.inject({ method: "POST", url: "/api/resources", ...multipart(fields, { name, data }) });
  return { store, app, upload };
}

test("upload, list, rename, delete", async () => {
  const { app, upload } = setup();
  const up = await upload("logo.png", png());
  assert.equal(up.statusCode, 200, up.body);
  const id = up.json().id;
  const list = (await app.inject("/api/resources")).json();
  const set1 = list.sets.find((s: any) => s.id === 1);
  assert.equal(set1.resources[0].kind, "image");
  assert(!JSON.stringify(list).includes(resourcesDir().replace(/\\/g, "\\\\")));
  assert(!JSON.stringify(list).includes('"path"'));
  const patched = await app.inject({ method: "PATCH", url: `/api/resources/${id}`, payload: { tag: "brand-logo" } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().tag, "brand-logo");
  assert.equal((await app.inject({ method: "DELETE", url: `/api/resources/${id}` })).statusCode, 200);
  const after = (await app.inject("/api/resources")).json();
  assert.equal(after.sets[0].resources.length, 0);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/resources/${id}` })).statusCode, 404);
});

test("text resources", async () => {
  const { app } = setup();
  const made = await app.inject({ method: "POST", url: "/api/resources/text", payload: { setId: 1, name: "Brand notes", text: "We are Acme." } });
  assert.equal(made.statusCode, 200, made.body);
  assert.equal(made.json().textPreview, "We are Acme.");
  const patched = await app.inject({ method: "PATCH", url: `/api/resources/${made.json().id}`, payload: { text: "We are Acme Inc." } });
  assert.equal(patched.json().textPreview, "We are Acme Inc.");
});

test("bad input", async () => {
  const { app, upload } = setup();
  const noSet = await upload("logo.png", png(), { setId: "99" });
  assert.equal(noSet.statusCode, 400);
  assert.match(noSet.json().error, /no such account set/);
  const badTag = await upload("logo.png", png(), { setId: "1", tag: "Bad Tag" });
  assert.equal(badTag.statusCode, 400);
  const ok = await upload("logo.png", png());
  const r = await app.inject({ method: "PATCH", url: `/api/resources/${ok.json().id}`, payload: { text: "x" } });
  assert.equal(r.statusCode, 400);
  const junk = await upload("x.bin", Buffer.from([0, 255, 3, 4, 200, 1, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]));
  assert.equal(junk.statusCode, 400);
  assert.match(junk.json().error, /text, audio, image or video/);
});

test("file route serves ranges", async () => {
  const { app, upload } = setup();
  const up = await upload("song.mp3", mp3());
  assert.equal(up.json().kind, "audio");
  const res = await app.inject({ method: "GET", url: up.json().url, headers: { range: "bytes=0-9" } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-length"], "10");
  assert.match(String(res.headers["content-type"]), /^audio\//);
});

test("a set with resources can't be deleted", async () => {
  const { app, store } = setup();
  const made = createAccountSet(store, "Second") as { id: number };
  const text = await app.inject({ method: "POST", url: "/api/resources/text", payload: { setId: made.id, name: "n", text: "hello" } });
  assert.equal(text.statusCode, 200);
  const blocked = await app.inject({ method: "DELETE", url: `/api/account-sets/${made.id}` });
  assert.equal(blocked.statusCode, 400);
  assert.match(blocked.json().error, /delete this set's resources first/);
  await app.inject({ method: "DELETE", url: `/api/resources/${text.json().id}` });
  assert.equal((await app.inject({ method: "DELETE", url: `/api/account-sets/${made.id}` })).statusCode, 200);
});

test("mcp add_resource and list_resources", async () => {
  const { call, store } = mcpFixture();
  createAccountSet(store, "Other");
  const added = await call("add_resource", { account_set: "PersonalBrand", name: "Notes", text: "hello" });
  assert.notEqual(added.isError, true, JSON.stringify(added));
  const listed = await call("list_resources", { account_set: "PersonalBrand" });
  assert.deepEqual(listed.structuredContent.sets.map((s: any) => s.resources.map((r: any) => r.tag)), [["notes"]]);
  assert.equal((await call("add_resource", { account_set: "Nope", text: "x" })).isError, true);
  assert.equal((await call("add_resource", { text: "x", file_path: "/a" })).isError, true);
});
