import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import { createEditFor, isManifestSource } from "../src/edit/create.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { probe } from "../src/media.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers } from "../src/platforms/index.ts";
import { ResourceStore } from "../src/resources/store.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, makeVideo, mcpFixture, multipart, newStore, tmp, verticalSilent } from "./helpers.ts";

const png = () => makeVideo(tmp(), "a.png", ["-f", "lavfi", "-i", "color=red:s=64x64", "-frames:v", "1"]);
const SLIDESHOW = { ...DEFAULT_EDIT, look: "slideshow" as const };

test("a video-less slideshow gets a manifest source and is cached by its key", () => {
  const store = newStore();
  const rs = new ResourceStore(store);
  const settings = { ...SLIDESHOW, instructions: "3 tips" };
  const a = createEditFor(store, rs, { source: null, settings, setId: 1, refs: [] });
  assert.equal(typeof a, "object");
  const edit = a as any;
  assert.ok(isManifestSource(edit.sourcePath));
  assert.equal(JSON.parse(readFileSync(edit.sourcePath, "utf8")).instructions, "3 tips");
  const b = createEditFor(store, rs, { source: null, settings, setId: 1, refs: [] }) as any;
  assert.equal(b.id, edit.id);
  assert.equal(edit.settings.setId, 1);
  assert.equal(edit.settings.resources, undefined);
});

test("only a slideshow can be made without a video; it needs something to go on", () => {
  const store = newStore();
  const rs = new ResourceStore(store);
  assert.equal(createEditFor(store, rs, { source: null, settings: DEFAULT_EDIT, setId: 1, refs: [] }), "only a slideshow can be made without a video");
  assert.equal(createEditFor(store, rs, { source: null, settings: SLIDESHOW, setId: 1, refs: [] }), "a slideshow without a video needs instructions or tagged resources");
});

test("tagged resources are resolved into the edit's settings with their files", async () => {
  const store = newStore();
  const rs = new ResourceStore(store);
  const logo = (await rs.addFile(1, png(), "logo.png", { tag: "logo" })) as any;
  const edit = createEditFor(store, rs, { source: null, settings: SLIDESHOW, setId: 1, refs: [{ tag: "logo" }] }) as any;
  assert.deepEqual(edit.settings.resources.map((r: any) => [r.tag, r.as, r.path]), [["logo", "slide", logo.path]]);
  assert.equal(createEditFor(store, rs, { source: null, settings: SLIDESHOW, setId: 1, refs: [{ tag: "nope" }] }), "no resource tagged @nope in the account set Personal Brand");
});

function server() {
  const store = newStore();
  const fb = store.upsertAccount(account("facebook"));
  const captured: { path?: string } = {};
  const fakeFb: Publisher = { ...publishers.facebook, async publish(ctx) { captured.path = ctx.videoPath; return { url: "https://facebook.com/x" }; } };
  const pubs = { ...publishers, facebook: fakeFb } as Record<Platform, Publisher>;
  const runner = new Runner(store, pubs, tmp());
  const app = buildServer(store, runner, pubs);
  return { store, fb, app, runner, captured };
}

test("POST /api/edits makes a slideshow edit with no video, and shows no resource paths", async () => {
  const { app, store } = server();
  const rs = new ResourceStore(store);
  const logo = (await rs.addFile(1, png(), "logo.png", { tag: "logo" })) as any;
  const res = await app.inject({ method: "POST", url: "/api/edits", ...multipart({ settings: JSON.stringify({ look: "slideshow", instructions: "3 tips with @logo" }) }) });
  assert.equal(res.statusCode, 200, res.body);
  const view = (await app.inject(`/api/edits/${res.json().editId}`)).json();
  assert.equal(view.hasSourceVideo, false);
  assert.equal(view.sourceDurationSec, null);
  assert.deepEqual(view.settings.resources, [{ id: logo.id, tag: "logo", kind: "image", as: "slide" }]);
  assert(!JSON.stringify(view).includes(logo.path.replace(/\\/g, "\\\\")));
  const none = await app.inject({ method: "POST", url: "/api/edits", ...multipart({ settings: "{}" }) });
  assert.equal(none.statusCode, 400);
  assert.match(none.json().error, /attach a video file/);
  const empty = await app.inject({ method: "POST", url: "/api/edits", ...multipart({ settings: JSON.stringify({ look: "slideshow" }) }) });
  assert.match(empty.json().error, /needs instructions or tagged resources/);
  const set = await app.inject({ method: "POST", url: "/api/edits", ...multipart({ settings: JSON.stringify({ look: "slideshow", instructions: "x" }), setId: "9" }) });
  assert.match(set.json().error, /no such account set/);
});

test("a video-less slideshow edit posts its output", async () => {
  const { app, store, fb, runner, captured } = server();
  const made = await app.inject({ method: "POST", url: "/api/edits", ...multipart({ settings: JSON.stringify({ look: "slideshow", instructions: "3 tips" }) }) });
  const editId = made.json().editId;
  const output = verticalSilent(tmp(), 5);
  store.updateEdit(editId, { state: "ready", outputPath: output, durationSec: 5, progress: 1 });
  assert.equal((await app.inject({ method: "PUT", url: `/api/edits/${editId}/approve` })).statusCode, 200);
  const res = await app.inject({ method: "POST", url: "/api/posts", ...multipart({ caption: "hi", accounts: `[${fb.id}]`, editId: String(editId) }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.post(res.json().postId)!.requireEdit, true);
  for (let i = 0; i < 100 && !captured.path; i++) { await Promise.all(runner.tick()); await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(captured.path && existsSync(captured.path), "the post was uploaded");
  assert.equal(basename(captured.path!), `${store.edit(editId)!.key}.mp4`, "it is the edit's output, not the manifest");
  assert.ok(Math.abs((await probe(captured.path!)).durationSec - 5) < 0.3);
});

test("MCP create_edit with a set, tags and no video; revise_edit keeps the resources", async () => {
  const { call, store } = mcpFixture();
  await call("add_resource", { account_set: "PersonalBrand", file_path: png(), tag: "logo" });
  const made = await call("create_edit", { settings: { look: "slideshow", instructions: "x @logo" }, account_set: "PersonalBrand" });
  assert.notEqual(made.isError, true, JSON.stringify(made));
  assert.deepEqual(made.structuredContent.settings.resources.map((r: any) => [r.tag, r.as, r.path]), [["logo", "slide", undefined]]);
  const editId = made.structuredContent.id;
  store.updateEdit(editId, { state: "ready", outputPath: verticalSilent(tmp()), durationSec: 4, progress: 1 });
  const revised = await call("revise_edit", { edit_id: editId, settings: { instructions: "y @logo" } });
  assert.notEqual(revised.isError, true, JSON.stringify(revised));
  assert.equal(revised.structuredContent.settings.resources.length, 1);
  assert.equal(revised.structuredContent.settings.instructions, "y @logo");
  assert.equal((await call("create_edit", { settings: { look: "slideshow", instructions: "@nope" } })).isError, true);
  assert.equal((await call("create_edit", { settings: {} })).isError, true);
});
