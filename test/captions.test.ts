import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAss, SAFE_AREA } from "../src/edit/captions.ts";
import type { Word } from "../src/edit/transcribe.ts";

const words = (texts: string[], step = 0.3): Word[] => texts.map((text, i) => ({ text, start: i * step, end: i * step + step * 0.9 }));
const dialogues = (ass: string) => ass.split(/\r?\n/).filter((l) => l.startsWith("Dialogue:"));
const plain = (line: string) => line.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, "");

test("groups three words and highlights each", () => {
  const lines = dialogues(buildAss(words(["one", "two", "three", "four", "five", "six"])));
  assert.equal(lines.length, 6);
  assert.equal(plain(lines[0]), "one two three");
  assert.equal(plain(lines[2]), "one two three");
  assert.equal(plain(lines[3]), "four five six");
  assert.match(lines[1], /\{\\c&H0036D7FF&\}two\{\\c&H00FFFFFF&\}/);
});

test("breaks groups at sentence ends and long pauses", () => {
  const ws: Word[] = [
    { text: "Hi.", start: 0, end: 0.3 },
    { text: "So", start: 0.3, end: 0.5 },
    { text: "then", start: 1.5, end: 1.8 },
  ];
  const groups = [...new Set(dialogues(buildAss(ws)).map(plain))];
  assert.deepEqual(groups, ["Hi.", "So", "then"]);
});

test("stays inside safe area", () => {
  const ass = buildAss(words(["a"]));
  const format = ass.match(/^Format: Name.*$/m)![0].replace("Format: ", "").split(/,\s*/);
  const style = ass.match(/^Style: .*$/m)![0].replace("Style: ", "").split(",");
  const field = (name: string) => Number(style[format.indexOf(name)]);
  assert.equal(field("Alignment"), 2);
  assert.ok(field("MarginV") >= 1920 * SAFE_AREA.bottom, `MarginV ${field("MarginV")}`);
  assert.ok(field("MarginR") >= 1080 * SAFE_AREA.right, `MarginR ${field("MarginR")}`);
  assert.ok(field("MarginL") >= 1080 * SAFE_AREA.left);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
});

test("escapes braces and backslashes in words", () => {
  const line = dialogues(buildAss([{ text: "a{b}\\n", start: 0, end: 1 }]))[0];
  assert.ok(!plain(line).includes("{") && !plain(line).includes("\\"), line);
  assert.match(plain(line), /a.b.\Sn/);
});

test("empty words gives a valid file with no events", () => {
  const ass = buildAss([]);
  assert.match(ass, /\[Events\]/);
  assert.equal(dialogues(ass).length, 0);
});

test("event times are ASS clock format", () => {
  const line = dialogues(buildAss([{ text: "late", start: 65.5, end: 66.25 }]))[0];
  assert.match(line, /^Dialogue: 0,0:01:05\.50,0:01:06\.\d\d,/);
});
