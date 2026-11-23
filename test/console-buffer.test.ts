import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsoleBuffer, installConsoleCapture } from "../src/console-buffer.ts";

test("ConsoleBuffer keeps order, a ring of `limit`, and reports drops", () => {
  const b = new ConsoleBuffer(3);
  for (const t of ["a", "b", "c", "d"]) b.push("info", t);
  const r = b.since(0);
  assert.deepEqual(r.lines.map((l) => l.text), ["b", "c", "d"]);
  assert.deepEqual(r.lines.map((l) => l.seq), [2, 3, 4]);
  assert.equal(r.latest, 4);
  assert.equal(r.dropped, true);
  assert.deepEqual(b.since(2), { lines: b.since(0).lines.slice(1), latest: 4, dropped: false });
  assert.deepEqual(b.since(4).lines, []);
});

test("ConsoleBuffer.since after > latest (server restarted) returns everything", () => {
  const b = new ConsoleBuffer();
  b.push("info", "x");
  assert.deepEqual(b.since(900).lines.map((l) => l.text), ["x"]);
  assert.deepEqual(b.since(-3).lines.length, 1);
  assert.deepEqual(b.since(NaN).lines.length, 1);
});

test("installConsoleCapture formats, levels, chains, is idempotent, uninstalls", () => {
  const seen: string[] = [];
  const target: any = { log: (...a: unknown[]) => seen.push("log:" + a.join(" ")), info: () => {}, warn: () => {}, error: (...a: unknown[]) => seen.push("err:" + a.join(" ")) };
  const b = new ConsoleBuffer();
  const undo = installConsoleCapture(b, target);
  installConsoleCapture(b, target);                    // second install: no double capture
  target.log("job %d", 7);
  target.error("boom");
  assert.deepEqual(b.since(0).lines.map((l) => [l.level, l.text]), [["info", "job 7"], ["error", "boom"]]);
  assert.deepEqual(seen, ["log:job %d 7", "err:boom"]);
  undo();
  target.log("after");
  assert.equal(b.since(0).lines.length, 2);
});
