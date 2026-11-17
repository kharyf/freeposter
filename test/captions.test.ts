import { readFileSync } from "node:fs";
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

const WORDS: Word[] = JSON.parse(readFileSync(new URL("./fixtures/captions-words.json", import.meta.url), "utf8"));
// Captured from buildAss(WORDS) before the Fancy look was added.
const BASIC_SNAPSHOT = readFileSync(new URL("./fixtures/captions-basic.ass", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Basic captions are unchanged", () => assert.equal(buildAss(WORDS), BASIC_SNAPSHOT));

test("Fancy captions use the italic serif style in cream with the spoken word yellow", () => {
  const ass = buildAss(WORDS, { look: "fancy" });
  assert.match(ass, /^Style: FancyCaption,Playfair Display,84,&H00D6F4FF,.*,-1,-1,/m);
  assert.match(ass, /^Style: FancyCaption,.*,&H000F1114,&H66000000,-1,-1,.*,1,3,2,/m);
  assert.match(ass, /\{\\c&H003FD2FF&\\fscx110\\fscy110\}/);
  assert.match(ass, /\\fscx100\\fscy100\}/);
  assert.ok(dialogues(ass).every((l) => l.includes(",FancyCaption,")));
});

test("seam captions sit in an ink box, so the gold rule never crosses them", () => {
  const ass = buildAss(WORDS, { look: "fancy", placeAt: (t) => (t < 1 ? "seam" : "lower") });
  // Same font and colours; BorderStyle 3 (an opaque box) in ink at 85% (alpha 26), with padding.
  assert.match(ass, /^Style: FancySeam,Playfair Display,84,&H00D6F4FF,&H00D6F4FF,&H260F1114,&H260F1114,-1,-1,0,0,100,100,0,0,3,\d+,0,/m);
  const lines = dialogues(ass);
  for (const l of lines) assert.equal(l.includes(",FancySeam,"), l.includes("\\an5\\pos(492,960)"), l);
  assert.ok(lines.some((l) => l.includes(",FancySeam,")) && lines.some((l) => l.includes(",FancyCaption,")));
});

test("seam placement centres the caption at y=960, lower sits in the safe area", () => {
  const ass = buildAss(WORDS, { look: "fancy", placeAt: (t) => (t < 1 ? "seam" : "lower") });
  assert.match(ass, /\\an5\\pos\(492,960\)/);
  assert.match(ass, /\\an2\\pos\(492,1\d{3}\)/);
  const lowerY = Number(/\\an2\\pos\(492,(\d+)\)/.exec(ass)![1]);
  assert.ok(lowerY <= 1920 - 1920 * SAFE_AREA.bottom);
});

test("Fancy captions default to the lower third", () => {
  assert.match(buildAss(WORDS, { look: "fancy" }), /\\an2\\pos\(492,1496\)/);
});

test("Fancy captions centre on the safe band, not the frame, and wrap inside it", () => {
  const left = Math.ceil(1080 * SAFE_AREA.left), right = 1080 - Math.ceil(1080 * SAFE_AREA.right);
  const x = Math.round((left + right) / 2);
  assert.equal(x, 492);
  const ass = buildAss(WORDS, { look: "fancy", placeAt: (t) => (t < 1 ? "seam" : "lower") });
  assert.ok(dialogues(ass).every((l) => l.includes(`\\pos(${x},`)));
  // Each Fancy style wraps at 1080 less its margins, centred on x, plus the seam box's 14 px padding: inside the band.
  for (const name of ["FancyCaption", "FancySeam"]) {
    const f = new RegExp(`^Style: ${name},.*`, "m").exec(ass)![0].split(",");
    const [ml, mr] = [Number(f[19]), Number(f[20])];
    const half = (1080 - ml - mr) / 2;
    assert.equal(ml + half, x, `${name} wraps centred on the caption`);
    assert.ok(x - half - 14 >= left && x + half + 14 <= right, `${name}: ${x - half - 14}..${x + half + 14}`);
  }
});

test("a caption group never spans a break, so it never moves mid-group", () => {
  // Six words 0.3 s apart; the placement changes at 0.5 s, between "two" (0.3) and "three" (0.6).
  const ws = words(["one", "two", "three", "four", "five", "six"]);
  const placeAt = (t: number): "seam" | "lower" => (t < 0.5 ? "seam" : "lower");
  const lines = dialogues(buildAss(ws, { look: "fancy", placeAt, breakAt: [0.5] }));
  assert.deepEqual(lines.map(plain), ["one two", "one two", "three four five", "three four five", "three four five", "six"]);
  // Every event of a group sits in the same place.
  assert.ok(lines.slice(0, 2).every((l) => l.includes("\\an5")));
  assert.ok(lines.slice(2).every((l) => l.includes("\\an2")));
  // The last word before the break isn't held past it ("two" ends at 0.57; held, it would run to 0.82).
  assert.equal(lines[1].split(",")[2], "0:00:00.50");
  // Without the break the first group would mix the two places.
  assert.equal(plain(dialogues(buildAss(ws, { look: "fancy", placeAt }))[0]), "one two three");
});
