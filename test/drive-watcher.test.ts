import assert from "node:assert/strict";
import { test } from "node:test";
import { DriveWatcher } from "../src/drive/watcher.ts";
import type { DriveFile } from "../src/drive/client.ts";
import { json, mockFetch, newStore } from "./helpers.ts";

const FOLDER = "1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry";

/** A Drive API stand-in whose folder listing the test changes between polls. */
function drive(store = newStore()) {
  store.saveDriveTokens({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 }, "me@example.com");
  store.setDriveFolder(FOLDER);
  const state = { files: [] as Partial<DriveFile>[], tokenStatus: 200, folder: FOLDER };
  const fake = mockFetch((url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return state.tokenStatus === 200 ? json({ access_token: "at-2", expires_in: 3600 }) : json({ error: "invalid_grant" }, state.tokenStatus);
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      const q = new URL(url).searchParams.get("q")!;
      assert.match(q, new RegExp(`'${state.folder}' in parents`));
      assert.match(q, /trashed=false/);
      assert.match(q, /mimeType contains 'video\/'/);
      return json({ files: state.files.map((f) => ({ mimeType: "video/mp4", createdTime: "2026-11-01T10:00:00Z", ...f, size: String(f.size ?? 0) })) });
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

test("file not picked up until size stable", async (t) => {
  const { state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll(); // baseline: empty folder
  state.files = [{ id: "new", name: "New_11.2.26_9.00.am.mp4", size: 100 }];
  await watcher.poll();
  state.files = [{ id: "new", name: "New_11.2.26_9.00.am.mp4", size: 200, md5Checksum: "m" }];
  await watcher.poll();
  assert.equal(handed.length, 0, "size still changing");
  await watcher.poll();
  assert.equal(handed.length, 1);
  assert.equal(handed[0].id, "new");
  assert.equal(handed[0].size, 200);
});

test("each drive file handed over once", async (t) => {
  const { state, fake, handed, watcher } = drive();
  t.after(fake.restore);
  await watcher.poll();
  state.files = [{ id: "f", name: "F_11.2.26_9.00.am.mp4", size: 5, md5Checksum: "m" }];
  for (let i = 0; i < 5; i++) await watcher.poll();
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
  await watcher.poll();
  assert.deepEqual(handed, []);
});
