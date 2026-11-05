import assert from "node:assert/strict";
import { test } from "node:test";
import { askClaude, type ClaudeRun } from "../src/claude.ts";

const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
const q = { system: "sys", prompt: "hello", schema };
const reply = (stdout: string, code = 0, stderr = ""): ClaudeRun => async () => ({ code, stdout, stderr });

test("returns structured output and passes the question along", async () => {
  let seen: { cmd: string; args: string[]; stdin: string } | undefined;
  const run: ClaudeRun = async (cmd, args, stdin) => {
    seen = { cmd, args, stdin };
    return { code: 0, stderr: "", stdout: JSON.stringify({ is_error: false, result: "", structured_output: { a: "yes" } }) };
  };
  assert.deepEqual(await askClaude(q, { run, claudePath: "/bin/claude" }), { a: "yes" });
  assert.equal(seen!.cmd, "/bin/claude");
  assert.equal(seen!.stdin, "hello");
  assert.ok(seen!.args.includes("-p") && seen!.args.includes("--no-session-persistence") && seen!.args.includes("--strict-mcp-config"));
  assert.equal(seen!.args[seen!.args.indexOf("--system-prompt") + 1], "sys");
  assert.deepEqual(JSON.parse(seen!.args[seen!.args.indexOf("--json-schema") + 1]), schema);
});

test("falls back to parsing the result text", async () => {
  assert.deepEqual(await askClaude(q, { run: reply(JSON.stringify({ is_error: false, result: '{"a":"b"}' })), claudePath: "c" }), { a: "b" });
});

test("reports Claude Code's own error, such as a usage limit", async () => {
  const run = reply(JSON.stringify({ is_error: true, result: "Claude usage limit reached" }), 1);
  await assert.rejects(askClaude(q, { run, claudePath: "c" }), /Claude Code: Claude usage limit reached/);
});

test("non-JSON output is reported with what it said", async () => {
  await assert.rejects(askClaude(q, { run: reply("", 1, "Invalid API key · Please run /login"), claudePath: "c" }), /Claude Code failed \(exit 1\): Invalid API key/);
});

test("not installed", async () => {
  await assert.rejects(askClaude(q, { claudePath: "" }), /isn't installed/);
});
