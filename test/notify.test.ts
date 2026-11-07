import "./isolated-home.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { MAX_ATTEMPTS, Notifier, queueEvent, signBody } from "../src/notify.ts";
import { json, newStore } from "./helpers.ts";

async function withWebhook(fn: () => void | Promise<void>) {
  const saved = { ...config.produce };
  config.produce.webhookUrl = "http://localhost:8644/webhooks/freeposter";
  config.produce.webhookSecret = "s3cret";
  try { await fn(); } finally { Object.assign(config.produce, saved); }
}

const fakeFetch = (status: number, seen: { url: string; init: RequestInit }[] = []) =>
  (async (url: any, init: RequestInit = {}) => { seen.push({ url: String(url), init }); return json({}, status); }) as typeof fetch;

test("signBody is the hex HMAC-SHA256 of '<timestamp>.<body>'", () => {
  const body = '{"event_type":"post.done"}';
  assert.equal(signBody(body, "k", 1700000000), createHmac("sha256", "k").update(`1700000000.${body}`).digest("hex"));
});

test("no webhook URL: nothing is queued", () => {
  const store = newStore();
  queueEvent(store, "post.done", "post.done:1", { post_id: 1 }, "done");
  assert.equal(store.dueEvents(Date.now() + 1).length, 0);
});

test("a delivered event is signed, carries event_type and is sent once", async () => {
  await withWebhook(async () => {
    const store = newStore();
    queueEvent(store, "production.ready", "production.ready:3:1", { production_id: 3 }, "Production 3 is ready.");
    queueEvent(store, "production.ready", "production.ready:3:1", { production_id: 3 }, "duplicate key is ignored");
    const seen: { url: string; init: RequestInit }[] = [];
    const n = new Notifier(store, { fetch: fakeFetch(200, seen) });
    await n.tick();
    await n.tick();
    assert.equal(seen.length, 1);
    const body = String(seen[0].init.body);
    const parsed = JSON.parse(body);
    assert.equal(parsed.event_type, "production.ready");
    assert.equal(parsed.production_id, 3);
    assert.equal(parsed.summary, "Production 3 is ready.");
    const headers = seen[0].init.headers as Record<string, string>;
    assert.equal(headers["X-Webhook-Signature-V2"], signBody(body, "s3cret", Number(headers["X-Webhook-Timestamp"])));
    assert.equal(seen[0].url, "http://localhost:8644/webhooks/freeposter");
  });
});

test("a failed delivery backs off, and stops after the last attempt", async () => {
  await withWebhook(async () => {
    const store = newStore();
    queueEvent(store, "post.done", "post.done:9", { post_id: 9 }, "done");
    const n = new Notifier(store, { fetch: fakeFetch(500) });
    await n.tick();
    const [row] = store.outbox();
    assert.equal(row.attempts, 1);
    assert.ok(row.nextTryAt > Date.now());
    assert.match(row.lastError ?? "", /500/);
    // pretend time passes until every attempt is used
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      store.db.prepare("UPDATE notify_outbox SET next_try_at = 0").run();
      await n.tick();
    }
    assert.equal(store.outbox()[0].attempts, MAX_ATTEMPTS);
    store.db.prepare("UPDATE notify_outbox SET next_try_at = 0").run();
    assert.equal(store.dueEvents(Date.now()).length, 0);
  });
});

test("events older than 7 days are pruned", async () => {
  await withWebhook(async () => {
    const store = newStore();
    queueEvent(store, "post.done", "post.done:1", { post_id: 1 }, "done");
    store.db.prepare("UPDATE notify_outbox SET created_at = ?").run(Date.now() - 8 * 86_400_000);
    await new Notifier(store, { fetch: fakeFetch(200) }).tick();
    assert.equal(store.outbox().length, 0);
  });
});
