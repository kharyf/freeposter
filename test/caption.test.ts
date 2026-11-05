import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackText, writeCaption } from "../src/caption.ts";
import type { ClaudeRun } from "../src/claude.ts";
import { publishers } from "../src/platforms/index.ts";
import type { Account } from "../src/types.ts";
import { account, newStore } from "./helpers.ts";

const store = newStore();
const accounts: Account[] = [store.upsertAccount(account("x")), store.upsertAccount(account("youtube"))];
const transcript = "So today I want to talk about gatekeeping and why it matters.";

/** A stand-in for `claude -p`: answers each run with the next reply and records the arguments and prompt. */
function claude(...replies: ({ title: string; caption: string; understood?: boolean } | "refusal")[]) {
  const calls: { args: string[]; prompt: string }[] = [];
  const run: ClaudeRun = async (_cmd, args, prompt) => {
    calls.push({ args, prompt });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const refused = reply === "refusal";
    const result = JSON.stringify({
      type: "result", subtype: "success", is_error: false, stop_reason: refused ? "refusal" : "end_turn",
      result: refused ? "" : JSON.stringify(reply), ...(refused ? {} : { structured_output: reply }),
    });
    // stream-json answers with one message per line, the result last.
    const streamed = args.includes("stream-json");
    return { code: 0, stderr: "", stdout: streamed ? `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({ type: "assistant" })}\n${result}\n` : result };
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
  assert.equal((await writeCaption({ topic: "t", transcript, accounts }, publishers, opts))?.title, "Short");
  assert.match(calls[1].prompt, /100/);
});

test("refusal throws", async () => {
  const { opts } = claude("refusal");
  await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers, opts), /declined/);
});

test("Claude Code not installed throws", async () => {
  await assert.rejects(writeCaption({ topic: "t", transcript, accounts }, publishers, { claudePath: "" }), /Claude Code isn't installed/);
});

test("no speech and no frames: null, without asking Claude", async () => {
  const { opts, calls } = claude({ title: "a", caption: "b" });
  assert.equal(await writeCaption({ topic: "t", transcript: "  ", accounts }, publishers, opts), null);
  assert.equal(calls.length, 0);
});

const frames = [Buffer.from("frame one"), Buffer.from("frame two")];

test("no speech: Claude reads the frames as images", async () => {
  const { opts, calls } = claude({ understood: true, title: "5 tips for better sleep", caption: "Sleep better tonight. #sleep #tips" });
  const out = await writeCaption({ topic: "Clip", transcript: "", accounts, frames }, publishers, opts);
  assert.deepEqual(out, { title: "5 tips for better sleep", caption: "Sleep better tonight. #sleep #tips" });
  const { args, prompt } = calls[0];
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.match(args[args.indexOf("--system-prompt") + 1], /on-screen text/);
  assert.ok(JSON.parse(args[args.indexOf("--json-schema") + 1]).required.includes("understood"));
  const msg = JSON.parse(prompt);
  const images = msg.message.content.filter((c: any) => c.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0].source.media_type, "image/jpeg");
  assert.equal(Buffer.from(images[0].source.data, "base64").toString(), "frame one");
  assert.match(msg.message.content[0].text, /no speech/);
});

test("no speech and frames that don't show what it's about: null", async () => {
  const { opts } = claude({ understood: false, title: "", caption: "" });
  assert.equal(await writeCaption({ topic: "Clip", transcript: "", accounts, frames }, publishers, opts), null);
});

test("frames are only sent when nobody speaks", async () => {
  const { opts, calls } = claude({ title: "Gatekeeping", caption: "Why it matters. #gatekeeping" });
  await writeCaption({ topic: "t", transcript, accounts, frames }, publishers, opts);
  assert.equal(calls[0].args[calls[0].args.indexOf("--output-format") + 1], "json");
  assert.match(calls[0].prompt, /why it matters/);
});

test("the fallback is #fyp with the file's name as the title", () => {
  assert.deepEqual(fallbackText("Gatekeeping"), { title: "Gatekeeping", caption: "#fyp" });
  assert.equal(fallbackText("a<b>".padEnd(150, "x")).title.length, 100);
  assert.equal(fallbackText("<>").title, "Video");
});
