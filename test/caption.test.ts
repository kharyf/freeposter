import assert from "node:assert/strict";
import { test } from "node:test";
import { writeCaption } from "../src/caption.ts";
import { config } from "../src/config.ts";
import { publishers } from "../src/platforms/index.ts";
import type { Account } from "../src/types.ts";
import { account, newStore } from "./helpers.ts";

const store = newStore();
const accounts: Account[] = [store.upsertAccount(account("x")), store.upsertAccount(account("youtube"))];
const transcript = "So today I want to talk about gatekeeping and why it matters.";

/** A Messages API stand-in: answers each request with the next reply and records the bodies. */
function claude(...replies: ({ title: string; caption: string } | "refusal")[]) {
  const bodies: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)];
    const refused = reply === "refusal";
    return new Response(JSON.stringify({
      id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "claude-opus-5-5",
      content: refused ? [] : [{ type: "text", text: JSON.stringify(reply) }],
      stop_reason: refused ? "refusal" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}

const withKey = async (fn: () => Promise<void>) => {
  const before = config.anthropicKey;
  config.anthropicKey = "sk-ant-test";
  try { await fn(); } finally { config.anthropicKey = before; }
};

test("returns title and caption", () => withKey(async () => {
  const { fetch, bodies } = claude({ title: "Gatekeeping, explained", caption: "Why gatekeeping matters. #gatekeeping" });
  const out = await writeCaption({ topic: "Gatekeeping", transcript, accounts }, publishers, { fetch });
  assert.deepEqual(out, { title: "Gatekeeping, explained", caption: "Why gatekeeping matters. #gatekeeping" });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "claude-opus-5-5");
  assert.equal(bodies[0].fallbacks, "default");
  assert.equal(bodies[0].output_config.format.type, "json_schema");
  assert.match(JSON.stringify(bodies[0].messages), /why it matters/);
  assert.match(JSON.stringify(bodies[0].messages), /Gatekeeping/);
}));

test("retries with the problem when X limit is exceeded", () => withKey(async () => {
  const long = { title: "Gatekeeping", caption: "a".repeat(300) };
  const fine = { title: "Gatekeeping", caption: "Short and sweet. #gatekeeping" };
  const { fetch, bodies } = claude(long, fine);
  const out = await writeCaption({ topic: "Gatekeeping", transcript, accounts }, publishers, { fetch });
  assert.deepEqual(out, fine);
  assert.equal(bodies.length, 2);
  const second = JSON.stringify(bodies[1].messages);
  assert.match(second, /280/);
  assert.equal(bodies[1].messages.length, 3, "the first answer and the problem are appended");
}));

test("gives up after the retries", () => withKey(async () => {
  const { fetch, bodies } = claude({ title: "x", caption: "a".repeat(300) });
  await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers, { fetch }), /caption writing failed/);
  assert.equal(bodies.length, 3);
}));

test("title over 100 characters is retried", () => withKey(async () => {
  const { fetch, bodies } = claude({ title: "t".repeat(120), caption: "ok" }, { title: "Short", caption: "ok" });
  assert.equal((await writeCaption({ topic: "t", transcript, accounts }, publishers, { fetch })).title, "Short");
  assert.match(JSON.stringify(bodies[1].messages), /100/);
}));

test("refusal throws", () => withKey(async () => {
  const { fetch } = claude("refusal");
  await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers, { fetch }), /declined/);
}));

test("missing key throws", async () => {
  const before = config.anthropicKey;
  config.anthropicKey = "";
  try {
    await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers), /Anthropic API key/);
  } finally { config.anthropicKey = before; }
});

test("empty transcript throws", () => withKey(async () => {
  await assert.rejects(writeCaption({ topic: "t", transcript: "  ", accounts }, publishers, { fetch: claude({ title: "a", caption: "b" }).fetch }), /no speech/);
}));
