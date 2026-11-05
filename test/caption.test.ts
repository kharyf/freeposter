import assert from "node:assert/strict";
import { test } from "node:test";
import { writeCaption } from "../src/caption.ts";
import type { ClaudeRun } from "../src/claude.ts";
import { publishers } from "../src/platforms/index.ts";
import type { Account } from "../src/types.ts";
import { account, newStore } from "./helpers.ts";

const store = newStore();
const accounts: Account[] = [store.upsertAccount(account("x")), store.upsertAccount(account("youtube"))];
const transcript = "So today I want to talk about gatekeeping and why it matters.";

/** A stand-in for `claude -p`: answers each run with the next reply and records the arguments and prompt. */
function claude(...replies: ({ title: string; caption: string } | "refusal")[]) {
  const calls: { args: string[]; prompt: string }[] = [];
  const run: ClaudeRun = async (_cmd, args, prompt) => {
    calls.push({ args, prompt });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const refused = reply === "refusal";
    return {
      code: 0, stderr: "",
      stdout: JSON.stringify({
        type: "result", subtype: "success", is_error: false, stop_reason: refused ? "refusal" : "end_turn",
        result: refused ? "" : JSON.stringify(reply), ...(refused ? {} : { structured_output: reply }),
      }),
    };
  };
  return { opts: { run, claudePath: "claude" }, calls };
}

test("returns title and caption", async () => {
  const { opts, calls } = claude({ title: "Gatekeeping, explained", caption: "Why gatekeeping matters. #gatekeeping" });
  const out = await writeCaption({ topic: "Gatekeeping", transcript, accounts }, publishers, opts);
  assert.deepEqual(out, { title: "Gatekeeping, explained", caption: "Why gatekeeping matters. #gatekeeping" });
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(JSON.parse(args[args.indexOf("--json-schema") + 1]).required.join(), "title,caption");
  assert.equal(args[args.indexOf("--tools") + 1], "", "no tools");
  assert.match(calls[0].prompt, /why it matters/);
  assert.match(calls[0].prompt, /Gatekeeping/);
});

test("retries with the problem when X limit is exceeded", async () => {
  const long = { title: "Gatekeeping", caption: "a".repeat(300) };
  const fine = { title: "Gatekeeping", caption: "Short and sweet. #gatekeeping" };
  const { opts, calls } = claude(long, fine);
  const out = await writeCaption({ topic: "Gatekeeping", transcript, accounts }, publishers, opts);
  assert.deepEqual(out, fine);
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /280/);
  assert.match(calls[1].prompt, /why it matters/, "the original request is kept");
  assert.ok(calls[1].prompt.includes("a".repeat(300)), "the earlier answer is carried along");
});

test("gives up after the retries", async () => {
  const { opts, calls } = claude({ title: "x", caption: "a".repeat(300) });
  await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers, opts), /caption writing failed/);
  assert.equal(calls.length, 3);
});

test("title over 100 characters is retried", async () => {
  const { opts, calls } = claude({ title: "t".repeat(120), caption: "ok" }, { title: "Short", caption: "ok" });
  assert.equal((await writeCaption({ topic: "t", transcript, accounts }, publishers, opts)).title, "Short");
  assert.match(calls[1].prompt, /100/);
});

test("refusal throws", async () => {
  const { opts } = claude("refusal");
  await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers, opts), /declined/);
});

test("Claude Code not installed throws", async () => {
  await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers, { claudePath: "" }), /Claude Code isn't installed/);
});

test("empty transcript throws", async () => {
  await assert.rejects(writeCaption({ topic: "t", transcript: "  ", accounts }, publishers, claude({ title: "a", caption: "b" }).opts), /no speech/);
});
