// Tells the user's agent when something long finishes (a production, an edit, a post), so it never polls.
// Events go into an outbox in the database first and are delivered from there: a crash or a receiver that is
// down loses nothing. The signature is the generic one Hermes Agent's webhook platform checks:
// X-Webhook-Timestamp + X-Webhook-Signature-V2 = hex HMAC-SHA256 of "<timestamp>.<body>".
import { createHmac } from "node:crypto";
import { config } from "./config.ts";
import type { Store } from "./db.ts";
import { backoffMs } from "./runner.ts";

export type EventType = "production.ready" | "production.failed" | "edit.ready" | "edit.failed" | "post.done";

export const MAX_ATTEMPTS = 5;
const KEEP_MS = 7 * 86_400_000;

export const signBody = (body: string, secret: string, timestamp: number) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/**
 * Queues an event for the webhook, once per key (e.g. "post.done:12"). Nothing is queued when no webhook is set.
 * summary = one plain sentence the agent can pass on as it stands.
 */
export function queueEvent(store: Store, event: EventType, key: string, fields: Record<string, unknown>, summary: string) {
  if (!config.produce.webhookUrl) return;
  const body = JSON.stringify({ event_type: event, at: new Date().toISOString(), summary, ...fields });
  store.addEvent(key, event, body);
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
      const ts = Math.floor(Date.now() / 1000);
      const attempts = row.attempts + 1;
      try {
        const res = await this.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Timestamp": String(ts),
            "X-Webhook-Signature-V2": signBody(row.body, config.produce.webhookSecret, ts),
            "X-Request-ID": row.key,
          },
          body: row.body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`webhook answered ${res.status}`);
        this.store.markEvent(row.id, { sentAt: Date.now(), attempts, nextTryAt: row.nextTryAt, error: null });
      } catch (err) {
        const message = (err as Error).message;
        console.error(`[notify ${row.event}] attempt ${attempts} failed: ${message}`);
        this.store.markEvent(row.id, { attempts, nextTryAt: Date.now() + backoffMs(attempts), error: message });
      }
    }
  }
}
