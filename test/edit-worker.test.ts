import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { before, test } from "node:test";
import type { Publisher, PublishContext } from "../src/platforms/base.ts";
import { Runner } from "../src/runner.ts";
import { EditWorker } from "../src/edit/worker.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import type { Platform } from "../src/types.ts";
import { account, makeVideo, newStore, sha256, tmp, verticalSilent } from "./helpers.ts";

let dir: string;
let video: string; // 4 s
let short: string; // 2 s, standing in for an edited cut
before(() => {
  dir = tmp();
  video = verticalSilent(dir, 4);
  short = makeVideo(dir, "short.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
});

const words = [{ text: "hi", start: 0.5, end: 0.9 }, { text: "there", start: 3.0, end: 3.4 }];

test("worker turns a queued edit into a ready one", async () => {
  const store = newStore();
  const worker = new EditWorker(store, { dir: tmp(), findLyrics: async () => [], transcribe: async () => ({ words, language: null }) });
  const edit = store.createEdit(video, sha256(video), DEFAULT_EDIT);
  assert.equal(edit.state, "queued");
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.ok(done.durationSec! > 0 && done.durationSec! < 2, `edited ${done.durationSec}`);
  assert.ok(existsSync(done.outputPath!));
  assert.equal(done.progress, 1);
  assert.equal(done.approvedAt, null, "edits are never approved by the worker");
});

test("a failed edit records the reason", async () => {
  const store = newStore();
  const worker = new EditWorker(store, { dir: tmp(), findLyrics: async () => [], transcribe: async () => { throw new Error("no ffmpeg whisper"); } });
  const edit = store.createEdit(video, sha256(video), DEFAULT_EDIT);
  await worker.tick();
  assert.equal(store.edit(edit.id)!.state, "failed");
  assert.match(store.edit(edit.id)!.error!, /no ffmpeg whisper/);
});

test("same source and settings reuse the edit", () => {
  const store = newStore();
  const a = store.createEdit(video, sha256(video), DEFAULT_EDIT);
  assert.equal(store.createEdit(video, sha256(video), DEFAULT_EDIT).id, a.id);
  assert.notEqual(store.createEdit(video, sha256(video), { ...DEFAULT_EDIT, punchIn: false }).id, a.id);
});

test("crashed edit restarts", () => {
  const store = newStore();
  const edit = store.createEdit(video, sha256(video), DEFAULT_EDIT);
  store.updateEdit(edit.id, { state: "editing", progress: 0.4 });
  new EditWorker(store, { dir: tmp(), findLyrics: async () => [] });
  assert.equal(store.edit(edit.id)!.state, "queued");
});

function setup() {
  const store = newStore();
  const acct = store.upsertAccount(account("x"));
  const published: number[] = [];
  const fake: Publisher = {
    platform: "x", label: "Fake", minDurationSec: 1, maxDurationSec: () => 60, validate: () => null,
    authorizeUrl: () => "", exchangeCode: async () => [], refresh: async () => null,
    async publish(ctx: PublishContext) { published.push(ctx.durationSec); return { url: "https://x.com/i/1" }; },
  };
  const runner = new Runner(store, { x: fake } as Record<Platform, Publisher>, tmp());
  const readyEdit = (approve: boolean) => {
    const edit = store.createEdit(video, sha256(video), DEFAULT_EDIT);
    store.updateEdit(edit.id, { state: "ready", outputPath: short, durationSec: 2, progress: 1 });
    if (approve) store.approveEdit(edit.id);
    return edit.id;
  };
  const post = (editId: number | null, requireEdit = false) =>
    store.createPost({ caption: "hi", title: "", sourcePath: video, sha256: sha256(video), tiktok: null, editId, requireEdit }, [acct.id]);
  return { store, runner, published, readyEdit, post };
}

test("runner publishes the approved edit, not the original", async () => {
  const { runner, published, readyEdit, post } = setup();
  post(readyEdit(true));
  await Promise.all(runner.tick());
  assert.equal(published.length, 1);
  assert.ok(Math.abs(published[0] - 2) < 0.2, `published ${published[0]}s`);
});

test("runner ignores an unapproved edit", async () => {
  const { runner, published, readyEdit, post } = setup();
  post(readyEdit(false));
  await Promise.all(runner.tick());
  assert.ok(Math.abs(published[0] - 4) < 0.2, `published ${published[0]}s`);
});

test("runner never posts the original for a requireEdit post", async () => {
  const { store, runner, published, post } = setup();
  const gone = makeVideo(tmp(), "gone.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const edit = store.createEdit(video, sha256(video), { ...DEFAULT_EDIT, audio: false });
  store.updateEdit(edit.id, { state: "ready", outputPath: gone, durationSec: 2 });
  store.approveEdit(edit.id);
  unlinkSync(gone);
  const postId = post(edit.id, true);
  await Promise.all(runner.tick());
  assert.deepEqual(published, []);
  const [job] = store.jobsForPost(postId);
  assert.equal(job.state, "failed");
  assert.match(job.error!, /posts only its edit/);
});

test("setPostEdit and updatePostText only touch unstarted posts, and requireEdit posts keep their edit", () => {
  const { store, readyEdit, post } = setup();
  const id = post(readyEdit(true));
  assert.equal(store.updatePostText(id, "new caption", "new title"), 1);
  assert.equal(store.post(id)!.caption, "new caption");
  assert.equal(store.setPostEdit(id, null), 1);
  assert.equal(store.post(id)!.editId, null);
  const locked = post(readyEdit(true), true);
  assert.equal(store.setPostEdit(locked, null), 0);
  store.db.prepare("UPDATE jobs SET attempts = 1 WHERE post_id = ?").run(id);
  assert.equal(store.updatePostText(id, "late", "late"), 0);
});

test("a finished edit tells the webhook", async () => {
  const { config } = await import("../src/config.ts");
  const saved = config.produce.webhookUrl;
  config.produce.webhookUrl = "http://localhost:8644/webhooks/freeposter";
  try {
    const store = newStore();
    const worker = new EditWorker(store, { dir: tmp(), findLyrics: async () => [], transcribe: async () => ({ words, language: null }) });
    const edit = store.createEdit(video, sha256(video), DEFAULT_EDIT);
    await worker.tick();
    const [row] = store.outbox();
    assert.equal(row.event, "edit.ready");
    assert.equal(JSON.parse(row.body).edit_id, edit.id);
  } finally {
    config.produce.webhookUrl = saved;
  }
});

// ---- the Fancy look ----

const SCRIPT = [
  "Most people never start.",
  "They wait for the perfect moment.",
  "I posted every single day for ninety days.",
  "My views grew three times faster.",
  "Small steps compound into something huge.",
];
const WORDS_20S = (() => {
  const out: { text: string; start: number; end: number }[] = [];
  let t = 0.3;
  for (const sentence of SCRIPT) {
    for (const text of sentence.split(" ")) {
      out.push({ text, start: +t.toFixed(2), end: +(t + 0.4).toFixed(2) });
      t += 0.55;
    }
    t += 0.4;
  }
  return out;
})();
const wordAt = (text: string) => WORDS_20S.find((w) => w.text.replace(/\W/g, "") === text)!;
const GOOD_PLAN = {
  graphics: [
    { start: wordAt("They").start, end: wordAt("moment").end, template: "gold-3d-word", params: { word: "Gold" } },
    { start: wordAt("My").start, end: wordAt("faster").end, template: "stat-counter", params: { value: 3, suffix: "x", label: "faster growth" } },
    { start: wordAt("Small").start, end: wordAt("huge").end, template: "kinetic-words", params: { words: "Small steps compound" } },
  ],
  emphasis: [wordAt("ninety").start, wordAt("three").start],
  cover: { title: "Post every day", at: wordAt("posted").start },
};

/** Tool stand-ins that write a real 1080x960 clip, counting renders. */
function fancyTools(blenderOk: boolean) {
  const calls = { render: 0, ask: 0 };
  const make = (name: string, ok: boolean) => ({
    kind: name, lane: "cpu", version: 1,
    health: async () => (ok ? { ok: true, detail: "" } : { ok: false, detail: "stub detail" }),
    render: async (shot: any, ctx: any) => {
      calls.render++;
      const path = makeVideo(ctx.dir, "shot.mp4", ["-f", "lavfi", "-i", "testsrc2=size=1080x960:rate=30", "-t", String(shot.duration_sec), "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
      return { path, durationSec: shot.duration_sec };
    },
  });
  const adapters = { remotion: make("remotion", true), hyperframes: make("hyperframes", true), blender: make("blender", blenderOk) } as any;
  const ask = async () => { calls.ask++; return GOOD_PLAN as any; };
  return { calls, fancy: { ask, adapters, faceTrack: async () => null } as any };
}

test("a Fancy edit plans, renders graphics, composites, saves notes and a cover", async () => {
  const long = makeVideo(tmp(), "long.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30", "-t", "20", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const { calls, fancy } = fancyTools(false);
  const store = newStore();
  const edits = tmp();
  const worker = new EditWorker(store, { dir: edits, findLyrics: async () => [], transcribe: async () => ({ words: WORDS_20S, language: null }), fancy });
  const settings = { ...DEFAULT_EDIT, tighten: false, look: "fancy" as const };
  const edit = store.createEdit(long, sha256(long), settings);
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.ok(existsSync(done.outputPath!));
  assert.ok(Math.abs(done.durationSec! - 20) < 0.5, `edited ${done.durationSec}`);
  assert.ok(done.notes.some((n) => /Blender/.test(n)), done.notes.join("; "));
  assert.ok(done.cover && existsSync(done.cover.path) && done.cover.path.endsWith(".cover.jpg"));
  assert.equal(done.cover!.atSec, GOOD_PLAN.cover.at);
  assert.ok(existsSync(done.cutsPath!));
  assert.equal(calls.ask, 1);
  assert.ok(calls.render >= 3);

  // Turning captions off is a new edit that reuses the plan and the graphic clips.
  const before = { ask: calls.ask, render: calls.render };
  const redo = store.createEdit(long, sha256(long), { ...settings, captions: false });
  assert.notEqual(redo.id, edit.id);
  await worker.tick();
  const again = store.edit(redo.id)!;
  assert.equal(again.state, "ready", again.error ?? "");
  assert.equal(calls.ask, before.ask, "the plan was reused");
  assert.equal(calls.render, before.render, "the graphic clips were reused");
});

test("Basic edits still go through renderEdit", async () => {
  const store = newStore();
  const worker = new EditWorker(store, { dir: tmp(), findLyrics: async () => [], transcribe: async () => ({ words, language: null }), fancy: { ask: async () => { throw new Error("not for Basic"); } } });
  const edit = store.createEdit(video, sha256(video), DEFAULT_EDIT);
  await worker.tick();
  const done = store.edit(edit.id)!;
  assert.equal(done.state, "ready", done.error ?? "");
  assert.deepEqual(done.notes, []);
  assert.equal(done.cover, null);
});
