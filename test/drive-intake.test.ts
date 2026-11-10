import "./isolated-home.ts"; // first: downloads land in a throwaway data/ folder
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { before, test } from "node:test";
import { createAccountSet, placeInSet, renameAccountSet, setDefaultSet, type AccountSet } from "../src/accounts.ts";
import { calendar } from "../src/calendar.ts";
import { Intake, type IntakeDeps } from "../src/drive/intake.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import type { DriveFile } from "../src/drive/client.ts";
import { publishers } from "../src/platforms/index.ts";
import type { Transcript } from "../src/edit/transcribe.ts";
import { ReviewService } from "../src/review/service.ts";
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
  const clock = { now: new Date().setSeconds(0, 0) };
  const reviews = new ReviewService(store, { publishers, runner: { tick() {} }, dir: tmp() });
  const deps: IntakeDeps = {
    download: async () => createReadStream(clip),
    transcribe: async () => opts.transcript ?? words,
    writeCaption: opts.caption ?? (async () => ({ title: "Why gatekeeping matters", caption: "Gatekeeping matters. #gatekeeping" })),
    frames: opts.frames ?? (async () => [Buffer.from("a frame")]),
    reviews,
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
  /** The edit went to review; the review is made ready (the exact file) and returned. */
  const reviewOf = async (driveId = "f1") => {
    await intake.tick();
    const f = store.driveFile(driveId)!;
    assert.equal(f.state, "reviewing", f.note ?? "");
    await reviews.tick();
    const r = reviews.reviews.get(f.reviewId!)!;
    assert.equal(r.state, "pending", r.error ?? "");
    assert.equal(r.subjectKind, "edit");
    assert.equal(r.subjectId, f.editId);
    assert.equal(r.requestedVia, "drive");
    return r;
  };
  /** The user taps Approve; the intake records the post the review made. */
  const approve = async (driveId = "f1") => {
    const r = await reviewOf(driveId);
    const out = await reviews.approve(r.id, { via: "window" });
    assert.ok(out.ok, out.message);
    await intake.tick();
    return reviews.reviews.get(r.id)!;
  };
  return { store, accts, clock, deps, intake, reviews, file, finishEdit, posts, reviewOf, approve };
}

test("valid file's edit waits for review; approving schedules the exact file at the filename time with SELF_ONLY TikTok", async () => {
  const { store, clock, intake, file, finishEdit, posts, approve } = setup();
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
  assert.equal(store.driveFile("f1")!.state, "reviewing");
  assert.equal(posts(), 0, "nothing posts before the user approves");
  assert.equal(store.edit(store.driveFile("f1")!.editId!)!.approvedAt, null, "Drive edits aren't approved by themselves any more");
  const r = await approve();
  const done = store.driveFile("f1")!;
  assert.equal(done.state, "scheduled", done.note ?? "");
  assert.equal(done.postId, r.postId);
  const post = store.post(done.postId!)!;
  assert.equal(post.scheduledAt, at);
  assert.equal(post.reviewId, r.id);
  assert.equal(post.approvedSha256, r.masterSha256, "the post uploads exactly the file that was reviewed");
  assert.equal(post.sourcePath, r.masterPath);
  assert.equal(post.caption, "Gatekeeping matters. #gatekeeping");
  assert.equal(post.tiktok!.privacyLevel, "SELF_ONLY");
  assert.equal(post.tiktok!.brandContent, false);
  assert.equal(post.tiktok!.brandOrganic, false);
  assert.ok(store.edit(done.editId!)!.approvedAt, "approving the review approves the edit");
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
  const { store, clock, intake, file, finishEdit, approve } = setup();
  store.setPref("defaults.tiktok", { allowComment: false, allowDuet: true, allowStitch: false, privacyLevel: "PUBLIC_TO_EVERYONE" });
  await intake.handle(file(driveName("T", clock.now + 60 * MIN)));
  finishEdit("f1");
  await approve();
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

test("within grace posts as soon as it's approved", async () => {
  const { store, clock, intake, file, finishEdit, approve } = setup();
  await intake.handle(file(driveName("Soon", clock.now - 10 * MIN)));
  finishEdit("f1");
  const r = await approve();
  assert.equal(r.draft.scheduledAt, null, "its time has come: the review says it posts on approval");
  assert.equal(store.post(store.driveFile("f1")!.postId!)!.scheduledAt, null);
});

test("edit still running at scheduled time waits and never posts original", async () => {
  const { store, clock, intake, file, finishEdit, posts, approve } = setup();
  const at = clock.now + 5 * MIN;
  await intake.handle(file(driveName("Slow", at)));
  clock.now = at + 20 * MIN;
  await intake.tick();
  assert.equal(posts(), 0, "no post while the edit is unfinished, even past its time");
  finishEdit("f1");
  const r = await approve();
  assert.equal(posts(), 1);
  const rec = store.driveFile("f1")!;
  const post = store.post(rec.postId!)!;
  assert.notEqual(post.sourcePath, rec.sourcePath, "the reviewed edit posts, not the original");
  assert.equal(post.approvedSha256, r.masterSha256);
  assert.equal(post.scheduledAt, null, "past its time: it posts once approved");
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
  const { store, clock, intake, file, finishEdit, approve } = setup({
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
  await approve();
  assert.equal(store.driveFile("f1")!.state, "scheduled");
});

test("no speech and frames that don't say what it's about: #fyp, without waiting", async () => {
  const { store, clock, intake, file, finishEdit, approve } = setup({ transcript: { words: [], language: null }, caption: async () => null });
  await intake.handle(file(driveName("Music", clock.now + 60 * MIN)));
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.caption, "#fyp");
  assert.equal(rec.title, "Music", "the title is the file's name");
  assert.match(rec.note!, /frames didn't show/);
  finishEdit("f1");
  await approve();
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
  const { store, clock, intake, file, finishEdit, approve } = setup({ caption: async () => { throw new Error("caption writing failed: X allows 280"); } });
  await intake.handle(file(driveName("Wordy", clock.now + 60 * MIN)));
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.caption, "#fyp");
  assert.match(rec.note!, /280.*#fyp/);
  finishEdit("f1");
  await approve();
  assert.equal(store.driveFile("f1")!.state, "scheduled");
});

test("files an older version held for a caption are captioned on restart", async () => {
  const { store, clock, deps, intake, file, finishEdit, posts, approve } = setup();
  await intake.handle(file(driveName("Held", clock.now + 60 * MIN)));
  store.upsertDriveFile("f1", { state: "needs_caption", caption: null, title: null, note: "no speech to write a caption from; add a title and caption" });
  await new Intake(store, publishers, deps).resume();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.caption, "Gatekeeping matters. #gatekeeping");
  assert.equal(rec.note, null);
  finishEdit("f1");
  await approve();
  assert.equal(posts(), 1);
});

test("restart mid-pipeline sends one review and creates exactly one post", async () => {
  const { store, clock, deps, intake, reviews, file, finishEdit, posts, approve } = setup();
  await intake.handle(file(driveName("Crash", clock.now + 60 * MIN)));
  finishEdit("f1");
  const again = new Intake(store, publishers, deps);
  await Promise.all([again.resume(), intake.tick(), again.tick()]);
  await again.tick();
  await intake.tick();
  await reviews.tick();
  await intake.tick();
  assert.equal(reviews.reviews.inState("preparing", "pending").length, 1, "one card waits for the user");
  await approve();
  assert.equal(posts(), 1);
});

test("restart during download picks the file up again", async () => {
  const { store, clock, intake, file, finishEdit, posts, approve } = setup();
  store.upsertDriveFile("f1", { name: driveName("Mid", clock.now + 60 * MIN), state: "downloading" });
  await intake.resume();
  assert.equal(store.driveFile("f1")!.state, "processing");
  finishEdit("f1");
  await approve();
  assert.equal(posts(), 1);
  assert.ok(file);
});

test("platform too short for edited video is skipped with a note", async () => {
  const { store, accts, clock, intake, file, finishEdit, reviewOf, approve } = setup({ platforms: ["x", "facebook"] });
  await intake.handle(file(driveName("Long", clock.now + 60 * MIN)));
  finishEdit("f1", 120);
  const r = await reviewOf();
  assert.deepEqual(r.draft.accountIds, [accts[0].id], "the review covers only the accounts that can take it");
  await approve();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "scheduled", rec.note ?? "");
  const jobs = store.jobsForPost(rec.postId!);
  assert.deepEqual(jobs.map((j) => j.platform), ["x"]);
  assert.match(rec.note!, /Facebook/);
  assert.ok(accts.length === 2);
});

test("no accounts left fails with the reasons", async () => {
  const { store, clock, intake, file, finishEdit, posts, reviews } = setup({ platforms: ["facebook"] });
  await intake.handle(file(driveName("TooLong", clock.now + 60 * MIN)));
  finishEdit("f1", 120);
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "failed");
  assert.equal(reviews.reviews.recent().length, 0, "nothing to review");
  assert.match(store.driveFile("f1")!.note!, /Facebook/);
  assert.equal(posts(), 0);
});

test("a file for a set with no accounts is refused with the reason", async () => {
  const { store, clock, intake, file, posts } = setup();
  const empty = createAccountSet(store, "Client A") as AccountSet;
  await intake.handle(file(driveName("Early", clock.now + 60 * MIN).replace(".mp4", "_ClientA.mp4")));
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "invalid");
  assert.match(rec.note!, /the account set ClientA has no accounts to post to/);
  setDefaultSet(store, empty.id);
  await intake.handle(file(driveName("Later", clock.now + 60 * MIN), "f2"));
  assert.equal(store.driveFile("f2")!.state, "invalid", "the default set is empty too");
  assert.equal(posts(), 0);
});

test("a set named in the file posts to that set's accounts, even after it's renamed", async () => {
  const { store, accts, clock, intake, file, finishEdit, approve } = setup();
  const client = createAccountSet(store, "Client A") as AccountSet;
  placeInSet(store, client.id, [accts[0].id]); // x moves to Client A; tiktok stays in Personal Brand
  await intake.handle(file(driveName("Named", clock.now + 60 * MIN).replace(".mp4", "_Basic_ClientA.mp4")));
  assert.deepEqual(store.driveFile("f1")!.choice, { name: "Named", styleId: "basic", setId: client.id, raw: false, latest: clock.now + 60 * MIN });
  renameAccountSet(store, client.id, "Someone Else");
  finishEdit("f1");
  const r = await approve();
  assert.deepEqual(r.draft.accountIds, [accts[0].id]);
  assert.deepEqual(store.edit(store.driveFile("f1")!.editId!)!.settings, DEFAULT_EDIT, "Basic is today's edit");
});

test("a file with no set keeps the default set it arrived with, after the default changes", async () => {
  const { store, accts, clock, intake, file, finishEdit, approve } = setup();
  const client = createAccountSet(store, "Client A") as AccountSet;
  placeInSet(store, client.id, [accts[0].id]);
  await intake.handle(file(driveName("Plain", clock.now + 60 * MIN)));
  assert.equal(store.driveFile("f1")!.choice!.setId, 1, "no set in the name: the default set");
  setDefaultSet(store, client.id);
  finishEdit("f1");
  const r = await approve();
  assert.deepEqual(r.draft.accountIds, [accts[1].id], "still Personal Brand's");
});

test("a set emptied while its video waits fails the video with the reason", async () => {
  const { store, accts, clock, intake, file, finishEdit, posts } = setup();
  await intake.handle(file(driveName("Early", clock.now + 60 * MIN)));
  for (const a of accts) store.deleteAccount(a.id);
  finishEdit("f1");
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "failed");
  assert.match(rec.note!, /PersonalBrand has no accounts/);
  assert.equal(posts(), 0);
});

test("a file already on its way before this change keeps the older name rules and today's defaults", async () => {
  const { store, accts, clock, intake, finishEdit, approve } = setup();
  const at = clock.now + 60 * MIN;
  // Underscores in the name were allowed then; it's part-way through, with no saved choice.
  store.upsertDriveFile("f1", { name: driveName("My_Old_Video", at), state: "processing", scheduledAt: at, sourcePath: clip, sha256: "x", caption: "Hi", title: "Hi",
    editId: store.createEdit(clip, "x", DEFAULT_EDIT).id });
  finishEdit("f1");
  const r = await approve();
  assert.deepEqual([...r.draft.accountIds].sort(), accts.map((a) => a.id).sort());
  assert.deepEqual(store.driveFile("f1")!.choice, { name: "My_Old_Video", styleId: "basic", setId: 1, raw: false, latest: at });
});

test("the calendar lists each post at its time with its style and set, and videos still on their way", async () => {
  const { store, clock, intake, file, finishEdit, approve } = setup();
  const at = clock.now + 60 * MIN;
  await intake.handle(file(driveName("First", at)));
  await intake.handle(file(driveName("Second", at + 30 * MIN).replace(".mp4", "_RAW.mp4"), "f2"));
  finishEdit("f1");
  await approve();
  const entries = calendar(store, clock.now - 86_400_000, clock.now + 2 * 86_400_000);
  assert.deepEqual(entries.map((e) => [e.name, e.at, e.style, e.set, e.raw]), [
    ["First", at, "Basic", "PersonalBrand", false],
    ["Second", at + 30 * MIN, null, "PersonalBrand", true],
  ]);
  assert.equal(entries[0].status, "scheduled");
  assert.equal(entries[0].accounts.length, 2);
  assert.ok(entries[0].key.startsWith("post:"));
  assert.ok(entries[1].key.startsWith("post:"), "RAW: a post as soon as it's captioned");
  // One still downloading shows at its time, before it's a post.
  store.upsertDriveFile("f3", { name: "Third.mp4", state: "downloading", scheduledAt: at + 40 * MIN, choice: { name: "Third", styleId: "basic", setId: 1, raw: false, latest: at + 40 * MIN } });
  const third = calendar(store, at + 31 * MIN, at + 86_400_000);
  assert.deepEqual(third.map((e) => [e.key, e.name, e.style, e.set, e.status]), [["drive:f3", "Third", "Basic", "PersonalBrand", "downloading"]]);
});

/** "m.d.yy" for a local day */
const dateKey = (d: Date) => `${d.getMonth() + 1}.${d.getDate()}.${String(d.getFullYear()).slice(2)}`;
const noon = (days = 0) => { const d = new Date(); d.setDate(d.getDate() + days); return d.setHours(12, 0, 0, 0); };
const dayStart = (days = 0) => new Date(noon(days)).setHours(0, 0, 0, 0);

test("a name with no time posts as soon as possible on its date", async () => {
  const { store, clock, intake, file, finishEdit, approve } = setup();
  clock.now = noon();
  await intake.handle(file(`Today_${dateKey(new Date(noon()))}.mp4`));
  assert.equal(store.driveFile("f1")!.scheduledAt, clock.now, "today: right away");
  clock.now += 20 * MIN; // the edit takes a while; still the same day, so not late
  finishEdit("f1");
  await approve();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "scheduled", rec.note ?? "");
  assert.equal(rec.note, null);
  assert.equal(store.post(rec.postId!)!.scheduledAt, null, "it posts as soon as it's approved");

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

// ---- the review: Approve (above), Reject, Redo, and a review that ends undecided ----

test("Reject: nothing posts and the file says so", async () => {
  const { store, clock, intake, reviews, file, finishEdit, posts, reviewOf } = setup();
  await intake.handle(file(driveName("Nope", clock.now + 60 * MIN)));
  finishEdit("f1");
  const r = await reviewOf();
  assert.ok((await reviews.reject(r.id, { via: "window", reason: "cuts", note: "too choppy" })).ok);
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "rejected");
  assert.match(rec.note!, /cuts: too choppy/);
  assert.equal(posts(), 0);
  await intake.tick();
  assert.equal(posts(), 0, "a rejected file stays rejected");
});

test("Redo for one setting with no note: FreePoster makes the new edit, which comes back for review", async () => {
  const { store, clock, intake, reviews, file, finishEdit, posts, reviewOf, approve } = setup();
  await intake.handle(file(driveName("Zoomy", clock.now + 60 * MIN)));
  finishEdit("f1");
  const first = await reviewOf();
  const oldEdit = store.driveFile("f1")!.editId!;
  const out = await reviews.redo(first.id, { via: "window", reason: "zooms", note: null });
  assert.ok(out.ok, out.message);
  assert.match(out.message, /punch-in zooms off/);
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing", "back to editing");
  assert.notEqual(rec.editId, oldEdit);
  assert.equal(store.edit(rec.editId!)!.parentEditId, oldEdit);
  assert.equal(store.edit(rec.editId!)!.settings.punchIn, false);
  assert.equal(store.edit(oldEdit)!.state, "superseded", "the old edit can't be posted");
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "processing", "waits for the new edit");
  finishEdit("f1");
  const second = await approve();
  assert.notEqual(second.id, first.id, "a new review, of the new edit");
  assert.equal(second.subjectId, rec.editId);
  assert.equal(store.driveFile("f1")!.state, "scheduled");
  assert.equal(posts(), 1);
});

test("Redo with a note: waits for Hermes's revise_edit, then sends the new edit for review", async () => {
  const { store, clock, intake, reviews, file, finishEdit, reviewOf } = setup();
  await intake.handle(file(driveName("Cut", clock.now + 60 * MIN)));
  finishEdit("f1");
  const first = await reviewOf();
  const oldEdit = store.edit(store.driveFile("f1")!.editId!)!;
  const out = await reviews.redo(first.id, { via: "telegram", reason: "cuts", note: "keep the joke at 0:02" });
  assert.ok(out.ok, out.message);
  assert.equal(reviews.reviews.get(first.id)!.atSec, 2);
  await intake.tick();
  let rec = store.driveFile("f1")!;
  assert.equal(rec.state, "reviewing");
  assert.equal(rec.editId, oldEdit.id, "FreePoster can't read the note: no new edit yet");
  assert.match(rec.note!, /Waiting for Hermes.*keep the joke/);
  // What revise_edit does.
  const next = store.createEdit(oldEdit.sourcePath, oldEdit.sha256, { ...oldEdit.settings, keep: [{ start: 1.5, end: 2.5 }] }, oldEdit.id);
  store.closeEdit(oldEdit.id, "superseded");
  await intake.tick();
  rec = store.driveFile("f1")!;
  assert.equal(rec.state, "processing");
  assert.equal(rec.editId, next.id);
  finishEdit("f1");
  const second = await reviewOf();
  assert.equal(second.subjectId, next.id);
});

test("an agent's own review of the Drive edit is the one followed, not a second card", async () => {
  const { store, accts, clock, intake, reviews, file, finishEdit, posts } = setup();
  await intake.handle(file(driveName("Both", clock.now + 60 * MIN)));
  finishEdit("f1");
  const editId = store.driveFile("f1")!.editId!;
  const agents = await reviews.request({ subject: { kind: "edit", id: editId }, accountIds: [accts[0].id], caption: "c", title: "t", scheduledAt: null, tiktok: null, allowDuplicate: false, via: "agent" });
  await intake.tick();
  assert.equal(store.driveFile("f1")!.reviewId, agents.id);
  assert.equal(reviews.reviews.recent().length, 1);
  await reviews.tick();
  assert.ok((await reviews.approve(agents.id, { via: "window" })).ok);
  await intake.tick();
  assert.equal(store.driveFile("f1")!.state, "scheduled");
  assert.equal(posts(), 1);
});

test("a review that expires undecided can be sent again", async () => {
  const { store, clock, intake, reviews, file, finishEdit, reviewOf, approve } = setup();
  await intake.handle(file(driveName("Later", clock.now + 60 * MIN)));
  finishEdit("f1");
  const r = await reviewOf();
  assert.ok(r.expiresAt > Date.now() + 70 * 3_600_000, "Drive reviews last 72 hours, not until the post time");
  store.db.prepare("UPDATE reviews SET expires_at = ? WHERE id = ?").run(Date.now() - 1, r.id);
  await reviews.tick();
  await intake.tick();
  const rec = store.driveFile("f1")!;
  assert.equal(rec.state, "unreviewed");
  assert.match(rec.note!, /without a decision/);
  await intake.reviewAgain("f1");
  assert.equal(store.driveFile("f1")!.state, "reviewing");
  assert.notEqual(store.driveFile("f1")!.reviewId, r.id);
  // reviewOf ticks again first, which keeps it reviewing.
  await approve();
  assert.equal(store.driveFile("f1")!.state, "scheduled");
});
