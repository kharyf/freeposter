import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, test } from "node:test";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { Intake } from "../src/drive/intake.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { account, newStore, sha256, tmp, verticalSilent } from "./helpers.ts";

let clip: string;
before(() => { clip = verticalSilent(tmp(), 4); });

function setup() {
  const store = newStore();
  const x = store.upsertAccount(account("x"));
  const tiktok = store.upsertAccount(account("tiktok"));
  const intake = new Intake(store, publishers, {
    download: async () => { throw new Error("offline"); },
    transcribe: async () => ({ words: [], language: null }),
    writeCaption: async () => ({ title: "t", caption: "c" }),
  });
  const polls: number[] = [];
  const app = buildServer(store, new Runner(store, publishers, tmp()), publishers, {}, { intake, poll: async () => { polls.push(1); } });
  const put = (body: unknown) => app.inject({ method: "PUT", url: "/api/drive", payload: body as object });
  const patch = (id: number, body: unknown) => app.inject({ method: "PATCH", url: `/api/posts/${id}`, payload: body as object });
  return { store, app, x, tiktok, intake, polls, put, patch };
}

test("drive settings round-trip", async () => {
  const { store, app, x, tiktok, polls, put } = setup();
  assert.equal((await put({ folder: "https://drive.google.com/drive/folders/1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry" })).statusCode, 400, "connect first");
  store.saveDriveTokens({ accessToken: "a", refreshToken: "r", expiresAt: null }, "me@example.com");
  const res = await put({
    folder: "https://drive.google.com/drive/folders/1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry?usp=sharing",
    accounts: [x.id, tiktok.id],
    tiktok: { allowComment: false, allowDuet: true, allowStitch: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  const view = (await app.inject("/api/drive")).json();
  assert.equal(view.connected, true);
  assert.equal(view.email, "me@example.com");
  assert.equal(view.folderId, "1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry");
  assert.deepEqual(view.accounts, [x.id, tiktok.id]);
  assert.deepEqual(view.tiktok, { allowComment: false, allowDuet: true, allowStitch: true });
  assert.equal(view.tiktokPrivacy, "SELF_ONLY");
  assert.ok(polls.length >= 1, "a new folder is checked right away");
  assert.equal((await put({ folder: "not a folder" })).statusCode, 400);
  assert.equal((await put({ accounts: [999] })).statusCode, 400);
});

test("tiktok privacy cannot be set for drive", async () => {
  const { store, put } = setup();
  store.saveDriveTokens({ accessToken: "a", refreshToken: "r", expiresAt: null }, "me@example.com");
  const res = await put({ tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE" } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /Only me/);
});

test("drive file list shows state and notes; retry and caption release go to the intake", async () => {
  const { store, app } = setup();
  store.upsertDriveFile("a", { name: "Bad_2.30.26_5.30.pm.mp4", state: "invalid", note: '"2.30.26" is not a real date' });
  store.upsertDriveFile("b", { name: "Old.mp4", state: "ignored" });
  store.upsertDriveFile("c", { name: "Quiet_11.2.26_9.00.am.mp4", state: "needs_caption", sourcePath: clip, sha256: sha256(clip), editId: store.createEdit(clip, sha256(clip), DEFAULT_EDIT).id, note: "no speech" });
  const files = (await app.inject("/api/drive")).json().files;
  assert.deepEqual(files.map((f: any) => f.id).sort(), ["a", "c"], "ignored files aren't listed");
  const res = await app.inject({ method: "PUT", url: "/api/drive/files/c/caption", payload: { title: "Quiet", caption: "Listen. #quiet" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.driveFile("c")!.state, "processing");
  const bad = await app.inject({ method: "POST", url: "/api/drive/files/a/retry-edit" });
  assert.equal(bad.statusCode, 409);
});

function postWith(store: ReturnType<typeof newStore>, accountIds: number[], requireEdit: boolean) {
  const edit = store.createEdit(clip, sha256(clip), requireEdit ? DEFAULT_EDIT : { ...DEFAULT_EDIT, punchIn: false });
  store.updateEdit(edit.id, { state: "ready", outputPath: clip, durationSec: 4 });
  store.approveEdit(edit.id);
  return store.createPost({ caption: "hi", title: "", sourcePath: clip, sha256: sha256(clip), tiktok: null, scheduledAt: Date.now() + 3_600_000, editId: edit.id, requireEdit }, accountIds);
}

test("switch to original only affects unstarted jobs", async () => {
  const { store, x, tiktok, patch } = setup();
  const started = postWith(store, [x.id, tiktok.id], false);
  const [first] = store.jobsForPost(started);
  store.finishJob(first.id, "published", { resultUrl: "https://x.com/i/1" });
  store.db.prepare("UPDATE jobs SET attempts = 1 WHERE id = ?").run(first.id);
  let res = await patch(started, { useOriginal: true });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already started/);

  const fresh = postWith(store, [x.id], false);
  res = await patch(fresh, { useOriginal: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.post(fresh)!.editId, null);
});

test("drive post refuses use original", async () => {
  const { store, x, patch } = setup();
  const id = postWith(store, [x.id], true);
  const res = await patch(id, { useOriginal: true });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /never posted unedited/);
  assert.ok(store.post(id)!.editId);
});

test("editing caption validates against target platforms", async () => {
  const { store, x, patch } = setup();
  const id = postWith(store, [x.id], true);
  let res = await patch(id, { caption: "a".repeat(300), title: "T" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /280/);
  res = await patch(id, { caption: "Better caption #ok", title: "New title" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.post(id)!.caption, "Better caption #ok");
  assert.equal(store.post(id)!.title, "New title");
});

test("posts list says which posts came from Drive", async () => {
  const { store, app, x } = setup();
  const id = postWith(store, [x.id], true);
  store.upsertDriveFile("d", { name: "D_11.2.26_9.00.am.mp4", state: "scheduled", postId: id });
  const posts = (await app.inject("/api/posts")).json();
  assert.equal(posts.find((p: any) => p.id === id).requireEdit, true);
});

test("cancelling a post keeps a source file other posts and edits still use", async () => {
  const { store, app, x } = setup();
  const own = verticalSilent(tmp(), 2);
  const edit = store.createEdit(own, sha256(own), { ...DEFAULT_EDIT, captions: false });
  store.updateEdit(edit.id, { state: "ready", outputPath: own, durationSec: 2 });
  store.approveEdit(edit.id);
  const post = (n: number) => store.createPost({ caption: `p${n}`, title: "", sourcePath: own, sha256: sha256(own), tiktok: null, scheduledAt: Date.now() + 3_600_000, editId: edit.id }, [x.id]);
  const a = post(1);
  post(2);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/posts/${a}` })).statusCode, 200);
  assert.ok(existsSync(own), "the other post and the edit still need it");
});

test("cancelling a Drive post marks its file cancelled", async () => {
  const { store, app, x } = setup();
  const id = postWith(store, [x.id], true);
  store.upsertDriveFile("d", { name: "D_11.2.26_9.00.am.mp4", state: "scheduled", postId: id });
  assert.equal((await app.inject({ method: "DELETE", url: `/api/posts/${id}` })).statusCode, 200);
  const f = store.driveFile("d")!;
  assert.equal(f.state, "cancelled");
  assert.equal(f.postId, null);
});
