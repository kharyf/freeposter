// Reviews on Telegram. FreePoster sends each review as a card (the video, the exact file, the post's details, and
// Approve / Reject / Redo buttons) to the one chat paired in setup. Taps reach FreePoster one of two ways:
//
//  - "own": a bot only FreePoster uses; FreePoster reads its updates itself (long-polling getUpdates).
//  - "hermes": the bot Hermes Agent already talks through. Telegram lets one program read a bot's updates, and
//    that's Hermes, so the freeposter-review Hermes plugin passes FreePoster's taps (and replies to its redo
//    prompts) straight here, signed, without the model seeing them. FreePoster still sends with the bot's token.
//
// Either way a tap counts only when Telegram confirms it (answerCallbackQuery succeeds only for a query Telegram
// really issued), it comes from the paired user in the paired chat, it carries the nonce of the card's current
// buttons (only its hash is stored), and the review is still pending, current and unexpired. Decisions go through
// ReviewService, whose guarded state change makes a repeated update or a second tap harmless.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openAsBlob, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codeDir, config } from "../config.ts";
import type { Store } from "../db.ts";
import { backoffMs } from "../runner.ts";
import { probe, TARGET } from "../media.ts";
import { TELEGRAM_UPLOAD_LIMIT } from "./media.ts";
import type { ReviewService } from "./service.ts";
import { REASONS, type Reason, type Review, type ReviewStep } from "./store.ts";

const API = "https://api.telegram.org";
export type TelegramMode = "own" | "hermes";
export const PLUGIN_NAME = "freeposter-review";
/** Redo prompts start with this; the Hermes plugin passes replies to them to FreePoster instead of the model. */
export const REDO_MARKER = "🔁 FreePoster redo";
const RELAY_SKEW_SEC = 300;

/** Hermes Agent's home folder (HERMES_HOME, else %LOCALAPPDATA%\hermes). */
export const hermesHome = () => process.env.HERMES_HOME?.trim() || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "hermes");
/** Where the plugin's files ship: templates/, unpacked beside the bundle in the installed app. */
const pluginSource = () => join(codeDir.replace(/app\.asar$/, "app.asar.unpacked"), "templates", "hermes", PLUGIN_NAME);

/** Whether Hermes's config.yaml lists the plugin under plugins.enabled. */
export function pluginEnabled(yaml: string): boolean {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^plugins:\s*$/.test(l));
  if (start < 0) return false;
  let inEnabled = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key
    if (/^\s+enabled:\s*$/.test(line)) { inEnabled = true; continue; }
    if (/^\s+\w+:/.test(line)) { inEnabled = false; continue; }
    if (inEnabled && line.replace(/^\s*-\s*/, "").replace(/["']/g, "").trim() === PLUGIN_NAME && /^\s*-/.test(line)) return true;
  }
  return false;
}
const PAIR_MS = 15 * 60_000;
const CAPTION_LIMIT = 1024;

export class TelegramError extends Error {
  status: number;
  retryAfter: number | null;
  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** One Bot API method call; the token never leaves this class. */
export class TelegramApi {
  #token: string;
  fetch: typeof fetch;
  base: string;

  constructor(token: string, fetchImpl: typeof fetch = fetch, base = API) {
    this.#token = token;
    this.fetch = fetchImpl;
    this.base = base;
  }

  async call<T = any>(method: string, params: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    const form = params instanceof FormData;
    const res = await this.fetch(`${this.base}/bot${this.#token}/${method}`, {
      method: "POST",
      headers: form ? {} : { "content-type": "application/json" },
      body: form ? params : JSON.stringify(params),
      signal: signal ?? AbortSignal.timeout(method === "getUpdates" ? 60_000 : 120_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (!body.ok) throw new TelegramError(res.status, body.description ?? `Telegram answered ${res.status}`, body.parameters?.retry_after ?? null);
    return body.result as T;
  }
}

export interface Paired {
  chatId: number;
  userId: number;
  name: string;
}

const hashNonce = (nonce: string) => createHash("sha256").update(nonce).digest("hex");

function nonceMatches(stored: string | null, nonce: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(hashNonce(nonce), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** fp:<action>:<review id>:<16-character nonce>[:<reason letter>], at most about 32 bytes of the allowed 64. */
const CALLBACK = /^fp:(a|r|d|b|rr|dr):(\d{1,10}):([A-Za-z0-9_-]{16})(?::([a-z]))?$/;

const REASON_LABELS: Record<Reason, string> = {
  cuts: "Cuts", captions: "Captions", framing: "Framing", sound: "Sound", zooms: "Zooms", other: "Something else", none: "No reason",
};
const letterOf = (reason: Reason) => (Object.entries(REASONS).find(([, r]) => r === reason) ?? ["o"])[0];

type Button = { text: string; callback_data: string };

export function keyboard(r: Pick<Review, "id" | "step">, nonce: string): Button[][] {
  const cb = (action: string, extra = "") => `fp:${action}:${r.id}:${nonce}${extra}`;
  if (r.step === "reject_reason" || r.step === "redo_reason") {
    const act = r.step === "reject_reason" ? "rr" : "dr";
    const reasons = (Object.keys(REASON_LABELS) as Reason[]).filter((x) => act === "rr" || x !== "none");
    const rows: Button[][] = [];
    for (let i = 0; i < reasons.length; i += 2) rows.push(reasons.slice(i, i + 2).map((x) => ({ text: REASON_LABELS[x], callback_data: cb(act, `:${letterOf(x)}`) })));
    rows.push([{ text: "‹ Back", callback_data: cb("b") }]);
    return rows;
  }
  if (r.step === "redo_note") return [[{ text: "‹ Cancel redo", callback_data: cb("b") }]];
  return [[{ text: "✅ Approve", callback_data: cb("a") }], [{ text: "❌ Reject", callback_data: cb("r") }, { text: "🔁 Redo", callback_data: cb("d") }]];
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export class TelegramReview {
  store: Store;
  service: ReviewService;
  fetch: typeof fetch;
  base: string;
  pollTimeoutSec: number;
  running = false;
  controller: AbortController | undefined;
  syncTimer: NodeJS.Timeout | undefined;
  syncing: Promise<void> | undefined;

  constructor(store: Store, service: ReviewService, opts: { fetch?: typeof fetch; base?: string; pollTimeoutSec?: number } = {}) {
    this.store = store;
    this.service = service;
    this.fetch = opts.fetch ?? ((...args) => fetch(...args));
    this.base = opts.base ?? API;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    service.onChange = () => this.poke();
  }

  // ---- setup: the bot's token and the one paired chat ----

  api(): TelegramApi | null {
    const token = this.store.secretPref("telegram.token");
    return token ? new TelegramApi(token, this.fetch, this.base) : null;
  }

  paired(): Paired | null {
    return this.store.pref<Paired>("telegram.paired") ?? null;
  }

  status() {
    const pair = this.store.pref<{ code: string; expiresAt: number }>("telegram.pair");
    return {
      configured: Boolean(this.store.secretPref("telegram.token")),
      mode: this.mode(),
      plugin: this.mode() === "hermes" ? this.pluginStatus() : null,
      bot: this.store.pref<{ username: string }>("telegram.bot")?.username ?? null,
      paired: this.paired()?.name ?? null,
      pairCode: pair && pair.expiresAt > Date.now() && !this.paired() ? pair.code : null,
      error: this.store.pref<string>("telegram.error") ?? null,
    };
  }

  mode(): TelegramMode {
    return this.store.pref<TelegramMode>("telegram.mode") ?? "own";
  }

  /**
   * Checks a token from @BotFather and keeps it (encrypted, like the platforms' tokens); a new bot pairs afresh.
   * "hermes": the bot Hermes already uses (its TELEGRAM_BOT_TOKEN); taps come through the Hermes plugin.
   */
  async connect(token: string, mode: TelegramMode = "own") {
    token = token.trim();
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("that doesn't look like a bot token from @BotFather (it's like 123456789:AA…)");
    const me = await new TelegramApi(token, this.fetch, this.base).call<{ id: number; username: string }>("getMe");
    const old = this.store.pref<{ id: number }>("telegram.bot");
    this.store.setSecretPref("telegram.token", token);
    this.store.setPref("telegram.bot", { id: me.id, username: me.username });
    if (old?.id !== me.id) {
      this.store.deletePref("telegram.paired");
      this.store.deletePref("telegram.offset");
    }
    this.store.setPref("telegram.mode", mode);
    if (mode === "hermes" && !this.store.secretPref("telegram.relaySecret")) this.store.setSecretPref("telegram.relaySecret", randomBytes(32).toString("hex"));
    this.store.deletePref("telegram.error");
    if (!this.paired()) this.startPairing();
    if (mode === "hermes") this.controller?.abort(); // stop reading the bot's updates: Hermes does
    return this.status();
  }

  /** A 6-digit code the user sends to the bot; whoever sends it within 15 minutes, in a private chat, is paired. */
  startPairing() {
    this.store.setPref("telegram.pair", { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: Date.now() + PAIR_MS });
    return this.status();
  }

  disconnect() {
    for (const k of ["telegram.token", "telegram.bot", "telegram.paired", "telegram.offset", "telegram.pair", "telegram.error", "telegram.mode", "telegram.relaySecret", "telegram.lastRelay"]) this.store.deletePref(k);
  }

  async sendTest() {
    const api = this.api();
    const paired = this.paired();
    if (!api || !paired) throw new Error("connect the bot and pair your chat first");
    await api.call("sendMessage", { chat_id: paired.chatId, text: "FreePoster test: reviews will come to this chat. Only the buttons under a video approve anything." });
  }

  // ---- the Hermes plugin (mode "hermes") ----

  pluginDir() {
    return join(hermesHome(), "plugins", PLUGIN_NAME);
  }

  /** Whether the plugin is in Hermes's plugins folder, set up for this FreePoster, and enabled in config.yaml. */
  pluginStatus() {
    const dir = this.pluginDir();
    let configured = false;
    try {
      const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      configured = s.url === this.relayUrl() && s.secret === this.store.secretPref("telegram.relaySecret");
    } catch {}
    let enabled = false;
    try { enabled = pluginEnabled(readFileSync(join(hermesHome(), "config.yaml"), "utf8")); } catch {}
    return { installed: existsSync(join(dir, "__init__.py")), configured, enabled, dir, lastRelay: this.store.pref<number>("telegram.lastRelay") ?? null };
  }

  relayUrl() {
    return `${config.baseUrl}/api/telegram/relay`;
  }

  /** Copies the plugin into Hermes's plugins folder with this FreePoster's address and secret. */
  installPlugin() {
    const secret = this.store.secretPref("telegram.relaySecret");
    if (this.mode() !== "hermes" || !secret) throw new Error("connect the Hermes bot first");
    const src = pluginSource();
    if (!existsSync(join(src, "__init__.py"))) throw new Error(`the plugin's files are missing from ${src}`);
    const dir = this.pluginDir();
    mkdirSync(dir, { recursive: true });
    cpSync(src, dir, { recursive: true, filter: (p) => !p.includes("__pycache__") });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ url: this.relayUrl(), secret }, null, 2), { mode: 0o600 });
    return this.pluginStatus();
  }

  /**
   * An update the Hermes plugin passed on: the raw body, signed like FreePoster's own webhook
   * (hex HMAC-SHA256 of "<timestamp>.<body>" with the relay secret). Returns an HTTP status.
   */
  async relay(body: string, timestamp: string | undefined, signature: string | undefined): Promise<number> {
    const secret = this.store.secretPref("telegram.relaySecret");
    if (this.mode() !== "hermes" || !secret) return 404;
    const ts = Number(timestamp);
    if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > RELAY_SKEW_SEC) return 401;
    const want = Buffer.from(createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"));
    const got = Buffer.from(String(signature ?? ""));
    if (want.length !== got.length || !timingSafeEqual(want, got)) return 401;
    let update: any;
    try { update = JSON.parse(body); } catch { return 400; }
    this.store.setPref("telegram.lastRelay", Date.now());
    await this.handleUpdate(update);
    if (Number.isInteger(update?.update_id) && update.update_id > (this.store.pref<number>("telegram.offset") ?? 0)) this.store.setPref("telegram.offset", update.update_id);
    return 200;
  }

  // ---- running ----

  start() {
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
    const sync = () => {
      void this.syncCards().catch((err) => console.error(`telegram cards: ${(err as Error).message}`));
      this.syncTimer = setTimeout(sync, 3_000);
    };
    sync();
  }

  stop() {
    this.running = false;
    this.controller?.abort();
    clearTimeout(this.syncTimer);
  }

  /** A review changed: bring its card up to date now rather than at the next sync. */
  poke() {
    if (this.running) void this.syncCards().catch((err) => console.error(`telegram cards: ${(err as Error).message}`));
  }

  private async pollLoop() {
    let failures = 0;
    while (this.running) {
      // With Hermes's bot, Hermes reads the updates and its plugin passes FreePoster's on (relay()).
      if (!this.api() || this.mode() !== "own") {
        this.controller = new AbortController();
        await this.sleep(3_000);
        continue;
      }
      try {
        await this.pollOnce();
        failures = 0;
        if (this.store.pref("telegram.error")) this.store.deletePref("telegram.error");
      } catch (err) {
        if (!this.running) return;
        failures++;
        const e = err as TelegramError;
        const message = e.status === 409
          ? "Another program is reading this bot's messages (is this your agent's bot?). Make a separate bot with @BotFather for FreePoster."
          : e.status === 401 ? "Telegram refused the bot token; connect the bot again." : `Telegram: ${e.message}`;
        this.store.setPref("telegram.error", message);
        console.error(`telegram: ${message}`);
        await this.sleep(e.retryAfter ? e.retryAfter * 1000 : backoffMs(failures));
      }
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((done) => {
      const t = setTimeout(done, ms);
      this.controller?.signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
    });
  }

  /** One getUpdates long-poll; each update is handled, then confirmed by saving the offset past it. */
  async pollOnce() {
    const api = this.api();
    if (!api) return;
    this.controller = new AbortController();
    const offset = this.store.pref<number>("telegram.offset") ?? 0;
    const updates = await api.call<any[]>("getUpdates", { offset: offset + 1, timeout: this.pollTimeoutSec, allowed_updates: ["message", "callback_query"] }, this.controller.signal);
    for (const u of updates) {
      try {
        await this.handleUpdate(u);
      } catch (err) {
        console.error(`telegram update ${u.update_id}: ${(err as Error).message}`);
      }
      // Saved after handling: a crash before this gets the update again, which the checks make harmless.
      this.store.setPref("telegram.offset", u.update_id);
    }
  }

  async handleUpdate(u: any) {
    if (!u || !Number.isInteger(u.update_id)) return;
    // Already handled (Telegram redelivers what wasn't confirmed).
    if (u.update_id <= (this.store.pref<number>("telegram.offset") ?? 0)) return;
    if (u.callback_query) return this.handleCallback(u.update_id, u.callback_query);
    if (u.message) return this.handleMessage(u.update_id, u.message);
  }

  // ---- button taps ----

  private async handleCallback(updateId: number, q: any) {
    const api = this.api();
    if (!api) return;
    // Answering is also the proof the tap is real: Telegram refuses a query id it never issued (or already answered).
    const confirm = async (text: string) => {
      try {
        await api.call("answerCallbackQuery", { callback_query_id: String(q.id ?? ""), text: text.slice(0, 200) });
        return true;
      } catch (err) {
        console.warn(`telegram: a tap Telegram didn't confirm was ignored (${(err as Error).message})`);
        return false;
      }
    };
    const paired = this.paired();
    if (!paired || q.from?.id !== paired.userId || q.message?.chat?.id !== paired.chatId) {
      console.warn(`telegram: ignored a tap from user ${q.from?.id} in chat ${q.message?.chat?.id}`);
      await confirm("This isn't yours.");
      return;
    }
    const m = CALLBACK.exec(String(q.data ?? ""));
    if (!m) { await confirm("This button isn't valid."); return; }
    const [, action, idText, nonce, letter] = m;
    const r = this.service.reviews.get(Number(idText));
    if (!r || !nonceMatches(r.nonceHash, nonce) || q.message.message_id !== r.cardMessageId) { await confirm("This button isn't valid any more."); return; }
    if (r.state !== "pending") { await confirm("Already decided."); return; }
    const decision = { via: "telegram" as const, by: q.from.id as number, updateId };
    /** A refusal after the toast was used: said in the chat, under the card. */
    const tell = (text: string) => api.call("sendMessage", { chat_id: paired.chatId, reply_to_message_id: r.cardMessageId, text }).catch(() => {});

    if (action === "a" || action === "rr") {
      if (!(await confirm(action === "a" ? "Approving…" : "Rejecting…"))) return;
      const outcome = action === "a"
        ? await this.service.approve(r.id, decision)
        : await this.service.reject(r.id, { ...decision, reason: REASONS[letter as keyof typeof REASONS] ?? "other" });
      if (!outcome.ok) await tell(outcome.message);
      return;
    }
    let step: ReviewStep | null = null;
    let reason: Reason | null = null;
    let toast = "";
    if (action === "r") { step = "reject_reason"; toast = "Why? Pick one (it's optional)."; }
    else if (action === "d") { step = "redo_reason"; toast = "What needs redoing?"; }
    else if (action === "dr") { step = "redo_note"; reason = REASONS[letter as keyof typeof REASONS] ?? "other"; toast = "Reply to the message below with what should change."; }
    if (!(await confirm(toast))) return;
    if (!this.service.reviews.setStep(r.id, step, reason)) { await tell("Already decided."); return; }
    if (step === "redo_note") {
      const prompt = await api.call<{ message_id: number }>("sendMessage", {
        chat_id: paired.chatId,
        reply_to_message_id: r.cardMessageId,
        text: `${REDO_MARKER} (${REASON_LABELS[reason!].toLowerCase()}, review ${r.id}): reply to this message with what should change. Add a time like 0:14 if it's one spot, or reply "go" to redo it without a note.`,
        reply_markup: { force_reply: true, input_field_placeholder: "e.g. the cut at 0:14 is too early" },
      });
      this.service.reviews.setPrompt(r.id, prompt.message_id);
    }
    await this.editButtons(api, { ...r, step }, nonce);
  }

  private async editButtons(api: TelegramApi, r: Review, nonce: string) {
    try {
      await api.call("editMessageReplyMarkup", { chat_id: r.chatId, message_id: r.cardMessageId, reply_markup: { inline_keyboard: keyboard(r, nonce) } });
    } catch (err) {
      if (!/not modified/i.test((err as Error).message)) this.service.reviews.markDirty(r.id);
    }
  }

  // ---- typed messages: pairing, redo notes, and a reminder that typing approves nothing ----

  private async handleMessage(updateId: number, m: any) {
    const api = this.api();
    if (!api) return;
    const text = String(m.text ?? "").trim();
    const paired = this.paired();
    const reply = (t: string, extra: Record<string, unknown> = {}) => api.call("sendMessage", { chat_id: m.chat.id, text: t, ...extra }).catch(() => {});
    if (!paired) {
      const pair = this.store.pref<{ code: string; expiresAt: number }>("telegram.pair");
      if (m.chat?.type === "private" && pair && pair.expiresAt > Date.now() && text.replace(/^\/(start|freeposter)(@\w+)?\s*/, "") === pair.code) {
        const name = m.from?.username ? `@${m.from.username}` : String(m.from?.first_name ?? m.from?.id);
        this.store.setPref("telegram.paired", { chatId: m.chat.id, userId: m.from.id, name } satisfies Paired);
        this.store.deletePref("telegram.pair");
        await reply("Paired. FreePoster will send videos here for you to approve, reject or redo.");
        this.poke();
      } else if (m.chat?.type === "private") {
        await reply(`Send the 6-digit code shown in FreePoster's setup${this.mode() === "hermes" ? " as /freeposter <code>" : ""} to pair this chat.`);
      }
      return;
    }
    if (m.chat?.id !== paired.chatId || m.from?.id !== paired.userId) return;
    const prompt = m.reply_to_message ? this.service.reviews.byPrompt(paired.chatId, m.reply_to_message.message_id) : undefined;
    if (prompt) {
      const note = /^(go|skip|-|no note)$/i.test(text) ? null : text.slice(0, 2000) || null;
      const outcome = await this.service.redo(prompt.id, { via: "telegram", by: m.from.id, updateId, reason: prompt.reason, note });
      await reply(outcome.message, { reply_to_message_id: m.message_id });
      return;
    }
    // With Hermes's bot only replies to redo prompts and /freeposter reach here; everything else is Hermes's.
    if (this.mode() === "hermes") return;
    const waiting = this.service.reviews.inState("pending").length;
    await reply(`Typed messages don't approve or reject anything. Use the buttons under a video${waiting ? ` (${waiting} waiting)` : ""}.`);
  }

  // ---- cards ----

  cardText(r: Review): { text: string; truncated: boolean } {
    const v = this.service.view(r);
    const head = [
      `🎬 ${v.label}${r.durationSec !== null ? ` · ${r.durationSec.toFixed(1)} s` : ""}`,
      `To: ${v.accounts.map((a) => `${a.platform ?? "?"} ${a.name}`).join(", ")}`,
      `Posts: ${r.draft.scheduledAt ? when(r.draft.scheduledAt) : "as soon as you approve"}`,
      ...(r.draft.title && r.draft.title !== r.draft.caption ? [`Title: ${r.draft.title}`] : []),
    ].join("\n");
    const tail = `File ${r.masterSha256?.slice(0, 16) ?? "?"}… · review ${r.id} · expires ${when(r.expiresAt)}${this.outcome(r)}`;
    const room = CAPTION_LIMIT - head.length - tail.length - 40;
    const caption = r.draft.caption;
    const truncated = caption.length > room;
    const shown = truncated ? `${caption.slice(0, Math.max(room, 0))}… (full caption below)` : caption;
    return { text: `${head}\nCaption:\n${shown}\n\n${tail}`, truncated };
  }

  private outcome(r: Review): string {
    const at = r.decidedAt ? ` ${when(r.decidedAt)}` : "";
    switch (r.state) {
      case "approved": return `\n\n✅ Approved${at}${r.postId ? ` · post ${r.postId}` : ""}`;
      case "rejected": return `\n\n❌ Rejected${at}${r.reason && r.reason !== "none" ? ` · ${r.reason}` : ""}${r.note ? `: ${r.note}` : ""}`;
      case "redo": return `\n\n🔁 Redo asked${at}${r.reason ? ` · ${r.reason}` : ""}${r.note ? `: ${r.note}` : ""}`;
      case "superseded": return "\n\n⏭ Replaced by a newer version";
      case "expired": return "\n\n⌛ Expired without a decision";
      case "failed": return `\n\n⚠️ ${r.error ?? "Failed"}`;
      default: return "";
    }
  }

  /** Sends new cards and brings changed ones up to date. One sync at a time. */
  syncCards(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async doSync() {
    const api = this.api();
    const paired = this.paired();
    if (!api || !paired) return;
    for (const r of this.service.reviews.dueCards(Date.now())) {
      try {
        if (r.cardMessageId === null) await this.sendCard(api, paired, r);
        else await this.updateCard(api, r);
      } catch (err) {
        const e = err as TelegramError;
        const wait = e.retryAfter ? e.retryAfter * 1000 : backoffMs(r.sendAttempts + 1);
        console.error(`[review ${r.id}] telegram: ${e.message}`);
        this.service.reviews.sendFailed(r.id, e.message, Date.now() + wait);
      }
    }
  }

  private async sendCard(api: TelegramApi, paired: Paired, r: Review) {
    if (!r.viewPath || !r.masterPath) return;
    const nonce = randomBytes(12).toString("base64url");
    this.service.reviews.setNonce(r.id, hashNonce(nonce));
    const { text, truncated } = this.cardText(r);
    const form = new FormData();
    form.append("chat_id", String(paired.chatId));
    form.append("video", await openAsBlob(r.viewPath, { type: "video/mp4" }), `review-${r.id}.mp4`);
    form.append("caption", text);
    form.append("supports_streaming", "true");
    // Without its size Telegram guesses the frame's shape and squashes a portrait video into a landscape box.
    const dims = await probe(r.viewPath).catch(() => null);
    form.append("width", String(dims?.width || (r.viewPath === r.masterPath ? TARGET.width : 720)));
    form.append("height", String(dims?.height || (r.viewPath === r.masterPath ? TARGET.height : 1280)));
    const duration = Math.round(dims?.durationSec || r.durationSec || 0);
    if (duration > 0) form.append("duration", String(duration));
    form.append("reply_markup", JSON.stringify({ inline_keyboard: keyboard(r, nonce) }));
    const card = await api.call<{ message_id: number }>("sendVideo", form);
    this.service.reviews.cardSent(r.id, paired.chatId, card.message_id, r.cardVersion);
    console.log(`[review ${r.id}] sent to Telegram`);

    // The rest is for the reviewer's convenience; a failure here doesn't hold the review up.
    try {
      const size = statSync(r.masterPath).size;
      if (size <= TELEGRAM_UPLOAD_LIMIT) {
        const doc = new FormData();
        doc.append("chat_id", String(paired.chatId));
        doc.append("reply_to_message_id", String(card.message_id));
        doc.append("document", await openAsBlob(r.masterPath, { type: "video/mp4" }), `review-${r.id}-exact.mp4`);
        doc.append("caption", `The exact file that will post (${(size / 1048576).toFixed(1)} MB). Fingerprint ${r.masterSha256}`);
        doc.append("disable_content_type_detection", "true");
        await api.call("sendDocument", doc);
      } else {
        await api.call("sendMessage", {
          chat_id: paired.chatId, reply_to_message_id: card.message_id,
          text: `The exact file is too big for Telegram (${(size / 1048576).toFixed(0)} MB), so the video above is a smaller copy of it. Its fingerprint is ${r.masterSha256}.`,
        });
      }
      if (truncated) await api.call("sendMessage", { chat_id: paired.chatId, reply_to_message_id: card.message_id, text: `Full caption:\n\n${r.draft.caption}`.slice(0, 4096) });
    } catch (err) {
      console.error(`[review ${r.id}] telegram extras: ${(err as Error).message}`);
    }
  }

  private async updateCard(api: TelegramApi, r: Review) {
    try {
      if (r.state === "pending") {
        // Fresh buttons (the card's old ones stop working); used after a failed inline edit or a restart mid-flow.
        const nonce = randomBytes(12).toString("base64url");
        this.service.reviews.setNonce(r.id, hashNonce(nonce));
        await api.call("editMessageReplyMarkup", { chat_id: r.chatId, message_id: r.cardMessageId, reply_markup: { inline_keyboard: keyboard(r, nonce) } });
      } else {
        // Decided or closed: the outcome goes on the card and the buttons come off, for good.
        this.service.reviews.setNonce(r.id, hashNonce(randomBytes(12).toString("base64url")));
        await api.call("editMessageCaption", { chat_id: r.chatId, message_id: r.cardMessageId, caption: this.cardText(r).text, reply_markup: { inline_keyboard: [] } });
      }
    } catch (err) {
      const message = (err as Error).message;
      // Nothing to change, or the message is gone (deleted in the chat): either way the card is as good as it gets.
      if (!/not modified|not found|can't be edited/i.test(message)) throw err;
    }
    this.service.reviews.cardSynced(r.id, r.cardVersion);
  }
}
