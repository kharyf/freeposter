import "./isolated-home.ts"; // first: keeps uploads out of the real data/ folder
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { publishers } from "../src/platforms/index.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { account, makeVideo, multipart, newStore, sha256, tmp } from "./helpers.ts";

let long: string; // 100 s: too long for Facebook Reels (90 s)
let short: string; // 5 s, standing in for the tightened edit
before(() => {
  const dir = tmp();
  long = makeVideo(dir, "long.mp4", ["-f", "lavfi", "-i", "color=c=gray:size=160x284:rate=5", "-t", "100", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  short = makeVideo(dir, "short.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
});

function setup() {
  const store = newStore();
  const fb = store.upsertAccount(account("facebook"));
  const runner = new Runner(store, publishers, tmp());
  const app = buildServer(store, runner, publishers);
  const edit = store.createEdit(long, sha256(long), DEFAULT_EDIT);
  store.updateEdit(edit.id, { state: "ready", outputPath: short, durationSec: 5, progress: 1 });
  const postWithEdit = () => app.inject({ method: "POST", url: "/api/posts", ...multipart({ caption: "hi", accounts: `[${fb.id}]`, editId: String(edit.id) }) });
  return { store, app, fb, edit, postWithEdit };
}

test("post with unapproved edit is refused", async () => {
  const { postWithEdit } = setup();
  const res = await postWithEdit();
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /approve the edit/);
});

test("approved edit posts with edited duration and reports new eligibility", async () => {
  const { app, store, fb, edit, postWithEdit } = setup();
  const view = (await app.inject(`/api/edits/${edit.id}`)).json();
  assert.equal(view.state, "ready");
  assert.equal(view.approved, false);
  assert.ok(Math.abs(view.sourceDurationSec - 100) < 0.5);
  assert.deepEqual(view.eligible, [{ accountId: fb.id, original: false, edited: true }]);

  assert.equal((await app.inject({ method: "PUT", url: `/api/edits/${edit.id}/approve` })).statusCode, 200);
  const res = await postWithEdit();
  assert.equal(res.statusCode, 200, res.body);
  const post = store.post(res.json().postId)!;
  assert.equal(post.editId, edit.id);
  assert.equal(post.requireEdit, false);
});

test("an edit can't be approved before it is ready", async () => {
  const { app, store } = setup();
  const pending = store.createEdit(short, sha256(short), DEFAULT_EDIT);
  const res = await app.inject({ method: "PUT", url: `/api/edits/${pending.id}/approve` });
  assert.equal(res.statusCode, 409);
});

test("video route serves the edited file with ranges", async () => {
  const { app, edit } = setup();
  const res = await app.inject({ url: `/api/edits/${edit.id}/video`, headers: { range: "bytes=0-99" } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.rawPayload.length, 100);
  assert.match(String(res.headers["content-range"]), /^bytes 0-99\/\d+$/);
  const whole = await app.inject(`/api/edits/${edit.id}/video`);
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.rawPayload.length, readFileSync(short).length);
});

test("uploading a video for editing queues an edit", async () => {
  const { app, store } = setup();
  const res = await app.inject({
    method: "POST", url: "/api/edits",
    ...multipart({ settings: JSON.stringify({ punchIn: false }) }, { name: "clip.mp4", data: readFileSync(short) }),
  });
  assert.equal(res.statusCode, 200, res.body);
  const edit = store.edit(res.json().editId)!;
  assert.equal(edit.state, "queued");
  assert.equal(edit.settings.punchIn, false);
  const bad = await app.inject({ method: "POST", url: "/api/edits", ...multipart({ settings: '{"music":true}' }, { name: "c.mp4", data: readFileSync(short) }) });
  assert.equal(bad.statusCode, 400);
});
