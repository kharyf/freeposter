import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Question } from "../src/ai/providers.ts";
import { planGraphics } from "../src/edit/fancy/plan.ts";
import { DEFAULT_EDIT, type EditSettings, type ResourceUse } from "../src/edit/settings.ts";
import { EditWorker } from "../src/edit/worker.ts";
import { probe } from "../src/media.ts";
import { ResourceStore } from "../src/resources/store.ts";
import { makeVideo, newStore, sha256, tmp, verticalSilent } from "./helpers.ts";

const words = [{ text: "hi", start: 0.5, end: 0.9 }, { text: "there", start: 3.0, end: 3.4 }];
const png = () => makeVideo(tmp(), "logo.png", ["-f", "lavfi", "-i", "color=red:s=300x100", "-frames:v", "1"]);
const setup = () => {
  const store = newStore();
  const dir = tmp();
  const worker = new EditWorker(store, { dir, findLyrics: async () => [], transcribe: async () => ({ words, language: null }) });
  return { store, dir, worker, video: verticalSilent(tmp(), 4) };
};
const run = (store: ReturnType<typeof newStore>, video: string, settings: EditSettings) => store.createEdit(video, sha256(video), settings);

test("a Basic edit with a logo is 1080x1920 and leaves no base file behind", async () => {
  const { store, dir, worker, video } = setup();
  const use: ResourceUse = { id: 1, tag: "logo", kind: "image", path: png(), sha256: "x", as: "overlay" };
  const edit = run(store, video, { ...DEFAULT_EDIT, resources: [use] });
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  const p = await probe(done.outputPath!);
  assert.deepEqual([p.width, p.height], [1080, 1920]);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".base.mp4")), "the base render is deleted");
  assert.equal(done.progress, 1);
});

test("extras still render after the resource is deleted", async () => {
  const { store, worker, video } = setup();
  const rs = new ResourceStore(store);
  const logo = (await rs.addFile(1, png(), "logo.png", { tag: "logo" })) as any;
  const use: ResourceUse = { id: logo.id, tag: "logo", kind: "image", path: logo.path, sha256: logo.sha256, as: "overlay" };
  const edit = run(store, video, { ...DEFAULT_EDIT, resources: [use] });
  assert.equal(rs.remove(logo.id), null);
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.ok(existsSync(done.outputPath!));
});

test("a Basic edit with a text resource says it ignored it", async () => {
  const { store, worker, video } = setup();
  const path = join(tmp(), "n.txt");
  writeFileSync(path, "notes");
  const use: ResourceUse = { id: 1, tag: "n", kind: "text", path, sha256: "x", as: "context" };
  const edit = run(store, video, { ...DEFAULT_EDIT, resources: [use] });
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.ok(done.notes.includes("text resources are only used by Fancy and Slideshow"));
});

test("Fancy's graphics plan gets the user's notes, and only when there are some", async () => {
  const w = Array.from({ length: 30 }, (_, i) => ({ text: `word${i}`, start: i * 0.6, end: i * 0.6 + 0.4 }));
  const prompts: string[] = [];
  const ask = async <T>(q: Question) => { prompts.push(q.prompt); throw new Error("no AI provider is connected"); void (null as T); };
  await planGraphics(w, 20, { ask, context: "brand is Acme" });
  await planGraphics(w, 20, { ask });
  assert.match(prompts[0], /Notes from the user for this video/);
  assert.match(prompts[0], /brand is Acme/);
  assert.doesNotMatch(prompts[1], /Notes from the user/);
});
