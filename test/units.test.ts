import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decrypt, encrypt } from "../src/crypto.ts";
import { AuthError, FatalError, RetryableError, request } from "../src/http.ts";
import { chunkPlan, chunkRange } from "../src/platforms/tiktok.ts";
import { xLength } from "../src/platforms/x.ts";
import { backoffMs } from "../src/runner.ts";
import { json, mockFetch } from "./helpers.ts";

const MB = 1024 * 1024;

test("token encryption round-trips and detects tampering", () => {
  const key = randomBytes(32);
  const sealed = encrypt(key, "secret-token");
  assert.notEqual(sealed, "secret-token");
  assert.equal(decrypt(key, sealed), "secret-token");
  const raw = Buffer.from(sealed, "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decrypt(key, raw.toString("base64")));
});

test("TikTok chunk plan follows the 5/64/128 MB rules", () => {
  assert.deepEqual(chunkPlan(3 * MB), { chunkSize: 3 * MB, count: 1 });
  assert.deepEqual(chunkPlan(5 * MB), { chunkSize: 5 * MB, count: 1 });
  const p = chunkPlan(47 * MB + 123);
  assert.deepEqual(p, { chunkSize: 10 * MB, count: 4 });
  // last chunk absorbs the remainder and stays under 128 MB
  const last = chunkRange(47 * MB + 123, p, 3);
  assert.equal(last.end, 47 * MB + 122);
  assert.ok(last.end - last.start + 1 < 128 * MB);
  // chunks tile the file exactly
  let next = 0;
  for (let i = 0; i < p.count; i++) {
    const r = chunkRange(47 * MB + 123, p, i);
    assert.equal(r.start, next);
    next = r.end + 1;
  }
  assert.equal(next, 47 * MB + 123);
});

test("X length counts URLs as 23 and wide characters as 2", () => {
  assert.equal(xLength("hello"), 5);
  assert.equal(xLength("see https://example.com/a/very/long/path?q=1"), 4 + 23);
  assert.equal(xLength("🔥"), 2);
  assert.equal(xLength("日本"), 4);
});

test("backoff grows, caps at 30 minutes, and jitters within ±20%", () => {
  assert.equal(backoffMs(1, () => 0.5), 30_000);
  assert.equal(backoffMs(3, () => 0.5), 120_000);
  assert.equal(backoffMs(20, () => 0.5), 30 * 60_000);
  assert.equal(backoffMs(1, () => 0), 24_000);
  assert.equal(backoffMs(1, () => 1), 36_000);
});

test("HTTP errors are classified for the runner", async () => {
  const cases: [Response, Function][] = [
    [json({}, 503), RetryableError],
    [json({}, 429, { "retry-after": "7" }), RetryableError],
    [json({}, 401), AuthError],
    [json({ error: { code: 190, message: "expired" } }, 400), AuthError],
    [json({ error: { code: 2, is_transient: true } }, 400), RetryableError],
    [json({ error: { code: 100, message: "bad param" } }, 400), FatalError],
  ];
  for (const [res, kind] of cases) {
    const m = mockFetch(() => res);
    try {
      await assert.rejects(request("https://api.example.com/x"), (e: any) => e instanceof kind && !(kind === FatalError && e instanceof AuthError));
    } finally {
      m.restore();
    }
  }
  const m = mockFetch(() => json({}, 429, { "retry-after": "7" }));
  await request("https://api.example.com/x").catch((e) => assert.equal(e.retryAfterMs, 7000));
  m.restore();
});
