// Tells the user's agent when something happens (a production or edit is ready, a review was decided, a post went
// out), whichever agent it is. Every event goes into an event log in the database, which any agent reads through
// MCP (list_events, or wait_for_events to wait without spending turns) or the CLI (freeposter events --watch).
// When a webhook is set, events are also pushed to it from there: a crash or a receiver that is down loses nothing.
// Each webhook delivery carries two signatures over the same secret, so most receivers can check it as they stand:
//  - Standard Webhooks (standardwebhooks.com): webhook-id, webhook-timestamp, and webhook-signature =
//    "v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">" (a secret starting "whsec_" is base64 after the prefix);
//  - the plain scheme (Hermes Agent's webhook platform, among others): X-Webhook-Timestamp and
//    X-Webhook-Signature-V2 = hex HMAC-SHA256 of "<timestamp>.<body>".
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { config } from "./config.ts";
import type { Store } from "./db.ts";
import { backoffMs } from "./runner.ts";

export type EventType =
  | "production.ready" | "production.failed" | "edit.ready" | "edit.failed" | "post.done"
  | "review.waiting" | "review.approved" | "review.rejected" | "review.redo" | "review.failed" | "review.expired"
  | "campaign.failed" | "campaign.missed" | "campaign.waiting" | "campaign.rule" | "campaign.changed";

export const MAX_ATTEMPTS = 5;
const KEEP_MS = 7 * 86_400_000;

export const EVENT_TYPES: EventType[] = [
  "production.ready", "production.failed", "edit.ready", "edit.failed", "post.done",
  "review.waiting", "review.approved", "review.rejected", "review.redo", "review.failed", "review.expired",
  "campaign.failed", "campaign.missed", "campaign.waiting", "campaign.rule", "campaign.changed",
];

/** Fires "event" whenever one is logged, so a wait_for_events call answers at once. */
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(0);

export const signBody = (body: string, secret: string, timestamp: number) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/** Standard Webhooks' signature header value: "v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">". */
export function standardSignature(id: string, timestamp: number, body: string, secret: string) {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6), "base64") : Buffer.from(secret);
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/**
 * Logs an event once per key (e.g. "post.done:12"), for agents to read and, when a webhook is set, to push.
 * summary = one plain sentence the agent can pass on as it stands.
 */
export function queueEvent(store: Store, event: EventType, key: string, fields: Record<string, unknown>, summary: string) {
  const body = JSON.stringify({ event_type: event, at: new Date().toISOString(), summary, ...fields });
  if (store.addEvent(key, event, body, Boolean(config.produce.webhookUrl))) eventBus.emit("event");
}

/** One logged event as agents see it: its id (the feed's cursor) and the event's own fields. */
export function eventView(row: { id: number; body: string }): Record<string, unknown> {
  let fields: Record<string, unknown> = {};
  try { fields = JSON.parse(row.body); } catch {}
  return { id: row.id, ...fields };
}

/** Resolves when an event is logged or `ms` passes (or the signal aborts), whichever is first. */
export function nextEvent(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => { clearTimeout(timer); eventBus.off("event", finish); signal?.removeEventListener("abort", finish); done(); };
    const timer = setTimeout(finish, ms);
    eventBus.on("event", finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** POSTs a body to the webhook with both signatures (see the top of this file); throws unless it answers 2xx. */
export async function postSigned(url: string, secret: string, body: string, requestId: string, fetchImpl: typeof fetch = fetch) {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": requestId,
      "webhook-timestamp": String(ts),
      "webhook-signature": standardSignature(requestId, ts, body, secret),
      "X-Webhook-Timestamp": String(ts),
      "X-Webhook-Signature-V2": signBody(body, secret, ts),
      "X-Request-ID": requestId,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook answered ${res.status}`);
}

export class Notifier {
  store: Store;
  fetch: typeof fetch;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;

  constructor(store: Store, opts: { fetch?: typeof fetch } = {}) {
    this.store = store;
    this.fetch = opts.fetch ?? ((...args) => fetch(...args));
  }

  start(intervalMs = 3_000) {
    const tick = () => {
      void this.tick();
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  tick(): Promise<void> {
    this.running ??= this.deliver().finally(() => (this.running = undefined));
    return this.running;
  }

  async deliver() {
    this.store.pruneEvents(Date.now() - KEEP_MS);
    const url = config.produce.webhookUrl;
    if (!url) return;
    for (const row of this.store.dueEvents(Date.now(), MAX_ATTEMPTS)) {
      const attempts = row.attempts + 1;
      try {
        await postSigned(url, config.produce.webhookSecret, row.body, row.key, this.fetch);
        this.store.markEvent(row.id, { sentAt: Date.now(), attempts, nextTryAt: row.nextTryAt, error: null });
      } catch (err) {
        const message = (err as Error).message;
        console.error(`[notify ${row.event}] attempt ${attempts} failed: ${message}`);
        this.store.markEvent(row.id, { attempts, nextTryAt: Date.now() + backoffMs(attempts), error: message });
      }
    }
  }
}
