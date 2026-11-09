import "./isolated-home.ts"; // first: uploads land in a throwaway data/ folder
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CaptionDeps } from "../src/caption.ts";
import { Captioner } from "../src/captioner.ts";
import { config } from "../src/config.ts";
import type { Transcript } from "../src/edit/transcribe.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
import { captionTopicFor } from "../src/posts.ts";
import { ReviewService } from "../src/review/service.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, multipart, newStore, tmp, verticalSilent } from "./helpers.ts";

const speech: Transcript = { words: [{ text: "Three", start: 0, end: 0.4 }, { text: "tips.", start: 0.5, end: 0.9 }], language: null };

function setup(opts: { transcript?: Transcript; writeCaption?: CaptionDeps["writeCaption"] } = {}) {
  const dir = tmp();
  const clip = verticalSilent(dir);
  const store = newStore();
  const x = store.upsertAccount(account("x"));
  const yt = store.upsertAccount(account("youtube"));
  const published: { caption: string; title: string }[] = [];
  const fake = (p: Platform): Publisher => ({ ...real[p], async publish(ctx) { published.push({ caption: ctx.post.caption, title: ctx.post.title }); return { url: `https://${p}/1` }; } });
  const publishers = { ...real, x: fake("x"), youtube: fake("youtube") } as Record<Platform, Publisher>;
  const runner = new Runner(store, publishers, dir);
  const asked: Parameters<CaptionDeps["writeCaption"]>[0][] = [];
  const writeCaption: CaptionDeps["writeCaption"] = async (input) => (asked.push(input), opts.writeCaption ? opts.writeCaption(input) : { title: "Three tips", caption: "Three tips. #tips" });
  // An agent's post is captioned while its review is prepared, so the user approves the text too.
  const reviews = new ReviewService(store, { publishers, runner, dir: tmp(), transcribe: async () => opts.transcript ?? speech, caption: { writeCaption, frames: async () => [Buffer.from("a frame")] } });
  const app = buildServer(store, runner, publishers, {}, undefined, undefined, undefined, { service: reviews });
  const captioner = new Captioner(store, {
    transcribe: async () => opts.transcript ?? speech,
    writeCaption,
    frames: async () => [Buffer.from("a frame")],
  });
  const upload = (fields: Record<string, string>, name = "My_Morning_Routine.mp4") =>
    app.inject({ method: "POST", url: "/api/posts", ...multipart({ accounts: `[${x.id}]`, ...fields }, { name, data: readFileSync(clip) }) });
  /** runs the runner until nothing more starts */
  const drain = async () => { for (let i = 0; i < 5; i++) await Promise.all(runner.tick()); };
  return { dir, clip, store, x, yt, app, runner, captioner, upload, drain, published, asked, reviews };
}

test("a blank caption on the web page is written by Claude before the post goes out", async () => {
  const { store, captioner, upload, drain, published, asked } = setup();
  const res = await upload({ caption: "", title: "" });
  assert.equal(res.statusCode, 200, res.body);
  const { postId } = res.json();
  assert.equal(store.post(postId)!.captionTopic, "My_Morning_Routine", "the file's name, without its extension");

  await drain();
  assert.deepEqual(published, [], "its jobs wait for the caption");
  const listed = (await setupView(store, postId));
  assert.equal(listed.captionPending, true);

  await captioner.tick();
  assert.equal(asked[0].topic, "My_Morning_Routine");
  assert.equal(asked[0].transcript, "Three tips.");
  const post = store.post(postId)!;
  assert.equal(post.captionTopic, null);
  assert.equal(post.caption, "Three tips. #tips");
  assert.equal(post.title, "Three tips");
  await drain();
  assert.deepEqual(published, [{ caption: "Three tips. #tips", title: "Three tips" }]);
});

/** what the page sees of one post */
async function setupView(store: ReturnType<typeof newStore>, postId: number) {
  const { postView } = await import("../src/posts.ts");
  return postView(store, { post: store.post(postId)!, jobs: store.jobsForPost(postId) });
}

test("the user's title is kept and becomes the topic; a written caption is left alone", async () => {
  const { store, captioner, upload } = setup();
  const titled = (await upload({ caption: "", title: "Sleep better" })).json().postId;
  assert.equal(store.post(titled)!.captionTopic, "Sleep better");
  await captioner.tick();
  assert.equal(store.post(titled)!.title, "Sleep better");
  assert.equal(store.post(titled)!.caption, "Three tips. #tips");

  const written = (await upload({ caption: "My own words", title: "", allowDuplicate: "true" }, "Other.mp4")).json().postId;
  assert.equal(store.post(written)!.captionTopic, null, "a caption the user wrote is never replaced");
});

test("no speech and nothing readable on screen: #fyp, with the file's name as the title", async () => {
  const { store, captioner, upload, drain, published, asked } = setup({ transcript: { words: [], language: null }, writeCaption: async () => null });
  const { postId } = (await upload({ caption: "" })).json();
  await captioner.tick();
  assert.deepEqual(asked[0].frames, [Buffer.from("a frame")], "the frames were looked at");
  assert.equal(store.post(postId)!.caption, "#fyp");
  assert.equal(store.post(postId)!.title, "My_Morning_Routine");
  await drain();
  assert.equal(published[0].caption, "#fyp");
});

test("Claude failing doesn't hold the post: #fyp", async () => {
  const { store, captioner, upload } = setup({ writeCaption: async () => { throw new Error("Claude Code isn't installed"); } });
  const { postId } = (await upload({ caption: "  " })).json();
  await captioner.tick();
  assert.equal(store.post(postId)!.caption, "#fyp");
  assert.equal(store.post(postId)!.captionTopic, null);
});

test("a caption typed under Upcoming while the AI writes wins", async () => {
  const { store, app, captioner, upload } = setup();
  const at = Date.now() + 3_600_000;
  const { postId } = (await upload({ caption: "", scheduledAt: String(at) })).json();
  // Saving with the caption still blank keeps Claude writing it.
  let res = await app.inject({ method: "PATCH", url: `/api/posts/${postId}`, payload: { title: "Mine", caption: "" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(store.post(postId)!.captionTopic);
  res = await app.inject({ method: "PATCH", url: `/api/posts/${postId}`, payload: { title: "Mine", caption: "Typed by me" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(store.post(postId)!.captionTopic, null);
  await captioner.tick();
  assert.equal(store.post(postId)!.caption, "Typed by me");
  assert.equal(store.post(postId)!.title, "Mine");
});

test("YouTube's title rule is checked against the fallback, so a blank caption and title are accepted", async () => {
  const { yt, upload } = setup();
  const res = await upload({ caption: "", title: "", accounts: `[${yt.id}]` });
  assert.equal(res.statusCode, 200, res.body);
});

test("MCP publish_video with no caption gets one written the same way, before the user reviews it", async () => {
  const { store, app, reviews, clip, asked } = setup();
  const x = store.accounts().find((a) => a.platform === "x")!;
  const call = async (args: Record<string, unknown>) => (await app.inject({
    method: "POST", url: "/mcp", headers: { host: `localhost:${config.port}` },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_video", arguments: args } },
  })).json().result;
  const dry = await call({ video_path: clip, account_ids: [x.id], dry_run: true });
  assert.equal(dry.isError, undefined, dry.content[0].text);
  assert.equal(dry.structuredContent.captionWrittenByAi, true);
  const r = await call({ video_path: clip, account_ids: [x.id], schedule_at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(r.structuredContent.caption_pending, true);
  await reviews.tick();
  const review = reviews.reviews.get(r.structuredContent.id)!;
  assert.equal(review.state, "pending", review.error ?? "");
  assert.equal(asked[0].topic, "vertical-silent");
  assert.equal(asked[0].transcript, "Three tips.");
  assert.equal(review.draft.caption, "Three tips. #tips");
  assert.equal(review.draft.title, "Three tips");
  // Approved, the post carries the reviewed text; nothing is left for the captioner to write.
  const out = await reviews.approve(review.id, { via: "window" });
  assert.equal(store.post(out.review!.postId!)!.caption, "Three tips. #tips");
  assert.equal(store.post(out.review!.postId!)!.captionTopic, null);
});

test("captionTopicFor", () => {
  assert.equal(captionTopicFor("hello", "", "a.mp4"), null);
  assert.equal(captionTopicFor("", "", "C:\\videos\\Gatekeeping_11.1.26.mov"), "Gatekeeping_11.1.26");
  assert.equal(captionTopicFor(" ", " My title ", "a.mp4"), "My title");
  assert.equal(captionTopicFor("", "", ""), "Video");
});
