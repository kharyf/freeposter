import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, test } from "node:test";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { Intake } from "../src/drive/intake.ts";
import { publishers } from "../src/platforms/index.ts";
import { ReviewService } from "../src/review/service.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { account, newStore, sha256, tmp, verticalSilent } from "./helpers.ts";

let clip: string;
before(() => { clip = verticalSilent(tmp(), 4); });

function setup() {
  const store = newStore();
  const x = store.upsertAccount(account("x"));
  const tiktok = store.upsertAccount(account("tiktok"));
  const runner = new Runner(store, publishers, tmp());
  const reviews = new ReviewService(store, { publishers, runner, dir: tmp() });
  const intake = new Intake(store, publishers, {
    download: async () => { throw new Error("offline"); },
    transcribe: async () => ({ words: [], language: null }),
    writeCaption: async () => ({ title: "t", caption: "c" }),
    reviews,
  });
  const polls: number[] = [];
  const app = buildServer(store, runner, publishers, {}, { intake, poll: async () => { polls.push(1); }, sync: async () => ({ removed: [], cancelledPosts: 0, busy: [] }) }, undefined, undefined, { service: reviews });
  const put = (body: unknown) => app.inject({ method: "PUT", url: "/api/drive", payload: body as object });
  const patch = (id: number, body: unknown) => app.inject({ method: "PATCH", url: `/api/posts/${id}`, payload: body as object });
  return { store, app, x, tiktok, intake, polls, put, patch };
}

test("drive settings round-trip; Drive no longer picks accounts", async () => {
  const { store, app, polls, put } = setup();
  assert.equal((await put({ folder: "https://drive.google.com/drive/folders/1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry" })).statusCode, 400, "connect first");
  store.saveDriveTokens({ accessToken: "a", refreshToken: "r", expiresAt: null }, "me@example.com");
  const res = await put({ folder: "https://drive.google.com/drive/folders/1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry?usp=sharing" });
  assert.equal(res.statusCode, 200, res.body);
  const view = (await app.inject("/api/drive")).json();
  assert.equal(view.connected, true);
  assert.equal(view.email, "me@example.com");
  assert.equal(view.folderId, "1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry");
  assert.equal(view.accounts, undefined);
  assert.equal(view.tiktok, undefined);
  assert.ok(polls.length >= 1, "a new folder is checked right away");
  assert.equal((await put({ folder: "not a folder" })).statusCode, 400);
});

test("the default set, the default style and their TikTok options are FreePoster settings", async () => {
  const { app, store, x, tiktok } = setup();
  const putDefaults = (body: unknown) => app.inject({ method: "PUT", url: "/api/defaults", payload: body as object });
  const status = async () => (await app.inject("/api/status")).json();
  let s = await status();
  assert.deepEqual(s.accountSets.map((set: any) => [set.id, set.isDefault]), [[1, true]], "the oldest set");
  assert.deepEqual(s.accounts.filter((a: any) => a.isDefault).map((a: any) => a.id).sort(), [x.id, tiktok.id].sort(), "its accounts");
  assert.deepEqual(s.editingStyles.map((st: any) => [st.id, st.name, st.token, st.isDefault]), [["basic", "Basic", "Basic", true]]);
  const other = (await app.inject({ method: "POST", url: "/api/account-sets", payload: { name: "Client A" } })).json();
  assert.equal((await putDefaults({ set: other.id, style: "basic", tiktok: { allowComment: false, allowDuet: true, allowStitch: true } })).statusCode, 200);
  s = await status();
  assert.deepEqual(s.accountSets.map((set: any) => set.isDefault), [false, true]);
  assert.deepEqual(s.accounts.filter((a: any) => a.isDefault), [], "the new default set is empty");
  assert.deepEqual(s.defaultTikTok, { allowComment: false, allowDuet: true, allowStitch: true });
  assert.equal((await putDefaults({ set: 999 })).statusCode, 400);
  assert.equal((await putDefaults({ style: "fancy" })).statusCode, 400);
  assert.equal(store.pref("accounts.defaultSet"), other.id, "a refused change leaves it");
  const privacy = await putDefaults({ tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE" } });
  assert.equal(privacy.statusCode, 400);
  assert.match(privacy.json().error, /Only me/);
  assert.equal((await app.inject("/api/styles/basic/sample.mp4")).statusCode, 404, "no sample yet");
  assert.equal((await app.inject("/api/calendar?from=0&to=10")).json().entries.length, 0);
  assert.equal((await app.inject("/api/calendar?from=0&to=99999999999")).statusCode, 400, "at most 45 days");
});

test("drive file list shows state and notes; retry goes to the intake", async () => {
  const { store, app } = setup();
  store.upsertDriveFile("a", { name: "Bad_2.30.26_5.30.pm.mp4", state: "invalid", note: '"2.30.26" is not a real date' });
  store.upsertDriveFile("b", { name: "Old.mp4", state: "ignored" });
  store.upsertDriveFile("c", { name: "Quiet_11.2.26_9.00.am.mp4", state: "processing", sourcePath: clip, sha256: sha256(clip), editId: store.createEdit(clip, sha256(clip), DEFAULT_EDIT).id, caption: "#fyp", note: "no speech, and its frames didn't show what it's about; captioned #fyp" });
  const files = (await app.inject("/api/drive")).json().files;
  assert.deepEqual(files.map((f: any) => f.id).sort(), ["a", "c"], "ignored files aren't listed");
  assert.match(files.find((f: any) => f.id === "c").note, /#fyp/);
  const gone = await app.inject({ method: "PUT", url: "/api/drive/files/c/caption", payload: { title: "Quiet", caption: "Listen. #quiet" } });
  assert.equal(gone.statusCode, 404, "captions are never waited on, so there's nothing to release");
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
  assert.match(res.json().error, /posts its edit.*_RAW/);
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

test("Sync needs a folder, then reports what it took off", async () => {
  const { store, app } = setup();
  assert.equal((await app.inject({ method: "POST", url: "/api/drive/sync" })).statusCode, 400);
  store.saveDriveTokens({ accessToken: "a", refreshToken: "r", expiresAt: null }, "me@example.com");
  store.setDriveFolder("1gz2qTGVjYyDM9vTB8Ik0DmaBWyMAISry");
  const res = await app.inject({ method: "POST", url: "/api/drive/sync" });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().removed, []);
  assert.ok(Array.isArray(res.json().view.files));
});
