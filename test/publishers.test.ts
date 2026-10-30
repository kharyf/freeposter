import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PublishContext } from "../src/platforms/base.ts";
import { facebook } from "../src/platforms/facebook.ts";
import { instagram } from "../src/platforms/instagram.ts";
import { tiktokPublisher } from "../src/platforms/tiktok.ts";
import { x } from "../src/platforms/x.ts";
import { youtube } from "../src/platforms/youtube.ts";
import type { Account, Platform, Post } from "../src/types.ts";
import { account, json, mockFetch, tmp } from "./helpers.ts";

const MB = 1024 * 1024;
const dir = tmp();
const SIZE = 9 * MB + 321;
const videoPath = join(dir, "video.mp4");
writeFileSync(videoPath, randomBytes(SIZE));

function ctx(platform: Platform, progress: Record<string, any> = {}, post: Partial<Post> = {}, acct: Partial<Account> = {}) {
  const saves: Record<string, any>[] = [];
  const c: PublishContext = {
    account: { id: 1, ...account(platform), ...acct },
    post: { id: 1, caption: "Launch day 🚀 #shorts", title: "", sourcePath: videoPath, sha256: "x", tiktok: null, createdAt: 0, ...post },
    videoPath,
    videoSize: SIZE,
    durationSec: 12,
    progress,
    save: (p) => {
      if (p !== c.progress) c.progress = p;
      saves.push(structuredClone(p));
    },
    log: () => {},
  };
  return { c, saves };
}

const route = (routes: [RegExp | string, (url: string, init: RequestInit) => Response][]) => (url: string, init: RequestInit) => {
  const key = `${init.method ?? "GET"} ${url}`;
  for (const [pattern, respond] of routes) {
    if (typeof pattern === "string" ? key.startsWith(pattern) : pattern.test(key)) return respond(url, init);
  }
  throw new Error(`unexpected request ${key}`);
};

// ---------------- X ----------------

test("X: initialize → append segments → finalize → status → post", async () => {
  const m = mockFetch(route([
    ["POST https://api.x.com/2/media/upload/initialize", () => json({ data: { id: "m1" } })],
    [/^POST https:\/\/api\.x\.com\/2\/media\/upload\/m1\/append/, () => new Response(null, { status: 204 })],
    ["POST https://api.x.com/2/media/upload/m1/finalize", () => json({ data: { id: "m1", processing_info: { state: "pending" } } })],
    ["GET https://api.x.com/2/media/upload?command=STATUS&media_id=m1", () => json({ data: { processing_info: { state: "succeeded" } } })],
    ["POST https://api.x.com/2/tweets", () => json({ data: { id: "t9" } })],
  ]));
  try {
    const { c } = ctx("x");
    const r = await x.publish(c);
    assert.equal(r.url, "https://x.com/xuser/status/t9");
    const appends = m.calls.filter((k) => k.url.includes("/append"));
    assert.equal(appends.length, Math.ceil(SIZE / (4 * MB)));
    assert.equal((appends[2].body as FormData).get("segment_index"), "2");
    const tweet = JSON.parse(m.calls.at(-1)!.body as string);
    assert.deepEqual(tweet, { text: "Launch day 🚀 #shorts", media: { media_ids: ["m1"] } });
    assert.equal(m.calls[0].headers.authorization, "Bearer access-1");
  } finally {
    m.restore();
  }
});

test("X: after a crash mid-post it finds the existing post instead of posting twice", async () => {
  const m = mockFetch(route([
    ["GET https://api.x.com/2/users/x-1/tweets", () => json({ data: [{ id: "t7", text: "Launch day 🚀 #shorts https://t.co/abc" }] })],
  ]));
  try {
    const { c } = ctx("x", { mediaId: "m1", nextSegment: 3, finalized: true, processed: true, tweetRequested: true });
    const r = await x.publish(c);
    assert.equal(r.url, "https://x.com/xuser/status/t7");
    assert.equal(m.calls.filter((k) => k.url.endsWith("/2/tweets")).length, 0);
  } finally {
    m.restore();
  }
});

// ---------------- YouTube ----------------

test("YouTube: resumable session, chunked PUTs, waits for processing, returns Shorts URL", async () => {
  const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc";
  const m = mockFetch(route([
    ["POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable", () => new Response(null, { status: 200, headers: { location: session } })],
    [`PUT ${session}`, (_u, init) => {
      const range = (init.headers as any)["content-range"] as string;
      const end = Number(range.match(/-(\d+)\//)![1]);
      return end === SIZE - 1 ? json({ id: "vid1" }) : new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
    }],
    ["GET https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=vid1", () =>
      json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "public" } }] })],
  ]));
  try {
    const { c } = ctx("youtube", {}, { title: "", caption: "My title line\nmore text" });
    const r = await youtube.publish(c);
    assert.equal(r.url, "https://www.youtube.com/shorts/vid1");
    assert.equal(r.note, undefined);
    const meta = JSON.parse(m.calls[0].body as string);
    assert.equal(meta.snippet.title, "My title line");
    assert.equal(meta.status.privacyStatus, "public");
    const puts = m.calls.filter((k) => k.method === "PUT");
    assert.equal(puts.length, 2);
    assert.equal(puts[1].headers["content-range"], `bytes ${8 * MB}-${SIZE - 1}/${SIZE}`);
  } finally {
    m.restore();
  }
});

test("YouTube: resumes an interrupted upload from the byte the server reports", async () => {
  const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc";
  const m = mockFetch(route([
    [`PUT ${session}`, (_u, init) => {
      const range = (init.headers as any)["content-range"] as string;
      if (range === `bytes */${SIZE}`) return new Response(null, { status: 308, headers: { range: "bytes=0-4999999" } });
      return json({ id: "vid2" });
    }],
    [/GET .*videos\?part=status/, () => json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "private" } }] })],
  ]));
  try {
    const { c } = ctx("youtube", { uploadUrl: session });
    const r = await youtube.publish(c);
    const data = m.calls.filter((k) => k.method === "PUT")[1];
    assert.equal(data.headers["content-range"], `bytes 5000000-${SIZE - 1}/${SIZE}`);
    assert.match(r.note!, /private/); // surfaces the unaudited-project lock instead of hiding it
  } finally {
    m.restore();
  }
});

// ---------------- TikTok ----------------

const creator = {
  creator_avatar_url: "", creator_username: "maker", creator_nickname: "Maker",
  privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600,
};
const tiktokOpts = { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: true, brandContent: false, brandOrganic: false };

test("TikTok: creator check → init → chunked upload → publish status → post URL", async () => {
  const m = mockFetch(route([
    ["POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => json({ data: creator, error: { code: "ok" } })],
    ["POST https://open.tiktokapis.com/v2/post/publish/video/init/", () => json({ data: { publish_id: "p1", upload_url: "https://upload.tiktok.test/u1" }, error: { code: "ok" } })],
    ["PUT https://upload.tiktok.test/u1", () => new Response(null, { status: 206 })],
    ["POST https://open.tiktokapis.com/v2/post/publish/status/fetch/", () =>
      json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7123] }, error: { code: "ok" } })],
  ]));
  try {
    const { c } = ctx("tiktok", {}, { tiktok: tiktokOpts });
    const r = await tiktokPublisher.publish(c);
    assert.equal(r.url, "https://www.tiktok.com/@tiktokuser/video/7123");
    const init = JSON.parse(m.calls[1].body as string);
    assert.equal(init.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
    assert.equal(init.post_info.disable_duet, true, "creator-level duet setting wins");
    assert.equal(init.post_info.disable_stitch, true);
    assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: SIZE, chunk_size: 9 * MB + 321, total_chunk_count: 1 });
    const put = m.calls.find((k) => k.method === "PUT")!;
    assert.equal(put.headers["content-range"], `bytes 0-${SIZE - 1}/${SIZE}`);
  } finally {
    m.restore();
  }
});

test("TikTok: refuses a privacy level the account does not offer, before uploading", async () => {
  const m = mockFetch(route([
    ["POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => json({ data: creator, error: { code: "ok" } })],
  ]));
  try {
    const { c } = ctx("tiktok", {}, { tiktok: { ...tiktokOpts, privacyLevel: "FOLLOWER_OF_CREATOR" } });
    await assert.rejects(tiktokPublisher.publish(c), /not allowed/);
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

// ---------------- Instagram ----------------

test("Instagram: resumable container → byte upload → FINISHED → publish → permalink", async () => {
  const m = mockFetch(route([
    ["POST https://graph.facebook.com/v24.0/instagram-1/media_publish", () => json({ id: "ig-media-1" })],
    ["POST https://graph.facebook.com/v24.0/instagram-1/media", () => json({ id: "c1", uri: "https://rupload.facebook.com/ig-api-upload/v24.0/c1" })],
    ["POST https://rupload.facebook.com/ig-api-upload/v24.0/c1", () => json({ success: true })],
    ["GET https://graph.facebook.com/v24.0/c1?", () => json({ status_code: "FINISHED" })],
    ["GET https://graph.facebook.com/v24.0/ig-media-1?fields=permalink", () => json({ permalink: "https://www.instagram.com/reel/ABC/" })],
  ]));
  try {
    const { c } = ctx("instagram");
    const r = await instagram.publish(c);
    assert.equal(r.url, "https://www.instagram.com/reel/ABC/");
    const create = new URLSearchParams(m.calls[0].body as string);
    assert.equal(create.get("media_type"), "REELS");
    assert.equal(create.get("upload_type"), "resumable");
    const upload = m.calls[1];
    assert.equal(upload.headers.authorization, "OAuth access-1");
    assert.equal(upload.headers.file_size, String(SIZE));
    assert.equal(upload.headers.offset, "0");
    assert.equal((upload.body as Blob).size, SIZE);
  } finally {
    m.restore();
  }
});

test("Instagram: a retry after a lost publish response finds the post instead of publishing twice", async () => {
  const m = mockFetch(route([
    ["GET https://graph.facebook.com/v24.0/c1?", () => json({ status_code: "PUBLISHED", video_status: { processing_phase: { status: "complete" } } })],
    ["GET https://graph.facebook.com/v24.0/instagram-1/media?", () =>
      json({ data: [{ id: "ig-media-2", caption: "Launch day 🚀 #shorts", timestamp: new Date().toISOString().replace("Z", "+0000") }] })],
    ["GET https://graph.facebook.com/v24.0/ig-media-2?fields=permalink", () => json({ permalink: "https://www.instagram.com/reel/DEF/" })],
  ]));
  try {
    const { c } = ctx("instagram", { containerId: "c1", uploaded: true, publishRequested: true, publishRequestedAt: Date.now() - 1000 });
    const r = await instagram.publish(c);
    assert.equal(r.url, "https://www.instagram.com/reel/DEF/");
    assert.equal(m.calls.filter((k) => k.url.includes("media_publish")).length, 0);
  } finally {
    m.restore();
  }
});

test("Instagram: resumes a partial upload at the byte offset Instagram reports", async () => {
  const m = mockFetch(route([
    ["GET https://graph.facebook.com/v24.0/c1?", (() => {
      let n = 0;
      return () => json(n++ === 0
        ? { status_code: "IN_PROGRESS", video_status: { uploading_phase: { status: "in_progress", bytes_transferred: 4096 } } }
        : { status_code: "FINISHED" });
    })()],
    ["POST https://rupload.facebook.com/ig-api-upload/v24.0/c1", () => json({ success: true })],
    ["POST https://graph.facebook.com/v24.0/instagram-1/media_publish", () => json({ id: "ig-media-3" })],
    ["GET https://graph.facebook.com/v24.0/ig-media-3", () => json({ permalink: "https://www.instagram.com/reel/GHI/" })],
  ]));
  try {
    const { c } = ctx("instagram", { containerId: "c1", uploadUri: "https://rupload.facebook.com/ig-api-upload/v24.0/c1", uploadStarted: true });
    await instagram.publish(c);
    const upload = m.calls.find((k) => k.url.startsWith("https://rupload"))!;
    assert.equal(upload.headers.offset, "4096");
    assert.equal((upload.body as Blob).size, SIZE - 4096);
  } finally {
    m.restore();
  }
});

// ---------------- Facebook ----------------

test("Facebook: start → upload → finish(PUBLISHED) → publishing complete → reel URL", async () => {
  const m = mockFetch(route([
    [/^POST https:\/\/graph\.facebook\.com\/v24\.0\/facebook-1\/video_reels/, (_u, init) => {
      const phase = new URLSearchParams(init.body as string).get("upload_phase");
      return phase === "start" ? json({ video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v24.0/v1" }) : json({ success: true });
    }],
    ["POST https://rupload.facebook.com/video-upload/v24.0/v1", () => json({ success: true })],
    ["GET https://graph.facebook.com/v24.0/v1?", () =>
      json({ status: { video_status: "ready", publishing_phase: { status: "complete" } }, permalink_url: "/reel/555" })],
  ]));
  try {
    const { c } = ctx("facebook");
    const r = await facebook.publish(c);
    assert.equal(r.url, "https://www.facebook.com/reel/555");
    const finish = new URLSearchParams(m.calls[2].body as string);
    assert.equal(finish.get("upload_phase"), "finish");
    assert.equal(finish.get("video_state"), "PUBLISHED");
    assert.equal(finish.get("description"), "Launch day 🚀 #shorts");
  } finally {
    m.restore();
  }
});

test("Facebook: does not send 'finish' again if publishing already started", async () => {
  const m = mockFetch(route([
    ["GET https://graph.facebook.com/v24.0/v1?", () =>
      json({ status: { publishing_phase: { status: "complete" } }, permalink_url: "https://www.facebook.com/reel/556" })],
  ]));
  try {
    const { c } = ctx("facebook", { videoId: "v1", uploaded: true, finishRequested: true });
    const r = await facebook.publish(c);
    assert.equal(r.url, "https://www.facebook.com/reel/556");
    assert.equal(m.calls.filter((k) => k.method === "POST").length, 0);
  } finally {
    m.restore();
  }
});

// ---------------- pre-upload validation ----------------

test("captions are checked against each platform before anything uploads", () => {
  const long = "a".repeat(281);
  const post = { id: 1, caption: long, title: "", sourcePath: "", sha256: "", tiktok: null, createdAt: 0 };
  const a = { id: 1, ...account("x") };
  assert.match(x.validate(post, a)!, /280/);
  assert.equal(instagram.validate(post, a), null);
  assert.match(tiktokPublisher.validate(post, a)!, /privacy/);
  assert.match(
    tiktokPublisher.validate({ ...post, tiktok: { ...tiktokOpts, privacyLevel: "SELF_ONLY", brandContent: true } }, a)!,
    /branded/,
  );
  assert.match(instagram.validate({ ...post, caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") }, a)!, /30 hashtags/);
});
