import assert from "node:assert/strict";
import { test } from "node:test";
import { DriveWatcher } from "../src/drive/watcher.ts";
import type { DriveFile } from "../src/drive/client.ts";
import { account, json, mockFetch, newStore } from "./helpers.ts";

const FOLDER = "1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry";

/** A Drive API stand-in whose folder listing the test changes between polls. */
function drive(store = newStore()) {
  store.saveDriveTokens({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 }, "me@example.com");
  store.setDriveFolder(FOLDER);
  // `changes` is what the change feed reports on its next read (then it's empty again); `feed` 410s an old token.
  const state = { files: [] as Partial<DriveFile>[], changes: [] as any[], feedStatus: 200, tokenStatus: 200, folder: FOLDER, tokens: 0 };
  const asDrive = (f: Partial<DriveFile>) => ({ mimeType: "video/mp4", createdTime: "2026-11-01T10:00:00Z", ...f, size: String(f.size ?? 0) });
  const fake = mockFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return state.tokenStatus === 200 ? json({ access_token: "at-2", expires_in: 3600 }) : json({ error: "invalid_grant" }, state.tokenStatus);
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      const q = new URL(url).searchParams.get("q")!;
      assert.match(q, new RegExp(`'${state.folder}' in parents`));
      assert.match(q, /trashed=false/);
      assert.match(q, /mimeType contains 'video\/'/);
      return json({ files: state.files.map(asDrive) });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/changes/startPageToken")) return json({ startPageToken: `t${++state.tokens}` });
    if (url.startsWith("https://www.googleapis.com/drive/v3/changes?")) {
      if (state.feedStatus !== 200) return json({ error: { message: "Invalid page token" } }, state.feedStatus);
      const changes = state.changes.map((c) => ({ ...c, file: c.file && { parents: [state.folder], ...asDrive(c.file) } }));
      state.changes = [];
      return json({ changes, newStartPageToken: `t${++state.tokens}` });
    }
    return new Response("not found", { status: 404 });
  });
  const handed: DriveFile[] = [];
  const watcher = new DriveWatcher(store, (f) => { handed.push(f); });
  return { store, state, fake, handed, watcher };
}

test("existing files at connect are ignored", async (t) => {
  const { store, state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  state.files = [{ id: "old", name: "Old_11.1.26_5.30.pm.mp4", size: 10, md5Checksum: "a" }];
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(handed, []);
  assert.equal(store.driveFile("old")!.state, "ignored");
  assert.match(store.driveFile("old")!.note!, /already in the folder/);
});

test("file not picked up until its upload finishes", async (t) => {
  const { state, fake, handed, watcher, store } = drive();
  t.after(fake.restore);
  await watcher.poll(); // baseline: empty folder
  state.changes = [{ file: { id: "new", name: "New_11.2.26_9.00.am.mp4", size: 100 } }];
  state.files = [{ id: "new", name: "New_11.2.26_9.00.am.mp4", size: 100 }];
  await watcher.poll();
  assert.equal(handed.length, 0, "no checksum yet: still uploading");
  assert.equal(store.driveFile("new")!.state, "pending");
  state.files = [{ id: "new", name: "New_11.2.26_9.00.am.mp4", size: 200, md5Checksum: "m" }];
  await watcher.poll(); // the folder is listed while an upload is finishing, even if the feed is quiet
  assert.equal(handed.length, 1);
  assert.equal(handed[0].id, "new");
  assert.equal(handed[0].size, 200);
  assert.equal(store.driveFile("new")!.uploadedAt, Date.parse("2026-11-01T10:00:00Z"), "Drive's upload time is kept");
});

test("a finished upload is found from the change feed on the next poll, without listing the folder", async (t) => {
  const { state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll(); // baseline
  const before = fake.calls.filter((c) => c.url.includes("/drive/v3/files?")).length;
  state.changes = [{ file: { id: "up", name: "Gatekeepers.mov", mimeType: "video/quicktime", size: 5, md5Checksum: "m" } }];
  await watcher.poll();
  assert.deepEqual(handed.map((f) => f.id), ["up"]);
  assert.equal(handed[0].mimeType, "video/quicktime");
  assert.equal(fake.calls.filter((c) => c.url.includes("/drive/v3/files?")).length, before, "only the change feed was read");
  const feed = fake.calls.filter((c) => c.url.includes("/drive/v3/changes?")).map((c) => new URL(c.url).searchParams.get("pageToken"));
  await watcher.poll();
  const next = fake.calls.filter((c) => c.url.includes("/drive/v3/changes?")).map((c) => new URL(c.url).searchParams.get("pageToken"));
  assert.notEqual(next.at(-1), feed.at(-1), "each poll reads on from where the last one stopped");
});

test("changes elsewhere in Drive are ignored", async (t) => {
  const { state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll();
  state.changes = [
    { file: { id: "other", name: "o.mp4", size: 5, md5Checksum: "m", parents: ["someOtherFolder"] } },
    { file: { id: "doc", name: "notes", mimeType: "application/vnd.google-apps.document", size: 0 } },
    { file: { id: "bin", name: "b.mp4", size: 5, md5Checksum: "m", trashed: true } },
    { removed: true, fileId: "gone" },
  ];
  await watcher.poll();
  assert.deepEqual(handed, []);
});

test("a change token Drive no longer accepts falls back to listing the folder", async (t) => {
  const { state, fake, handed, watcher, store } = drive();
  t.after(fake.restore);
  await watcher.poll();
  state.feedStatus = 410;
  state.files = [{ id: "f", name: "F.mp4", size: 5, md5Checksum: "m" }];
  await watcher.poll();
  assert.deepEqual(handed.map((f) => f.id), ["f"]);
  assert.equal(store.driveConnection()!.error, null, "not reported to the user");
  assert.ok(store.driveConnection()!.changesToken, "a fresh token to read on from");
});

test("each drive file handed over once", async (t) => {
  const { state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll();
  state.files = [{ id: "f", name: "F_11.2.26_9.00.am.mp4", size: 5, md5Checksum: "m" }];
  for (let i = 0; i < 5; i++) {
    state.changes = [{ file: state.files[0] }];
    await watcher.poll();
  }
  assert.equal(handed.length, 1);
});

test("expired access token is refreshed and saved", async (t) => {
  const { store, fake, watcher } = drive();
  t.after(fake.restore);
  store.saveDriveTokens({ accessToken: "at-old", refreshToken: "rt-1", expiresAt: Date.now() - 1000 });
  await watcher.poll();
  assert.equal(store.driveConnection()!.accessToken, "at-2");
  const listCall = fake.calls.find((c) => c.url.includes("/drive/v3/files?"))!;
  assert.equal(listCall.headers.authorization, "Bearer at-2");
});

test("revoked token stops polling and reports", async (t) => {
  const { store, state, fake, watcher } = drive();
  t.after(fake.restore);
  store.saveDriveTokens({ accessToken: "at-old", refreshToken: "rt-1", expiresAt: Date.now() - 1000 });
  state.tokenStatus = 400;
  await watcher.poll();
  assert.match(store.driveConnection()!.error!, /reconnect/);
  const calls = fake.calls.length;
  await watcher.poll();
  assert.equal(fake.calls.length, calls, "no more calls until the user reconnects");
});

test("changing the folder starts a new baseline", async (t) => {
  const { store, state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll();
  store.setDriveFolder("another");
  state.folder = "another";
  state.files = [{ id: "there", name: "T_11.2.26_9.00.am.mp4", size: 5, md5Checksum: "m" }];
  await watcher.poll();
  state.changes = [{ file: state.files[0] }];
  await watcher.poll();
  assert.deepEqual(handed, []);
});

test("a folder FreePoster can't open is reported, and fixing the link clears it", async (t) => {
  const store = newStore();
  store.saveDriveTokens({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 }, "me@example.com");
  store.setDriveFolder("missingFolder123");
  const fake = mockFetch((url) =>
    url.includes("/changes/startPageToken") ? json({ startPageToken: "t1" }) : json({ error: { code: 404, message: "File not found: ." } }, 404));
  t.after(fake.restore);
  await new DriveWatcher(store, () => {}).poll();
  assert.match(store.driveConnection()!.error!, /folder/i);
  store.setDriveFolder("1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry");
  assert.equal(store.driveConnection()!.error, null);
});

test("sync takes deleted videos off the list, cancels their unsent posts, and leaves the rest", async (t) => {
  const { store, state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll(); // baseline: empty folder
  const acct = store.upsertAccount(account("x"));
  store.upsertDriveFile("kept", { name: "Kept", state: "needs_caption", size: 1, md5: "a" });
  store.upsertDriveFile("gone", { name: "Gone", state: "needs_caption", size: 1, md5: "b" });
  store.upsertDriveFile("busy", { name: "Busy", state: "transcribing", size: 1, md5: "c" });
  store.upsertDriveFile("sched", { name: "Sched", state: "queued", size: 1, md5: "d" });
  const postId = store.createDrivePost("sched", {
    sourcePath: "", sha256: "s", caption: "c", title: "t",
    tiktok: { privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false },
  }, [acct.id], null)!;
  state.files = [{ id: "kept", name: "Kept", size: 1, md5Checksum: "a" }];

  const out = await watcher.sync();
  assert.deepEqual(out!.removed.sort(), ["Gone", "Sched"]);
  assert.equal(out!.cancelledPosts, 1);
  assert.deepEqual(out!.busy, ["Busy"]);
  assert.equal(store.post(postId), undefined, "the unsent post is cancelled");
  assert.deepEqual(store.driveFiles().map((f) => f.name).sort(), ["Busy", "Kept"]);
  assert.equal(store.driveFile("gone")!.state, "removed", "still remembered, so it's never taken in again");

  // Restored from the trash: already known, so it isn't posted again.
  state.files.push({ id: "gone", name: "Gone", size: 1, md5Checksum: "b" });
  state.changes = [{ file: { id: "gone", name: "Gone", size: 1, md5Checksum: "b" } }];
  await watcher.poll();
  assert.deepEqual(handed, []);
});

test("sync leaves posts that already went out", async (t) => {
  const { store, state, fake, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll();
  const acct = store.upsertAccount(account("x"));
  store.upsertDriveFile("done", { name: "Done", state: "queued", size: 1, md5: "a" });
  const postId = store.createDrivePost("done", {
    sourcePath: "", sha256: "s", caption: "c", title: "t",
    tiktok: { privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false },
  }, [acct.id], null)!;
  for (const j of store.jobsForPost(postId)) store.finishJob(j.id, "published", { resultUrl: "https://x.com/p/1" });
  state.files = [];
  const out = await watcher.sync();
  assert.deepEqual(out!.removed, ["Done"]);
  assert.equal(out!.cancelledPosts, 0);
  assert.ok(store.post(postId), "a published post is kept in the history");
  assert.equal(store.driveFiles().length, 0);
});
