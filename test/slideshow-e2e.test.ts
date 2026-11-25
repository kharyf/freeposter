import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createEditFor } from "../src/edit/create.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { styleById, thumbnail } from "../src/edit/styles.ts";
import { EditWorker } from "../src/edit/worker.ts";
import { probe } from "../src/media.ts";
import { ResourceStore } from "../src/resources/store.ts";
import { landscape60, makeVideo, newStore, sha256, tmp } from "./helpers.ts";

const SLIDESHOW = { ...DEFAULT_EDIT, look: "slideshow" as const };
const noAi = async () => { throw new Error("no AI provider is connected"); };
const words = [{ text: "hello", start: 0.3, end: 0.7 }, { text: "world", start: 1.0, end: 1.4 }, { text: "again", start: 2.8, end: 3.2 }];
const png = (color: string) => makeVideo(tmp(), `${color}.png`, ["-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-frames:v", "1"]);

function setup() {
  const store = newStore();
  const rs = new ResourceStore(store);
  const dir = tmp();
  const worker = new EditWorker(store, { dir, findLyrics: async () => [], transcribe: async () => ({ words, language: null }), slideshow: { ask: noAi } });
  return { store, rs, dir, worker };
}

test("instructions only: a text card per sentence", async () => {
  const { store, rs, worker } = setup();
  const edit = createEditFor(store, rs, { source: null, settings: { ...SLIDESHOW, instructions: "First tip. Second tip. Third tip." }, setId: 1, refs: [] }) as any;
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  const p = await probe(done.outputPath!);
  assert.deepEqual([p.width, p.height], [1080, 1920]);
  assert.ok(Math.abs(p.durationSec - 12) < 0.2, `${p.durationSec}`);
  assert.ok(done.notes.some((n) => /no AI connected/.test(n)));
  assert.equal(done.cutsPath, null);
});

test("tagged images and music: the music sets the length and loops to fill it", async () => {
  const { store, rs, worker } = setup();
  await rs.addFile(1, png("red"), "a.png", { tag: "a" });
  await rs.addFile(1, png("blue"), "b.png", { tag: "b" });
  await rs.addFile(1, makeVideo(tmp(), "s.mp3", ["-f", "lavfi", "-i", "sine=frequency=330", "-t", "5"]), "song.mp3", { tag: "song" });
  const edit = createEditFor(store, rs, { source: null, settings: { ...SLIDESHOW, instructions: "@a @b @song" }, setId: 1, refs: [] }) as any;
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  const p = await probe(done.outputPath!);
  assert.ok(Math.abs(p.durationSec - 6) < 0.2, `${p.durationSec}`);
  assert.equal(p.hasAudio, true);
});

test("a logo goes over every slide", async () => {
  const { store, rs, worker, dir } = setup();
  await rs.addFile(1, png("red"), "a.png", { tag: "a" });
  await rs.addFile(1, png("green"), "logo.png", { tag: "logo" });
  const edit = createEditFor(store, rs, { source: null, settings: { ...SLIDESHOW, instructions: "x" }, setId: 1, refs: [{ tag: "a" }, { tag: "logo", as: "overlay" }] }) as any;
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".base.mp4")));
});

test("a video alone: slides are stills from it, timed to the narration", async () => {
  const { store, worker } = setup();
  const video = landscape60(tmp(), 4);
  const edit = store.createEdit(video, sha256(video), SLIDESHOW);
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.ok(done.cutsPath && existsSync(done.cutsPath));
  const kept = (JSON.parse(readFileSync(done.cutsPath!, "utf8")) as { start: number; end: number }[]).reduce((t, g) => t + g.end - g.start, 0);
  const p = await probe(done.outputPath!);
  assert.ok(Math.abs(p.durationSec - kept) < 0.25, `${p.durationSec} vs ${kept}`);
  assert.equal(p.hasAudio, true);
  assert.deepEqual([p.width, p.height], [1080, 1920]);
});

test("stopping mid-render leaves the edit to be requeued, not failed", async () => {
  const { store, rs, worker } = setup();
  const edit = createEditFor(store, rs, { source: null, settings: { ...SLIDESHOW, instructions: Array.from({ length: 20 }, (_, i) => `Tip number ${i}.`).join(" ") }, setId: 1, refs: [] }) as any;
  const running = worker.tick()!;
  for (let i = 0; i < 400 && !(store.edit(edit.id)!.progress > 0); i++) await new Promise((r) => setTimeout(r, 10));
  worker.stop();
  await running;
  const after = store.edit(edit.id)!;
  assert.notEqual(after.state, "failed", after.error ?? "");
  assert.equal(after.state, "editing");
  store.requeueInterruptedEdits();
  assert.equal(store.edit(edit.id)!.state, "queued");
});

test("the Slideshow style card has its own thumbnail", () => {
  const store = newStore();
  const t = thumbnail(styleById(store, "slideshow")!);
  assert.equal(t.type, "image/svg+xml");
  const svg = String(t.body);
  assert.match(svg, /2\/5/);
  assert.match(svg, /aria-label="Example frame"/);
  assert.match(svg, /3 tips for mornings/);
});
