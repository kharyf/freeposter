import assert from "node:assert/strict";
import { before, test } from "node:test";
import { config } from "../src/config.ts";
import { AuthError, FatalError, RetryableError } from "../src/http.ts";
import { StillProcessing, type Publisher, type PublishContext } from "../src/platforms/base.ts";
import { Runner } from "../src/runner.ts";
import type { Platform } from "../src/types.ts";
import { account, newStore, sha256, tmp, verticalSilent } from "./helpers.ts";

let video: string;
let dir: string;
before(() => {
  dir = tmp();
  video = verticalSilent(dir);
});

function fakePublisher(publish: (ctx: PublishContext) => Promise<{ url: string; note?: string }>, extra: Partial<Publisher> = {}): Publisher {
  return {
    platform: "x",
    label: "Fake",
    minDurationSec: 1,
    maxDurationSec: () => 60,
    validate: () => null,
    authorizeUrl: () => "",
    exchangeCode: async () => [],
    refresh: async () => ({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: Date.now() + 3_600_000, refreshExpiresAt: null }),
    publish,
    ...extra,
  };
}

function setup(publisher: Publisher) {
  const store = newStore();
  const acct = store.upsertAccount(account("x"));
  const runner = new Runner(store, { x: publisher } as Record<Platform, Publisher>, dir);
  const queue = () => store.createPost({ caption: "hi", title: "", sourcePath: video, sha256: sha256(video), tiktok: null }, [acct.id]);
  const runDue = async () => {
    store.db.prepare("UPDATE jobs SET next_run_at = 0 WHERE state IN ('retry','queued')").run();
    await Promise.all(runner.tick());
  };
  return { store, acct, runner, queue, runDue };
}

test("a job publishes and records the platform URL", async () => {
  const { store, queue, runDue } = setup(fakePublisher(async (ctx) => {
    assert.equal(ctx.durationSec > 3.5, true);
    return { url: "https://x.com/u/status/1" };
  }));
  const postId = queue();
  await runDue();
  const [job] = store.jobsForPost(postId);
  assert.equal(job.state, "published");
  assert.equal(job.resultUrl, "https://x.com/u/status/1");
});

test("a crash after upload resumes from the checkpoint and never uploads twice", async () => {
  let uploads = 0;
  let publishes = 0;
  let crash = true;
  const { store, queue, runDue } = setup(fakePublisher(async (ctx) => {
    if (!ctx.progress.uploaded) {
      uploads++;
      ctx.progress.uploaded = true;
      ctx.save(ctx.progress);
    }
    if (crash) {
      crash = false;
      throw new RetryableError("connection reset");
    }
    publishes++;
    return { url: "https://x.com/u/status/2" };
  }));
  const postId = queue();
  await runDue();
  assert.equal(store.jobsForPost(postId)[0].state, "retry");
  await runDue();
  const [job] = store.jobsForPost(postId);
  assert.equal(job.state, "published");
  assert.equal(uploads, 1);
  assert.equal(publishes, 1);
});

test("still-processing re-checks later without spending attempts", async () => {
  let calls = 0;
  const { store, queue, runDue } = setup(fakePublisher(async () => {
    if (++calls < 4) throw new StillProcessing("processing", 1000);
    return { url: "https://x.com/u/status/3" };
  }));
  const postId = queue();
  for (let i = 0; i < 4; i++) await runDue();
  const [job] = store.jobsForPost(postId);
  assert.equal(job.state, "published");
  assert.equal(job.attempts, 1);
});

test("fatal errors fail immediately with the platform's reason", async () => {
  const { store, queue, runDue } = setup(fakePublisher(async () => {
    throw new FatalError("video rejected: copyright");
  }));
  const postId = queue();
  await runDue();
  const [job] = store.jobsForPost(postId);
  assert.equal(job.state, "failed");
  assert.match(job.error!, /copyright/);
});

test("retryable errors give up after the attempt limit", async () => {
  const { store, queue, runDue } = setup(fakePublisher(async () => {
    throw new RetryableError("503");
  }));
  const postId = queue();
  for (let i = 0; i < 8; i++) await runDue();
  const [job] = store.jobsForPost(postId);
  assert.equal(job.state, "failed");
  assert.equal(job.attempts, 6);
});

test("a rejected token is refreshed once and the post continues", async () => {
  const tokens: string[] = [];
  const { store, queue, runDue } = setup(fakePublisher(async (ctx) => {
    tokens.push(ctx.account.accessToken);
    if (ctx.account.accessToken === "access-1") throw new AuthError("401");
    return { url: "https://x.com/u/status/4" };
  }));
  const postId = queue();
  await runDue();
  assert.equal(store.jobsForPost(postId)[0].state, "published");
  assert.deepEqual(tokens, ["access-1", "access-2"]);
});

test("the daily cap holds jobs instead of failing them", async () => {
  const saved = config.dailyCap.x;
  config.dailyCap.x = 1;
  try {
    const { store, queue, runDue } = setup(fakePublisher(async () => ({ url: "https://x.com/u/status/5" })));
    const first = queue();
    await runDue();
    const second = queue();
    store.db.prepare("UPDATE jobs SET next_run_at = 0 WHERE state = 'queued'").run();
    await runDue();
    assert.equal(store.jobsForPost(first)[0].state, "published");
    const [held] = store.jobsForPost(second);
    assert.equal(held.state, "waiting_quota");
    assert.equal(held.attempts, 0);
    assert.ok(held.nextRunAt > Date.now() + 23 * 3_600_000);
  } finally {
    config.dailyCap.x = saved;
  }
});

test("videos too long for a platform are rejected before upload", async () => {
  let called = false;
  const { store, queue, runDue } = setup(fakePublisher(async () => {
    called = true;
    return { url: "" };
  }, { maxDurationSec: () => 2 }));
  const postId = queue();
  await runDue();
  const [job] = store.jobsForPost(postId);
  assert.equal(job.state, "failed");
  assert.match(job.error!, /up to 2s/);
  assert.equal(called, false);
});

test("post.done is queued once, when the post's last job finishes", async () => {
  const saved = config.produce.webhookUrl;
  config.produce.webhookUrl = "http://localhost:8644/webhooks/freeposter";
  try {
    const { store, queue, runDue } = setup(fakePublisher(async () => ({ url: "https://x.com/u/status/7" })));
    const post = queue();
    await runDue();
    await runDue();
    const rows = store.outbox();
    assert.equal(rows.length, 1);
    const body = JSON.parse(rows[0].body);
    assert.equal(body.event_type, "post.done");
    assert.equal(body.post_id, post);
    assert.equal(body.results[0].url, "https://x.com/u/status/7");
  } finally {
    config.produce.webhookUrl = saved;
  }
});
