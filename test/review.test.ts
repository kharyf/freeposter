// The review gate (docs/telegram-review-design.md §9.1): only a confirmed tap by the paired user on the current
// card's Approve, or the window's button, makes a post, and the post uploads exactly the file that was approved.
// Telegram is a fake that behaves like the real one where it matters: it confirms a callback query once
// (answerCallbackQuery) and refuses ids it never issued.
import "./isolated-home.ts";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { config } from "../src/config.ts";
import type { Publisher } from "../src/platforms/base.ts";
import { publishers as real } from "../src/platforms/index.ts";
import { parseTime, ReviewService } from "../src/review/service.ts";
import { hermesPluginStatus, installHermesPlugin, pluginEnabled } from "../src/integrations/hermes.ts";
import { keyboard, TelegramReview } from "../src/review/telegram.ts";
import { Runner } from "../src/runner.ts";
import { CampaignStore } from "../src/campaigns/store.ts";
import { CampaignWorker } from "../src/campaigns/worker.ts";
import { ProductionStore } from "../src/produce/store.ts";
import { buildServer } from "../src/server.ts";
import type { Platform } from "../src/types.ts";
import { account, json, newStore, tmp, verticalSilent } from "./helpers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "telegram", name), "utf8"));
const TOKEN = `7700000001:AAH${"x".repeat(32)}`;
const ME = 111;
let video: string;
before(() => { video = verticalSilent(tmp(), 2); });

function fakeTelegram() {
  let nextMessage = 100;
  const issued = new Set<string>();
  const calls: { method: string; params: any }[] = [];
  const updates: any[] = [];
  let failPhoto = false;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = String(url).split("/").pop()!;
    const params = init.body instanceof FormData
      ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"]))
      : JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, params });
    const ok = (result: unknown) => json({ ok: true, result });
    switch (method) {
      case "getMe": return ok({ id: 7700000001, is_bot: true, username: "LoxisMeetBot" });
      case "sendPhoto": if (failPhoto) return json({ ok: false, error_code: 400, description: "Bad Request: wrong file" }, 400); return ok({ message_id: nextMessage++, chat: { id: Number(params.chat_id) } });
      case "sendVideo": case "sendDocument": case "sendMessage": return ok({ message_id: nextMessage++, chat: { id: Number(params.chat_id) } });
      case "editMessageReplyMarkup": case "editMessageCaption": return ok(true);
      case "answerCallbackQuery":
        if (!issued.delete(String(params.callback_query_id))) return json({ ok: false, error_code: 400, description: "Bad Request: query is too old and response timeout expired or query ID is invalid" }, 400);
        return ok(true);
      case "getUpdates": return ok(updates.splice(0));
      default: return json({ ok: false, description: `unknown method ${method}` }, 404);
    }
  }) as typeof fetch;
  const all = (method: string) => calls.filter((c) => c.method === method);
  return { fetchImpl, failPhotos: (v: boolean) => { failPhoto = v; }, calls, issued, updates, all, last: (method: string) => all(method).at(-1) };
}

async function setup(mode: "own" | "shared" = "own") {
  const dir = tmp();
  const store = newStore(dir);
  const x = store.upsertAccount(account("x"));
  const uploaded: string[] = [];
  const publishers = { ...real, x: { ...real.x, publish: async (ctx: any) => { uploaded.push(ctx.videoPath); return { url: "https://x.com/u/status/1" }; } } } as Record<Platform, Publisher>;
  const runner = new Runner(store, publishers, join(dir, "renders"));
  mkdirSync(join(dir, "renders"), { recursive: true });
  const reviews = new ReviewService(store, { publishers, runner, dir: join(dir, "reviews") });
  const tg = fakeTelegram();
  const telegram = new TelegramReview(store, reviews, { fetch: tg.fetchImpl });
  await telegram.connect(TOKEN, mode);
  let updateId = 1000;

  const message = (text: string, f: { from?: number; chat?: number; type?: string; replyTo?: number } = {}) => {
    const u = fixture("message.json");
    u.update_id = ++updateId;
    u.message.message_id = updateId;
    u.message.from.id = f.from ?? ME;
    u.message.chat = { id: f.chat ?? ME, type: f.type ?? "private" };
    u.message.text = text;
    if (f.replyTo) u.message.reply_to_message = { message_id: f.replyTo, from: { id: 7700000001, is_bot: true }, chat: u.message.chat, date: 0, text: "🔁 FreePoster redo" };
    return u;
  };
  /** A tap as Telegram delivers it; `confirmed: false` is a query id Telegram never issued (a forgery). */
  const tapUpdate = (data: string, f: { from?: number; chat?: number; messageId?: number; confirmed?: boolean } = {}) => {
    const u = fixture("callback_query.json");
    u.update_id = ++updateId;
    u.callback_query.id = randomBytes(8).toString("hex");
    if (f.confirmed !== false) tg.issued.add(u.callback_query.id);
    u.callback_query.from.id = f.from ?? ME;
    u.callback_query.message.chat.id = f.chat ?? ME;
    u.callback_query.message.message_id = f.messageId ?? 0;
    u.callback_query.data = data;
    return u;
  };

  // Pair the chat with the code the setup screen shows.
  const code = telegram.status().pairCode!;
  await telegram.handleUpdate(message(mode === "shared" ? `/freeposter ${code}` : `/start ${code}`));
  assert.equal(telegram.status().paired, "@khary");

  /** An edit an agent asked to post, prepared and sent: its card's message id and buttons. */
  const sendReview = async (caption = "ship it", scheduledAt: number | null = null, fancy: { notes: string[]; cover: { path: string; atSec: number } | null } = { notes: [], cover: null }) => {
    const edit = store.createEdit(video, randomBytes(32).toString("hex"), { tighten: true, captions: true, reframe: true, audio: true, punchIn: true });
    store.updateEdit(edit.id, { state: "ready", outputPath: video, durationSec: 2, progress: 1, ...fancy });
    const review = await reviews.request({ subject: { kind: "edit", id: edit.id }, accountIds: [x.id], caption, title: "", scheduledAt, tiktok: null, allowDuplicate: true, via: "agent" });
    await reviews.tick();
    assert.equal(reviews.reviews.get(review.id)!.state, "pending", reviews.reviews.get(review.id)!.error ?? "");
    await telegram.syncCards();
    const card = tg.last("sendVideo")!;
    // A portrait frame size, so Telegram doesn't squash the video into a landscape box.
    assert.ok(Number(card.params.height) > Number(card.params.width), `sendVideo size ${card.params.width}x${card.params.height}`);
    const buttons = JSON.parse(card.params.reply_markup).inline_keyboard;
    const r = reviews.reviews.get(review.id)!;
    return { edit, review: r, cardId: r.cardMessageId!, approve: buttons[0][0].callback_data as string, reject: buttons[1][0].callback_data as string, redo: buttons[1][1].callback_data as string };
  };
  const tap = async (data: string, f: Parameters<typeof tapUpdate>[1] = {}) => {
    const u = tapUpdate(data, f);
    await telegram.handleUpdate(u);
    return u;
  };
  const posts = () => store.recentPosts().length;
  /** Approving starts the post at once (runner.tick); waits until its jobs are done. */
  const settle = async (postId: number) => {
    for (let i = 0; i < 200; i++) {
      if (store.jobsForPost(postId).every((j) => j.state === "published" || j.state === "failed")) return;
      runner.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`post ${postId} didn't finish`);
  };
  const toasts = () => tg.all("answerCallbackQuery").map((c) => c.params.text);
  return { store, x, runner, reviews, telegram, tg, sendReview, tap, tapUpdate, message, posts, toasts, uploaded, settle };
}

test("pairing takes the code from a private chat only", async () => {
  const dir = tmp();
  const store = newStore(dir);
  const reviews = new ReviewService(store, { publishers: real, runner: { tick() {} }, dir });
  const tg = fakeTelegram();
  const telegram = new TelegramReview(store, reviews, { fetch: tg.fetchImpl });
  await assert.rejects(telegram.connect("not-a-token"), /BotFather/);
  const status = await telegram.connect(TOKEN);
  assert.equal(status.bot, "LoxisMeetBot");
  const code = status.pairCode!;
  assert.match(code, /^\d{6}$/);
  const msg = (text: string, chat: { id: number; type: string }, update_id: number) => ({ ...fixture("message.json"), update_id, message: { ...fixture("message.json").message, message_id: update_id, from: { id: ME, is_bot: false, first_name: "K" }, chat, text } });
  await telegram.handleUpdate(msg("/start 000000", { id: ME, type: "private" }, 1));
  await telegram.handleUpdate(msg(code, { id: -5, type: "group" }, 2));
  assert.equal(telegram.status().paired, null);
  await telegram.handleUpdate(msg(code, { id: ME, type: "private" }, 3));
  assert.equal(telegram.status().paired, "K");
  assert.equal(store.secretPref("telegram.token"), TOKEN, "kept encrypted at rest");
  assert.ok(!JSON.stringify(store.db.prepare("SELECT value FROM prefs WHERE key = 'telegram.token'").get()).includes("AAH"), "never in plain text");
});

test("the card carries the post's details, the exact file, and buttons whose nonce is only stored hashed", async () => {
  const { tg, sendReview, reviews } = await setup();
  const { review, approve } = await sendReview("hello #fyp");
  const card = tg.last("sendVideo")!;
  assert.match(card.params.caption, /Edit \d+/);
  assert.match(card.params.caption, /hello #fyp/);
  assert.match(card.params.caption, new RegExp(review.masterSha256!.slice(0, 16)));
  assert.equal(card.params.video, "<file>");
  const doc = tg.last("sendDocument")!;
  assert.match(doc.params.caption, new RegExp(review.masterSha256!));
  assert.match(approve, /^fp:a:\d+:[A-Za-z0-9_-]{16}$/);
  assert.ok(Buffer.byteLength(approve) <= 64);
  const nonce = approve.split(":")[3];
  assert.ok(!JSON.stringify(reviews.reviews.get(review.id)).includes(nonce));
});

const NOTE = "Blender isn't available (not installed): 1 graphic made with HyperFrames instead";
const coverFile = () => { const p = join(tmp(), "cover.jpg"); writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return p; };

test("the Telegram card lists the edit's notes, and a basic edit's card has none", async () => {
  const { tg, sendReview, telegram } = await setup();
  const { review } = await sendReview("hi", null, { notes: [NOTE, "no AI connected: keyword graphics only"], cover: null });
  const caption = tg.last("sendVideo")!.params.caption as string;
  assert.ok(caption.includes(`Note: ${NOTE}`), caption);
  assert.ok(caption.includes("Note: no AI connected: keyword graphics only"), caption);
  assert.equal(telegram.cardText(review).text, caption);
  assert.ok(caption.length <= 1024);
  await sendReview("hi");
  assert.ok(!tg.last("sendVideo")!.params.caption.includes("Note:"), "basic card unchanged");
  assert.equal(tg.all("sendPhoto").length, 0);
});

test("long notes shrink the caption, never push the card past Telegram's limit", async () => {
  const { tg, sendReview } = await setup();
  await sendReview("c".repeat(270), null, { notes: ["n".repeat(200), "m".repeat(200), "k".repeat(200)], cover: null });
  const caption = tg.last("sendVideo")!.params.caption as string;
  assert.ok(caption.length <= 1024, String(caption.length));
  assert.equal(caption.match(/^Note:/gm)?.length, 3);
  assert.ok(!caption.includes("n".repeat(161)), "each note is capped");
});

test("more notes than fit: a +N more line, and the card text stays within the Telegram limit even when room would go negative", async () => {
  const { telegram, sendReview } = await setup();
  const notes = Array.from({ length: 6 }, (_, i) => String(i).repeat(400));
  const { review } = await sendReview("c".repeat(250), null, { notes, cover: null });
  const { text } = telegram.cardText(review);
  assert.ok(text.length <= 1024, String(text.length));
  assert.match(text, /Note: \+3 more/);
  assert.equal(text.match(/^Note: 0/gm)?.length, 1);
  // With a long title the notes go first, so the room for the caption never goes negative.
  const titled = { ...review, draft: { ...review.draft, title: "T".repeat(700) } };
  const trimmed = telegram.cardText(titled).text;
  assert.ok(trimmed.length <= 1024 && trimmed.includes("Caption:\n"), String(trimmed.length));
  assert.ok((trimmed.match(/^Note:/gm)?.length ?? 0) < 4, "notes were trimmed");
  // A huge title leaves no room even without notes: the hard limit still holds.
  const big = { ...review, draft: { ...review.draft, title: "T".repeat(2000) } };
  assert.ok(telegram.cardText(big).text.length <= 1024);
});

test("Telegram gets the cover as a photo reply to the card; a failed photo doesn't fail the card", async () => {
  const { tg, sendReview, reviews } = await setup();
  const { review, cardId } = await sendReview("hi", null, { notes: [], cover: { path: coverFile(), atSec: 1 } });
  const photo = tg.last("sendPhoto")!;
  assert.equal(photo.params.photo, "<file>");
  assert.equal(photo.params.caption, "Cover");
  assert.equal(Number(photo.params.reply_to_message_id), cardId);
  assert.ok(reviews.reviews.get(review.id)!.cardMessageId);

  tg.failPhotos(true);
  const failed = await sendReview("again", null, { notes: [], cover: { path: coverFile(), atSec: 1 } });
  assert.ok(failed.cardId, "the card was sent");
  assert.equal(reviews.reviews.get(failed.review.id)!.sendAttempts, 0, "no retry of the card");
  assert.equal(tg.all("sendVideo").length, 2);
});

test("the window review shows the notes and the cover, and serves only that cover", async () => {
  const { store, reviews, sendReview } = await setup();
  const { review } = await sendReview("hi", null, { notes: [NOTE], cover: { path: coverFile(), atSec: 1 } });
  const plain = await sendReview("plain");
  const runner = new Runner(store, real, tmp());
  const app = buildServer(store, runner, real, {}, undefined, undefined, undefined, { service: reviews });
  const HOST = { host: `localhost:${config.port}` };
  const list = (await app.inject({ method: "GET", url: "/api/reviews", headers: HOST })).json();
  const mine = list.pending.find((r: any) => r.id === review.id);
  assert.equal(mine.coverUrl, `/api/reviews/${review.id}/cover`);
  assert.deepEqual(mine.notes, [NOTE]);
  const basic = list.pending.find((r: any) => r.id === plain.review.id);
  assert.equal(basic.coverUrl, null);
  assert.deepEqual(basic.notes, []);
  const img = await app.inject({ method: "GET", url: mine.coverUrl, headers: HOST });
  assert.equal(img.statusCode, 200);
  assert.match(String(img.headers["content-type"]), /^image\/jpeg/);
  assert.deepEqual([...img.rawPayload], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal((await app.inject({ method: "GET", url: `/api/reviews/${plain.review.id}/cover`, headers: HOST })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/reviews/9999/cover", headers: HOST })).statusCode, 404);
  // The cover file goes away: 404, not an error.
  store.updateEdit(review.subjectId!, { cover: { path: join(tmp(), "gone.jpg"), atSec: 1 } });
  assert.equal((await app.inject({ method: "GET", url: mine.coverUrl, headers: HOST })).statusCode, 404);
  await app.close();
});

test("Approve posts exactly the approved file, once, however often the tap arrives", async () => {
  const { sendReview, tap, telegram, posts, toasts, reviews, store, settle, uploaded } = await setup();
  const { review, approve, cardId } = await sendReview();
  const u = await tap(approve, { messageId: cardId });
  // Telegram redelivers an update that wasn't confirmed: harmless.
  await telegram.handleUpdate(u);
  // A second, real tap on the same button.
  await tap(approve, { messageId: cardId });
  assert.equal(posts(), 1);
  const done = reviews.reviews.get(review.id)!;
  assert.equal(done.state, "approved");
  assert.equal(done.decidedVia, "telegram");
  assert.equal(done.decidedBy, ME);
  assert.ok(toasts().includes("Approving…"));
  assert.ok(toasts().includes("Already decided."));

  const post = store.post(done.postId!)!;
  assert.equal(post.approvedSha256, done.masterSha256);
  await settle(post.id);
  const job = store.jobsForPost(post.id)[0];
  assert.equal(job.state, "published", job.error ?? "");
  assert.equal(job.uploadedSha256, done.masterSha256);
  assert.deepEqual(uploaded, [done.masterPath], "uploaded as is, not re-rendered");
  assert.equal(reviews.audit().ok, true);
});

test("an approved edit's post carries the cover as a time in ms and the image; a basic edit's post has none", async () => {
  const { sendReview, tap, posts, reviews, store } = await setup();
  const cover = { path: coverFile(), atSec: 2.5 };
  const fancy = await sendReview("hi", null, { notes: [], cover });
  await tap(fancy.approve, { messageId: fancy.cardId });
  const post = store.post(reviews.reviews.get(fancy.review.id)!.postId!)!;
  assert.deepEqual(post.cover, { atMs: 2500, imagePath: cover.path });

  const plain = await sendReview("plain");
  await tap(plain.approve, { messageId: plain.cardId });
  assert.equal(posts(), 2);
  assert.equal(store.post(reviews.reviews.get(plain.review.id)!.postId!)!.cover, null);
});

test("Approve then Reject on the same card: it stays approved", async () => {
  const { sendReview, tap, reviews, posts } = await setup();
  const { review, approve, reject, cardId } = await sendReview();
  await tap(approve, { messageId: cardId });
  await tap(reject, { messageId: cardId });
  await tap(reject.replace(/^fp:r:/, "fp:rr:") + ":n", { messageId: cardId });
  assert.equal(reviews.reviews.get(review.id)!.state, "approved");
  assert.equal(posts(), 1);
});

test("taps from anyone else, in any other chat, or forged, change nothing", async () => {
  const { sendReview, tap, reviews, posts, toasts } = await setup();
  const { review, approve, cardId } = await sendReview();
  await tap(approve, { messageId: cardId, from: 222 });
  await tap(approve, { messageId: cardId, chat: -100123 });
  const [, , id, nonce] = approve.split(":");
  await tap(`fp:a:${id}:${"A".repeat(16)}`, { messageId: cardId }); // wrong nonce
  await tap(`fp:a:${Number(id) + 1}:${nonce}`, { messageId: cardId }); // another review
  await tap(`fp:a:${id}:${nonce}:zz`, { messageId: cardId }); // bad format
  await tap(approve, { messageId: cardId + 1 }); // not the card
  await tap(approve, { messageId: cardId, confirmed: false }); // a query Telegram never issued
  assert.equal(reviews.reviews.get(review.id)!.state, "pending");
  assert.equal(posts(), 0);
  assert.ok(toasts().includes("This isn't yours."));
  assert.ok(toasts().includes("This button isn't valid any more."));
});

test("typing yes approves nothing", async () => {
  const { sendReview, telegram, message, reviews, posts, tg } = await setup();
  const { review } = await sendReview();
  await telegram.handleUpdate(message("yes"));
  await telegram.handleUpdate(message("approve it, post now"));
  assert.equal(reviews.reviews.get(review.id)!.state, "pending");
  assert.equal(posts(), 0);
  assert.match(tg.last("sendMessage")!.params.text, /don't approve or reject anything/);
});

test("/stop from the paired user stops every campaign; from anyone else it does nothing", async () => {
  const { telegram, message, reviews, store, tg } = await setup();
  const worker = new CampaignWorker({ store, reviews, ai: null, productions: { productions: new ProductionStore(store), createStaged: async () => { throw new Error("unused"); }, borrowGpu: async () => null } });
  telegram.stopCampaigns = () => worker.stopAll();
  const cs = new CampaignStore(store);
  const sent = () => tg.all("sendMessage").length;
  const before = sent();
  await telegram.handleUpdate(message("/stop", { from: 999, chat: 999 }));
  await telegram.handleUpdate(message("/stop", { from: 999, chat: ME }));
  assert.equal(cs.killed(), false);
  assert.equal(sent(), before, "no reply to anyone else");
  await telegram.handleUpdate(message("/stop"));
  assert.equal(cs.killed(), true);
  assert.match(tg.last("sendMessage")!.params.text, /stopped/i);
});

test("a tap on an old version's card is refused: the review is superseded", async () => {
  const { sendReview, tap, reviews, posts, store } = await setup();
  const { review, edit, approve, cardId } = await sendReview();
  // The agent revised the edit (revise_edit): the old one is replaced.
  store.closeEdit(edit.id, "superseded");
  await tap(approve, { messageId: cardId });
  assert.equal(reviews.reviews.get(review.id)!.state, "superseded");
  assert.equal(posts(), 0);
});

test("a tap after the review expired posts nothing", async () => {
  const { sendReview, tap, reviews, posts, store } = await setup();
  const { review, approve, cardId } = await sendReview();
  store.db.prepare("UPDATE reviews SET expires_at = ? WHERE id = ?").run(Date.now() - 1, review.id);
  await tap(approve, { messageId: cardId });
  assert.equal(reviews.reviews.get(review.id)!.state, "expired");
  assert.equal(posts(), 0);
});

test("a changed file can't be approved, and a post whose file changed afterwards isn't uploaded", async () => {
  const { sendReview, tap, reviews, posts, store, settle, uploaded } = await setup();
  const first = await sendReview();
  appendFileSync(first.review.masterPath!, "x");
  await tap(first.approve, { messageId: first.cardId });
  assert.equal(reviews.reviews.get(first.review.id)!.state, "failed");
  assert.equal(posts(), 0);

  // Approved for later, then changed before it went out: the runner checks right before it sends anything.
  const second = await sendReview("another", Date.now() + 3_600_000);
  await tap(second.approve, { messageId: second.cardId });
  const postId = reviews.reviews.get(second.review.id)!.postId!;
  appendFileSync(second.review.masterPath!, "x");
  store.reschedulePost(postId, null);
  await settle(postId);
  const job = store.jobsForPost(postId)[0];
  assert.equal(job.state, "failed");
  assert.match(job.error!, /changed after it was approved/);
  assert.deepEqual(uploaded, []);
});

test("Reject asks why, then closes the review and the edit", async () => {
  const { sendReview, tap, reviews, store, tg, posts, telegram } = await setup();
  const { review, edit, reject, cardId } = await sendReview();
  await tap(reject, { messageId: cardId });
  const reasons = tg.last("editMessageReplyMarkup")!.params.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  const captions = reasons.find((d: string) => d.endsWith(":k"));
  await tap(captions, { messageId: cardId });
  const r = reviews.reviews.get(review.id)!;
  assert.equal(r.state, "rejected");
  assert.equal(r.reason, "captions");
  assert.equal(store.edit(edit.id)!.state, "rejected");
  assert.equal(posts(), 0);
  // The card shows the outcome and loses its buttons.
  await telegram.syncCards();
  const card = tg.last("editMessageCaption")!;
  assert.match(card.params.caption, /❌ Rejected .*captions/);
  assert.deepEqual(card.params.reply_markup.inline_keyboard, []);
});

test("Redo takes a reason and a note, maps its time to the source, and tells the agent", async () => {
  const { sendReview, tap, telegram, message, reviews, store, tg, posts } = await setup();
  config.produce.webhookUrl = "http://localhost:9/hook";
  try {
    const { review, edit, redo, cardId } = await sendReview();
    // The edit kept 0-5 s and 10-30 s of the source: 0:14 in the edit is 0:19 in the source.
    const cuts = join(tmp(), "cuts.json");
    writeFileSync(cuts, JSON.stringify([{ start: 0, end: 5 }, { start: 10, end: 30 }]));
    store.updateEdit(edit.id, { cutsPath: cuts });
    await tap(redo, { messageId: cardId });
    const cutsButton = tg.last("editMessageReplyMarkup")!.params.reply_markup.inline_keyboard.flat().find((b: any) => b.callback_data.endsWith(":c")).callback_data;
    await tap(cutsButton, { messageId: cardId });
    const prompt = tg.all("sendMessage").find((c) => /FreePoster redo/.test(c.params.text))!;
    assert.equal(prompt.params.reply_markup.force_reply, true);
    assert.equal(reviews.reviews.get(review.id)!.step, "redo_note");
    const promptId = reviews.reviews.get(review.id)!.promptMessageId!;
    await telegram.handleUpdate(message("the cut at 0:14 is too early", { replyTo: promptId }));
    const r = reviews.reviews.get(review.id)!;
    assert.equal(r.state, "redo");
    assert.equal(r.reason, "cuts");
    assert.equal(r.atSec, 14);
    const view = reviews.view(r);
    assert.equal((view.redo as any).source_sec, 19);
    const event = store.outbox().find((e) => e.event === "review.redo")!;
    assert.match(JSON.parse(event.body).summary, /revise_edit/);
    assert.equal(posts(), 0);
  } finally {
    config.produce.webhookUrl = "";
  }
});

test("a redo no agent picks up: listed as the agent's, and the user is told once, under the card", async () => {
  const { sendReview, reviews, store, tg } = await setup();
  const { review, cardId } = await sendReview();
  await reviews.redo(review.id, { via: "window", reason: "captions", note: "fix the spelling at 0:01" });
  assert.deepEqual(reviews.agentTodo().map((r) => r.id), [review.id]);
  assert.equal(reviews.view(reviews.reviews.get(review.id)!).waiting_for, "the agent to make the redo");
  const nudged = () => tg.all("sendMessage").filter((c) => /No agent has picked up/.test(c.params.text));

  await reviews.tick();
  assert.equal(nudged().length, 0, "not before the wait is up");
  store.db.prepare("UPDATE reviews SET decided_at = ? WHERE id = ?").run(Date.now() - 11 * 60_000, review.id);
  await reviews.tick();
  await reviews.tick();
  assert.equal(nudged().length, 1, "once");
  assert.equal(nudged()[0].params.reply_to_message_id, cardId);
  assert.ok(store.eventByKey(`review.redo:${review.id}`)!.nudgedAt);
  assert.deepEqual(reviews.agentTodo().map((r) => r.id), [review.id], "still the agent's until a new version comes");

  // The agent makes the new edit: nothing is waiting for it any more.
  const edit = store.edit(review.subjectId!)!;
  store.createEdit(edit.sourcePath, edit.sha256, { ...edit.settings, captions: false }, edit.id);
  assert.deepEqual(reviews.agentTodo(), []);
});

test("a redo an agent read from the feed isn't nudged; one FreePoster made itself isn't the agent's", async () => {
  const { sendReview, reviews, store, tg } = await setup();
  const { review } = await sendReview();
  await reviews.redo(review.id, { via: "window", reason: "cuts", note: "tighter" });
  store.markEventsRead([store.eventByKey(`review.redo:${review.id}`)!.id]);
  store.db.prepare("UPDATE reviews SET decided_at = ? WHERE id = ?").run(Date.now() - 11 * 60_000, review.id);
  await reviews.tick();
  assert.equal(tg.all("sendMessage").filter((c) => /No agent has picked up/.test(c.params.text)).length, 0);

  const second = await sendReview();
  reviews.autoRedo = () => "zooms off, edit 99";
  await reviews.redo(second.review.id, { via: "window", reason: "zooms", note: null });
  assert.equal(reviews.awaitingAgent(reviews.reviews.get(second.review.id)!), false);
});

test("a decision in the window updates the Telegram card: outcome on, buttons off", async () => {
  const { sendReview, reviews, telegram, tg } = await setup();
  const { review, cardId } = await sendReview();
  const out = await reviews.approve(review.id, { via: "window" });
  assert.equal(out.ok, true);
  await telegram.syncCards();
  const edit = tg.last("editMessageCaption")!;
  assert.equal(edit.params.message_id, cardId);
  assert.match(edit.params.caption, /✅ Approved/);
  assert.deepEqual(edit.params.reply_markup.inline_keyboard, []);
  assert.equal(reviews.reviews.get(review.id)!.cardDirty, false);
});

test("updates are confirmed only after they're handled", async () => {
  const { sendReview, telegram, tg, tapUpdate, posts, store } = await setup();
  const { approve, cardId } = await sendReview();
  const u = tapUpdate(approve, { messageId: cardId });
  tg.updates.push(u);
  const before = store.pref<number>("telegram.offset") ?? 0;
  await telegram.pollOnce();
  assert.equal(tg.last("getUpdates")!.params.offset, before + 1);
  assert.equal(store.pref("telegram.offset"), u.update_id);
  tg.updates.push(u); // redelivered after a crash
  await telegram.pollOnce();
  assert.equal(tg.last("getUpdates")!.params.offset, u.update_id + 1);
  assert.equal(posts(), 1);
});

test("with a shared bot: taps come through the signed relay, and FreePoster never reads the bot's updates", async () => {
  const { sendReview, telegram, tapUpdate, reviews, posts, tg, store } = await setup("shared");
  const secret = store.secretPref("telegram.relaySecret")!;
  const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({ ts: String(ts), sig: createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex") });
  const { review, approve, cardId } = await sendReview();

  const forged = JSON.stringify(tapUpdate(approve, { messageId: cardId }));
  assert.equal(await telegram.relay(forged, sign(forged).ts, "0".repeat(64)), 401, "bad signature");
  const old = sign(forged, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(await telegram.relay(forged, old.ts, old.sig), 401, "too old");

  // Signed, but a query Telegram never issued (e.g. made up by something that read the secret): not counted.
  const unconfirmed = JSON.stringify(tapUpdate(approve, { messageId: cardId, confirmed: false }));
  const s1 = sign(unconfirmed);
  assert.equal(await telegram.relay(unconfirmed, s1.ts, s1.sig), 200);
  assert.equal(reviews.reviews.get(review.id)!.state, "pending");

  const real = JSON.stringify(tapUpdate(approve, { messageId: cardId }));
  const s2 = sign(real);
  assert.equal(await telegram.relay(real, s2.ts, s2.sig), 200);
  assert.equal(reviews.reviews.get(review.id)!.state, "approved");
  assert.equal(posts(), 1);
  assert.equal(tg.all("getUpdates").length, 0, "the agent reads the bot's updates, not FreePoster");
});

test("a relay can sign the Standard Webhooks way instead", async () => {
  const { sendReview, telegram, tapUpdate, reviews, store } = await setup("shared");
  const secret = store.secretPref("telegram.relaySecret")!;
  const { review, approve, cardId } = await sendReview();
  const body = JSON.stringify(tapUpdate(approve, { messageId: cardId }));
  const ts = String(Math.floor(Date.now() / 1000));
  const good = `v1,${createHmac("sha256", secret).update(`msg_1.${ts}.${body}`).digest("base64")}`;
  assert.equal(await telegram.relay(body, undefined, undefined, { id: "msg_1", timestamp: ts, signature: "v1,AAAA" }), 401);
  assert.equal(await telegram.relay(body, undefined, undefined, { id: "msg_2", timestamp: ts, signature: good }), 401, "the id is signed too");
  assert.equal(await telegram.relay(body, undefined, undefined, { id: "msg_1", timestamp: ts, signature: `v1,old ${good}` }), 200);
  assert.equal(reviews.reviews.get(review.id)!.state, "approved");
});

test("a Telegram mode saved as \"hermes\" (before relays were generic) still means a shared bot", async () => {
  const { telegram, store } = await setup("shared");
  store.setPref("telegram.mode", "hermes");
  assert.equal(telegram.mode(), "shared");
  assert.equal(telegram.status().mode, "shared");
});

test("installing the Hermes plugin writes its address and secret; config.yaml decides whether it's on", async () => {
  const home = tmp();
  process.env.HERMES_HOME = home;
  try {
    const { telegram } = await setup("shared");
    writeFileSync(join(home, "config.yaml"), "model: x\nplugins:\n  enabled:\n    - something-else\n  disabled: []\nmcp_servers: {}\n");
    const status = installHermesPlugin(telegram.relayUrl(), telegram.relaySecret());
    assert.equal(status.detected, true);
    assert.equal(status.installed, true);
    assert.equal(status.configured, true);
    assert.equal(status.enabled, false);
    const settings = JSON.parse(readFileSync(join(home, "plugins", "freeposter-review", "settings.json"), "utf8"));
    assert.equal(settings.url, `${config.baseUrl}/api/telegram/relay`);
    assert.ok(existsSync(join(home, "plugins", "freeposter-review", "plugin.yaml")));
    writeFileSync(join(home, "config.yaml"), "plugins:\n  enabled:\n    - something-else\n    - freeposter-review\n  disabled: []\n");
    assert.equal(hermesPluginStatus(telegram.relayUrl(), telegram.relaySecret()).enabled, true);
  } finally {
    delete process.env.HERMES_HOME;
  }
});

test("helpers: times in notes, the plugin check, and the buttons", () => {
  assert.equal(parseTime("the cut at 0:14 is too early"), 14);
  assert.equal(parseTime("around 1:02.5"), 62.5);
  assert.equal(parseTime("at 14 seconds"), 14);
  assert.equal(parseTime("captions are off"), null);
  assert.equal(pluginEnabled("plugins:\n  enabled:\n    - freeposter-review\n"), true);
  assert.equal(pluginEnabled("plugins:\n  disabled:\n    - freeposter-review\n"), false);
  assert.equal(pluginEnabled("other:\n  enabled:\n    - freeposter-review\n"), false);
  const rows = keyboard({ id: 7, step: "redo_reason" }, "A".repeat(16));
  assert.ok(rows.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64));
  assert.ok(!rows.flat().some((b) => b.callback_data.endsWith(":n")), "a redo needs a reason");
});

test("the audit catches an upload that isn't the approved file", async () => {
  const { sendReview, tap, reviews, store, settle } = await setup();
  const { approve, cardId, review } = await sendReview();
  await tap(approve, { messageId: cardId });
  await settle(reviews.reviews.get(review.id)!.postId!);
  assert.equal(reviews.audit().ok, true);
  const job = store.jobsForPost(reviews.reviews.get(review.id)!.postId!)[0];
  store.recordUpload(job.id, "f".repeat(64));
  const audit = reviews.audit();
  assert.equal(audit.ok, false);
  assert.match(audit.problems[0].problem, /uploaded ffff/);
});
