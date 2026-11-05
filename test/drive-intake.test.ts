import "./isolated-home.ts"; // first: downloads land in a throwaway data/ folder
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { before, test } from "node:test";
import { Intake, type IntakeDeps } from "../src/drive/intake.ts";
import type { DriveFile } from "../src/drive/client.ts";
import { publishers } from "../src/platforms/index.ts";
import type { Transcript } from "../src/edit/transcribe.ts";
import { account, newStore, tmp, verticalSilent } from "./helpers.ts";

const MIN = 60_000;
let clip: string;
before(() => { clip = verticalSilent(tmp(), 4); });

/** "Name_m.d.yy_h.mm.am" for a local time. */
function driveName(name: string, at: number) {
  const d = new Date(at);
  const h = d.getHours() % 12 || 12;
  return `${name}_${d.getMonth() + 1}.${d.getDate()}.${String(d.getFullYear()).slice(2)}_${h}.${String(d.getMinutes()).padStart(2, "0")}.${d.getHours() < 12 ? "am" : "pm"}.mp4`;
}

const words: Transcript = { words: [{ text: "Gatekeeping", start: 0.2, end: 0.9 }, { text: "matters.", start: 1.0, end: 1.6 }], language: null };

type Caption = (input: Parameters<IntakeDeps["writeCaption"]>[0]) => Promise<{ title: string; caption: string } | null>;

function setup(opts: { transcript?: Transcript; caption?: Caption; frames?: IntakeDeps["frames"]; platforms?: ("x" | "tiktok" | "facebook")[] } = {}) {
  const store = newStore();
  const accts = (opts.platforms ?? ["x", "tiktok"]).map((p) => store.upsertAccount(account(p)));
  store.setPref("defaults.accounts", accts.map((a) => a.id));
  const clock = { now: new Date().setSeconds(0, 0) };
  const deps: IntakeDeps = {
    download: async () => createReadStream(clip),
    transcribe: async () => opts.transcript ?? words,
    writeCaption: opts.caption ?? (async () => ({ title: "Why gatekeeping matters", caption: "Gatekeeping matters. #gatekeeping" })),
    frames: opts.frames ?? (async () => [Buffer.from("a frame")]),
    now: () => clock.now,
  };
  const intake = new Intake(store, publishers, deps);
  const file = (name: string, id = "f1", uploadedAt = clock.now): DriveFile => ({ id, name, mimeType: "video/mp4", size: 1, md5Checksum: "m", createdTime: new Date(uploadedAt).toISOString() });
  /** The worker finished the edit (stand-in for EditWorker). */
  const finishEdit = (driveId: string, durationSec = 3) => {
    const editId = store.driveFile(driveId)!.editId!;
    store.updateEdit(editId, { state: "ready", outputPath: clip, durationSec, progress: 1 });
  };
  const posts = () => (store.db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
  return { store, accts, clock, deps, intake, file, finishEdit, posts };
}

test("valid file becomes a scheduled post at the filename time with SELF_ONLY TikTok", async () => {
  const { store, clock, intake, file, finishEdit, posts } = setup();
  const at = clock.now + 2 * 60 * MIN;
  await intake.handle(file(driveName("Gatekeeping", at)));
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing", rec.note ?? "");
  assert.equal(rec.scheduledAt, at);
  assert.equal(rec.title, "Why gatekeeping matters");
  await intake.tick();
  assert.equal(posts(), 0, "the edit isn't ready yet");

  finishEdit("f1");
  await intake.tick();
  const done = store.driveFile("f1")!;
  assert.equal(done.state, "scheduled", done.note ?? "");
  const post = store.post(done.postId!)!;
  assert.equal(post.scheduledAt, at);
  assert.equal(post.editId, done.editId);
  assert.equal(post.requireEdit, true);
  assert.equal(post.caption, "Gatekeeping matters. #gatekeeping");
  assert.equal(post.tiktok!.privacyLevel, "SELF_ONLY");
  assert.equal(post.tiktok!.brandContent, false);
  assert.equal(post.tiktok!.brandOrganic, false);
  assert.ok(store.edit(done.editId!)!.approvedAt, "Drive edits are approved automatically");
  assert.equal(store.jobsForPost(post.id).length, 2);
  assert.equal(store.jobsForPost(post.id)[0].nextRunAt, at);
});

test("a _RAW file skips the edit and posts the video as uploaded", async () => {
  const { store, clock, intake, file, posts } = setup();
  const at = clock.now + 2 * 60 * MIN;
  await intake.handle(file(driveName("Gatekeeping", at).replace(".mp4", "_RAW.mp4")));
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing", rec.note ?? "");
  assert.equal(rec.editId, null, "no edit is made");
  assert.equal(rec.title, "Why gatekeeping matters", "the caption is still written from the transcript");
  await intake.tick();
  assert.equal(posts(), 1);
  const done = store.driveFile("f1")!;
  assert.equal(done.state, "scheduled", done.note ?? "");
  assert.equal(done.note, null);
  const post = store.post(done.postId!)!;
  assert.equal(post.scheduledAt, at);
  assert.equal(post.editId, null);
  assert.equal(post.requireEdit, false);
  assert.equal(post.sourcePath, done.sourcePath);
  assert.equal(store.jobsForPost(post.id).length, 2);
});

test("a _RAW file is checked against each platform's limits at its own length", async () => {
  const { store, clock, intake, file } = setup({ platforms: ["x", "facebook"] });
  await intake.handle(file(driveName("Short", clock.now + 60 * MIN).replace(".mp4", "_raw.mp4")));
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "scheduled", rec.note ?? "");
  assert.deepEqual(store.jobsForPost(rec.postId!).map((j) => j.platform).sort(), ["facebook", "x"], "the 4 s clip fits both");
});

test("a _RAW file with no speech is captioned from its frames and posts as uploaded", async () => {
  const seen: Parameters<Caption>[0][] = [];
  const { store, intake, file } = setup({
    transcript: { words: [], language: null },
    caption: async (input) => (seen.push(input), { title: "Sleep tips", caption: "Sleep better. #sleep" }),
  });
  await intake.handle(file("Music_RAW.mp4"));
  assert.equal(seen[0].transcript, "");
  assert.equal(seen[0].frames!.length, 1);
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "scheduled", rec.note ?? "");
  const post = store.post(rec.postId!)!;
  assert.equal(post.editId, null);
  assert.equal(post.caption, "Sleep better. #sleep");
});

test("a _RAW file whose transcription fails is still captioned and posted", async () => {
  const { store, deps, file } = setup();
  deps.transcribe = async () => { throw new Error("transcription failed: no model"); };
  const intake = new Intake(store, publishers, deps);
  await intake.handle(file("Clip_RAW.mp4"));
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "scheduled", rec.note ?? "");
  assert.equal(rec.caption, "Gatekeeping matters. #gatekeeping");
});

test("TikTok interaction settings come from the Drive settings, privacy never does", async () => {
  const { store, clock, intake, file, finishEdit } = setup();
  store.setPref("defaults.tiktok", { allowComment: false, allowDuet: true, allowStitch: false, privacyLevel: "PUBLIC_TO_EVERYONE" });
  await intake.handle(file(driveName("T", clock.now + 60 * MIN)));
  finishEdit("f1");
  await intake.tick();
  const post = store.post(store.driveFile("f1")!.postId!)!;
  assert.deepEqual(post.tiktok, { privacyLevel: "SELF_ONLY", disableComment: true, disableDuet: false, disableStitch: true, brandContent: false, brandOrganic: false });
});

test("invalid name and late file are not posted", async () => {
  const { store, clock, intake, file, posts } = setup();
  await intake.handle(file("Gatekeeping_2.30.26_5.30.pm.mp4", "bad"));
  assert.equal(store.driveFile("bad")!.state, "invalid");
  assert.match(store.driveFile("bad")!.note!, /not a real date/);
  await intake.handle(file(driveName("Old", clock.now - 2 * 60 * MIN), "late"));
  assert.equal(store.driveFile("late")!.state, "late");
  await intake.handle(file(driveName("Far", clock.now + 400 * 24 * 60 * MIN), "far"));
  assert.equal(store.driveFile("far")!.state, "invalid");
  assert.match(store.driveFile("far")!.note!, /year/);
  await intake.tick();
  assert.equal(posts(), 0);
});

test("within grace posts now", async () => {
  const { store, clock, intake, file, finishEdit } = setup();
  await intake.handle(file(driveName("Soon", clock.now - 10 * MIN)));
  finishEdit("f1");
  await intake.tick();
  const post = store.post(store.driveFile("f1")!.postId!)!;
  assert.ok(Math.abs(post.scheduledAt! - clock.now) < 1000, `${post.scheduledAt} vs ${clock.now}`);
});

test("edit still running at scheduled time waits and never posts original", async () => {
  const { store, clock, intake, file, finishEdit, posts } = setup();
  const at = clock.now + 5 * MIN;
  await intake.handle(file(driveName("Slow", at)));
  clock.now = at + 20 * MIN;
  await intake.tick();
  assert.equal(posts(), 0, "no post while the edit is unfinished, even past its time");
  finishEdit("f1");
  await intake.tick();
  await intake.tick();
  assert.equal(posts(), 1);
  const rec = store.driveFile("f1")!;
  const post = store.post(rec.postId!)!;
  assert.ok(post.editId && post.requireEdit);
  assert.ok(Math.abs(post.scheduledAt! - clock.now) < 1000);
  assert.match(rec.note!, /late/);
});

test("failed edit holds edit_failed and retry resumes", async () => {
  const { store, clock, intake, file, posts } = setup();
  await intake.handle(file(driveName("Broken", clock.now + 60 * MIN)));
  store.updateEdit(store.driveFile("f1")!.editId!, { state: "failed", error: "ffmpeg exploded" });
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "edit_failed");
  assert.match(store.driveFile("f1")!.note!, /ffmpeg exploded/);
  assert.equal(posts(), 0);
  const failedEdit = store.driveFile("f1")!.editId;
  await intake.retryEdit("f1");
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.notEqual(rec.editId, failedEdit);
  assert.equal(store.edit(rec.editId!)!.state, "queued");
});

test("transcription failure holds edit_failed", async () => {
  const { store, clock, deps, file } = setup();
  deps.transcribe = async () => { throw new Error("transcription failed: no model"); };
  const intake = new Intake(store, publishers, deps);
  await intake.handle(file(driveName("Mute", clock.now + 60 * MIN)));
  assert.equal(store.driveFile("f1")!.state, "edit_failed");
  assert.match(store.driveFile("f1")!.note!, /no model/);
});

test("no speech: the caption is written from the video's frames", async () => {
  const seen: Parameters<Caption>[0][] = [];
  const { store, clock, intake, file, finishEdit } = setup({
    transcript: { words: [], language: null },
    caption: async (input) => (seen.push(input), { title: "5 tips for better sleep", caption: "Sleep better tonight. #sleep" }),
  });
  await intake.handle(file(driveName("Music", clock.now + 60 * MIN)));
  assert.deepEqual(seen[0].frames, [Buffer.from("a frame")]);
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.caption, "Sleep better tonight. #sleep");
  assert.ok(rec.editId, "the edit still runs");
  finishEdit("f1");
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "scheduled");
});

test("no speech and frames that don't say what it's about: #fyp, without waiting", async () => {
  const { store, clock, intake, file, finishEdit } = setup({ transcript: { words: [], language: null }, caption: async () => null });
  await intake.handle(file(driveName("Music", clock.now + 60 * MIN)));
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.caption, "#fyp");
  assert.equal(rec.title, "Music", "the title is the file's name");
  assert.match(rec.note!, /frames didn't show/);
  finishEdit("f1");
  await intake.tick();
  const done = store.driveFile("f1")!;
  assert.equal(done.state, "scheduled", done.note ?? "");
  assert.equal(store.post(done.postId!)!.caption, "#fyp");
});

test("no speech and no readable frames: #fyp", async () => {
  const { store, clock, intake, file } = setup({ transcript: { words: [], language: null }, caption: async () => null, frames: async () => { throw new Error("ffmpeg"); } });
  await intake.handle(file(driveName("Music", clock.now + 60 * MIN)));
  assert.equal(store.driveFile("f1")!.caption, "#fyp");
  assert.match(store.driveFile("f1")!.note!, /no frames/);
});

test("caption failure falls back to #fyp instead of waiting", async () => {
  const { store, clock, intake, file, finishEdit } = setup({ caption: async () => { throw new Error("caption writing failed: X allows 280"); } });
  await intake.handle(file(driveName("Wordy", clock.now + 60 * MIN)));
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.caption, "#fyp");
  assert.match(rec.note!, /280.*#fyp/);
  finishEdit("f1");
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "scheduled");
});

test("files an older version held for a caption are captioned on restart", async () => {
  const { store, clock, deps, file, finishEdit, posts } = setup();
  const intake = new Intake(store, publishers, deps);
  await intake.handle(file(driveName("Held", clock.now + 60 * MIN)));
  store.upsertDriveFile("f1", { state: "needs_caption", caption: null, title: null, note: "no speech to write a caption from; add a title and caption" });
  await new Intake(store, publishers, deps).resume();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.caption, "Gatekeeping matters. #gatekeeping");
  assert.equal(rec.note, null);
  finishEdit("f1");
  await intake.tick();
  assert.equal(posts(), 1);
});

test("restart mid-pipeline creates exactly one post", async () => {
  const { store, clock, deps, intake, file, finishEdit, posts } = setup();
  await intake.handle(file(driveName("Crash", clock.now + 60 * MIN)));
  finishEdit("f1");
  const again = new Intake(store, publishers, deps);
  await Promise.all([again.resume(), intake.tick(), again.tick()]);
  await again.tick();
  await intake.tick();
  assert.equal(posts(), 1);
});

test("restart during download picks the file up again", async () => {
  const { store, clock, deps, file, finishEdit, posts } = setup();
  store.upsertDriveFile("f1", { name: driveName("Mid", clock.now + 60 * MIN), state: "downloading" });
  const intake = new Intake(store, publishers, deps);
  await intake.resume();
  assert.equal(store.driveFile("f1")!.state, "processing");
  finishEdit("f1");
  await intake.tick();
  assert.equal(posts(), 1);
  assert.ok(file);
});

test("platform too short for edited video is skipped with a note", async () => {
  const { store, accts, clock, intake, file, finishEdit } = setup({ platforms: ["x", "facebook"] });
  await intake.handle(file(driveName("Long", clock.now + 60 * MIN)));
  finishEdit("f1", 120);
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "scheduled", rec.note ?? "");
  const jobs = store.jobsForPost(rec.postId!);
  assert.deepEqual(jobs.map((j) => j.platform), ["x"]);
  assert.match(rec.note!, /Facebook/);
  assert.ok(accts.length === 2);
});

test("no accounts left fails with the reasons", async () => {
  const { store, clock, intake, file, finishEdit, posts } = setup({ platforms: ["facebook"] });
  await intake.handle(file(driveName("TooLong", clock.now + 60 * MIN)));
  finishEdit("f1", 120);
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "failed");
  assert.match(store.driveFile("f1")!.note!, /Facebook/);
  assert.equal(posts(), 0);
});

test("a file waits for Drive accounts to be chosen instead of failing", async () => {
  const { store, accts, clock, intake, file, finishEdit, posts } = setup();
  store.setPref("defaults.accounts", []);
  await intake.handle(file(driveName("Early", clock.now + 60 * MIN)));
  finishEdit("f1");
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "processing");
  assert.match(store.driveFile("f1")!.note!, /Choose default accounts/);
  store.setPref("defaults.accounts", accts.map((a) => a.id));
  await intake.tick();
  assert.equal(posts(), 1);
});

/** "m.d.yy" for a local day */
const dateKey = (d: Date) => `${d.getMonth() + 1}.${d.getDate()}.${String(d.getFullYear()).slice(2)}`;
const noon = (days = 0) => { const d = new Date(); d.setDate(d.getDate() + days); return d.setHours(12, 0, 0, 0); };
const dayStart = (days = 0) => new Date(noon(days)).setHours(0, 0, 0, 0);

test("a name with no time posts as soon as possible on its date", async () => {
  const { store, clock, intake, file, finishEdit } = setup();
  clock.now = noon();
  await intake.handle(file(`Today_${dateKey(new Date(noon()))}.mp4`));
  assert.equal(store.driveFile("f1")!.scheduledAt, clock.now, "today: right away");
  clock.now += 20 * MIN; // the edit takes a while; still the same day, so not late
  finishEdit("f1");
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "scheduled", rec.note ?? "");
  assert.equal(rec.note, null);
  assert.equal(store.post(rec.postId!)!.scheduledAt, clock.now);

  await intake.handle(file(`Later_${dateKey(new Date(noon(2)))}.mp4`, "f2"));
  assert.equal(store.driveFile("f2")!.scheduledAt, dayStart(2), "a later date: as soon as that day starts");
});

test("a name with no date uses the day it was uploaded", async () => {
  const { store, clock, intake, file } = setup();
  clock.now = noon();
  await intake.handle(file("Evening_3.00.pm.mp4"));
  assert.equal(store.driveFile("f1")!.scheduledAt, dayStart() + 15 * 60 * MIN);
  await intake.handle(file("Anytime.mp4", "f2"));
  assert.equal(store.driveFile("f2")!.scheduledAt, clock.now, "no date or time: right away");
});

test("a date with no time is late once that day is over", async () => {
  const { store, clock, intake, file, posts } = setup();
  clock.now = noon();
  await intake.handle(file(`Yesterday_${dateKey(new Date(noon(-1)))}.mp4`));
  assert.equal(store.driveFile("f1")!.state, "late");
  assert.match(store.driveFile("f1")!.note!, /already passed/);
  // No date: the upload day counts, not the day FreePoster first saw it.
  await intake.handle(file("Undated.mp4", "f2", noon(-1)));
  assert.equal(store.driveFile("f2")!.state, "late");
  await intake.tick();
  assert.equal(posts(), 0);
});
