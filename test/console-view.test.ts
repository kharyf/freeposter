import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const ctx: any = {};
vm.runInNewContext(readFileSync("public/console-view.js", "utf8"), ctx);
/** Results come from another realm, so compare them as plain JSON. */
const j = (x: unknown) => JSON.parse(JSON.stringify(x));

test("mergeLines appends new lines, ignores repeats, caps, and resets on restart", () => {
  const C = ctx.FreePosterConsole;
  const line = (seq: number) => ({ seq, at: 0, level: "info", text: "t" + seq });
  let s = { lines: [], seq: 0, dropped: false };
  let r = C.mergeLines(s, { lines: [line(1), line(2)], latest: 2, dropped: false });
  assert.deepEqual(j(r.added).map((l: any) => l.seq), [1, 2]);
  r = C.mergeLines(r.state, { lines: [line(2), line(3)], latest: 3, dropped: false });
  assert.deepEqual(j(r.state.lines).map((l: any) => l.seq), [1, 2, 3]);
  r = C.mergeLines(r.state, { lines: [line(1)], latest: 1, dropped: false });   // server restarted
  assert.equal(r.reset, true);
  assert.deepEqual(j(r.state.lines).map((l: any) => l.seq), [1]);
  const many = Array.from({ length: 5001 }, (_, i) => line(i + 1));
  r = C.mergeLines({ lines: [], seq: 0, dropped: false }, { lines: many, latest: 5001, dropped: false });
  assert.equal(r.state.lines.length, 5000);
  assert.equal(r.state.dropped, true);
});

test("mergeLines does not mutate its input state", () => {
  const C = ctx.FreePosterConsole;
  const s = { lines: [{ seq: 1, at: 0, level: "info", text: "a" }], seq: 1, dropped: false };
  const before = JSON.stringify(s);
  C.mergeLines(s, { lines: [{ seq: 2, at: 0, level: "info", text: "b" }], latest: 2, dropped: true });
  assert.equal(JSON.stringify(s), before);
});

test("matchSegments is literal and case-insensitive", () => {
  const C = ctx.FreePosterConsole;
  assert.deepEqual(j(C.matchSegments("[job 12 x] Uploaded", "[JOB 12")), [{ text: "[job 12", hit: true }, { text: " x] Uploaded", hit: false }]);
  assert.deepEqual(j(C.matchSegments("a.b a.b", ".*")), null);
  assert.deepEqual(j(C.matchSegments("aXa", "a")), [{ text: "a", hit: true }, { text: "X", hit: false }, { text: "a", hit: true }]);
  assert.deepEqual(j(C.matchSegments("abc", "")), [{ text: "abc", hit: false }]);
  assert.equal(C.clock(new Date(2026, 0, 1, 3, 4, 5).getTime()), "03:04:05");
});
