import "./isolated-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { renderKeywordCard } from "../src/edit/fancy/keyword-card.ts";
import { fancyFontFile, PALETTE } from "../src/edit/fancy/palette.ts";
import { checkParams, fallbackParamsFor, fancyTemplates, OBJECT_ICONS, toShot } from "../src/edit/fancy/templates.ts";
import { probe } from "../src/media.ts";
import { tmp } from "./helpers.ts";

const IDS = ["build-list", "compare", "gold-3d-object", "gold-3d-word", "icon-callout", "keyword-card", "kinetic-words", "pull-quote", "stat-counter", "steps"];

test("every Fancy template loads, and every fallback chain ends at keyword-card", () => {
  const t = fancyTemplates();
  assert.deepEqual(Object.keys(t).sort(), IDS);
  for (const id of Object.keys(t)) {
    let cur = id, n = 0;
    while (t[cur].fallback) { cur = t[cur].fallback!; assert.ok(++n < 5, `${id}'s fallback chain loops`); }
    assert.equal(cur, "keyword-card");
  }
});

test("each template has the tool, seconds and fallback the design gives it", () => {
  const t = fancyTemplates();
  const want: Record<string, [string, number, number, string | null]> = {
    "stat-counter": ["remotion", 2, 5, "kinetic-words"],
    "build-list": ["remotion", 3, 6, "kinetic-words"],
    compare: ["remotion", 3, 6, "kinetic-words"],
    "pull-quote": ["remotion", 2, 6, "kinetic-words"],
    steps: ["remotion", 3, 6, "build-list"],
    "kinetic-words": ["hyperframes", 2, 5, "keyword-card"],
    "icon-callout": ["hyperframes", 2, 4, "kinetic-words"],
    "gold-3d-word": ["blender", 2, 5, "kinetic-words"],
    "gold-3d-object": ["blender", 2, 5, "icon-callout"],
    "keyword-card": ["builtin", 0.5, 6, null],
  };
  for (const [id, [tool, minSec, maxSec, fallback]] of Object.entries(want)) {
    assert.deepEqual([t[id].tool, t[id].minSec, t[id].maxSec, t[id].fallback], [tool, minSec, maxSec, fallback], id);
    assert.ok(t[id].description.length > 10, `${id} has a description`);
    assert.equal(basename(t[id].dir), id);
  }
});

test("every template's example params pass its own checks", () => {
  for (const t of Object.values(fancyTemplates())) {
    const r = checkParams(t, t.example);
    assert.deepEqual(r.problems, [], t.id);
  }
});

test("checkParams reports unknown and missing fields", () => {
  const r = checkParams(fancyTemplates()["stat-counter"], { value: "x", colour: 1 });
  assert.ok(r.problems.some((p) => /unknown field "colour"/.test(p)), r.problems.join("\n"));
  assert.ok(r.problems.some((p) => /value/.test(p)), r.problems.join("\n"));
  const missing = checkParams(fancyTemplates()["compare"], { left: "a", right: "b" });
  assert.ok(missing.problems.some((p) => /left_title is required/.test(p)), missing.problems.join("\n"));
  assert.ok(missing.problems.some((p) => /right_title is required/.test(p)), missing.problems.join("\n"));
});

test("checkParams enforces lengths, list counts, the object list and a single emoji", () => {
  const t = fancyTemplates();
  const problems = (id: string, raw: unknown) => checkParams(t[id], raw).problems.join("\n");
  assert.match(problems("pull-quote", { quote: "x".repeat(81) }), /quote must be text of at most 80/);
  assert.equal(problems("pull-quote", { quote: "x".repeat(80) }), "");
  assert.match(problems("stat-counter", { value: 3, label: "y".repeat(41) }), /label must be text of at most 40/);
  assert.match(problems("gold-3d-word", { word: "abcdefghijklmno" }), /word must be text of at most 14/);
  assert.match(problems("build-list", { items: "only one" }), /items must be 2 to 4 items separated by \|/);
  assert.match(problems("build-list", { items: "a|b|c|d|e" }), /items must be 2 to 4/);
  assert.match(problems("build-list", { items: "a| |c" }), /items must be 2 to 4/);
  assert.equal(problems("build-list", { items: "Faster|Cheaper|Simpler" }), "");
  assert.match(problems("steps", { steps: "one" }), /steps must be 2 to 4 items separated by \|/);
  assert.match(problems("kinetic-words", { words: "one two three four five" }), /words must be 1 to 4 words separated by spaces/);
  assert.equal(problems("kinetic-words", { words: "Three times faster" }), "");
  assert.equal(problems("kinetic-words", { words: "  Three  times " }), "");
  assert.match(problems("gold-3d-object", { object: "rocket", label: "x" }), /object must be one of coin, arrow-up/);
  assert.equal(problems("gold-3d-object", { object: "globe", label: "Worldwide" }), "");
  assert.match(problems("icon-callout", { icon: "AB", label: "x" }), /icon must be a single emoji/);
  assert.match(problems("icon-callout", { icon: "🔥🔥", label: "x" }), /icon must be a single emoji/);
  assert.equal(problems("icon-callout", { icon: "⬆️", label: "Up" }), "");
  assert.equal(problems("icon-callout", { icon: "👍🏽", label: "Yes" }), "");
});

test("checkParams fills defaults and returns clean params", () => {
  const r = checkParams(fancyTemplates()["stat-counter"], { value: 3, suffix: "×", label: "faster" });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.params, { value: 3, prefix: "", suffix: "×", label: "faster" });
});

test("fallback params map source params, the key phrase and the object's icon", () => {
  const t = fancyTemplates();
  assert.deepEqual(fallbackParamsFor(t["stat-counter"], { value: 3, label: "faster" }, "Three times faster"), { words: "Three times faster" });
  assert.deepEqual(fallbackParamsFor(t["gold-3d-object"], { object: "globe", label: "Worldwide" }, "global reach"), { icon: "🌍", label: "Worldwide" });
  assert.deepEqual(fallbackParamsFor(t.steps, { steps: "Plan|Film|Post" }, "three steps"), { items: "Plan|Film|Post" });
  assert.deepEqual(fallbackParamsFor(t["kinetic-words"], { words: "Go" }, "go now"), { phrase: "go now" });
  assert.deepEqual(Object.keys(OBJECT_ICONS), ["coin", "arrow-up", "arrow-down", "globe", "clock", "bars", "lightbulb"]);
  assert.deepEqual(Object.values(OBJECT_ICONS), ["🪙", "⬆️", "⬇️", "🌍", "⏰", "📊", "💡"]);
  // Every mapped value passes the fallback's own checks.
  for (const object of Object.keys(OBJECT_ICONS)) {
    assert.deepEqual(checkParams(t["icon-callout"], fallbackParamsFor(t["gold-3d-object"], { object, label: "x" }, "p")).problems, [], object);
  }
});

test("toShot sizes graphics 1080x960 and passes the palette", () => {
  const t = fancyTemplates();
  const shot = toShot(t["stat-counter"], { value: 3, prefix: "", suffix: "×", label: "faster" }, 3, "g1");
  assert.equal(shot.kind, "remotion");
  if (shot.kind !== "remotion") return;
  assert.deepEqual(shot.size, { width: 1080, height: 960 });
  assert.equal(shot.id, "g1");
  assert.equal(shot.duration_sec, 3);
  assert.equal(shot.tsx, readFileSync(join(t["stat-counter"].dir, "Shot.tsx"), "utf8"));
  assert.equal((shot.props.palette as typeof PALETTE).yellow, "#FFD23F");
  assert.equal(shot.props.value, 3);
  assert.ok(shot.assets.some((a) => a.path === fancyFontFile("boldItalic") && a.name === shot.props.fontUrl), "the bold italic TTF, under the name the props give");
  assert.ok(shot.assets.some((a) => a.path === fancyFontFile("italic") && a.name === shot.props.italicFontUrl));
});

test("toShot fills the HyperFrames composition at 1080x960 with the shot's length and params", () => {
  const t = fancyTemplates();
  const shot = toShot(t["kinetic-words"], { words: "Three <times> faster" }, 2.5, "g2");
  assert.equal(shot.kind, "hyperframes");
  if (shot.kind !== "hyperframes") return;
  assert.deepEqual(shot.size, { width: 1080, height: 960 });
  assert.match(shot.html, /data-width="1080"/);
  assert.match(shot.html, /data-height="960"/);
  assert.match(shot.html, /data-duration="2.5"/);
  assert.doesNotMatch(shot.html, /__[A-Z_]+__/, "every placeholder is filled");
  assert.ok(shot.html.includes("Three \\u003ctimes> faster"), "params are injected as script-safe JSON");
  assert.ok(shot.html.includes(PALETTE.yellow));
  assert.deepEqual(shot.assets.map((a) => a.path).sort(), [fancyFontFile("boldItalic"), fancyFontFile("italic")].sort());
  assert.ok(shot.assets.every((a) => shot.html.includes(a.name)), "the page loads each TTF beside it");
});

test("toShot runs the Blender templates' own scripts at 1080x960 with the font and palette", () => {
  const t = fancyTemplates();
  const shot = toShot(t["gold-3d-word"], { word: "Gold" }, 3, "g3");
  assert.equal(shot.kind, "blender");
  if (shot.kind !== "blender") return;
  assert.deepEqual(shot.size, { width: 1080, height: 960 });
  assert.equal(shot.script, join(t["gold-3d-word"].dir, "template.py"));
  assert.equal(shot.engine, "eevee");
  assert.equal(shot.params.word, "Gold");
  assert.equal(shot.params.font, fancyFontFile("boldItalic"));
  assert.equal(shot.params.gold, PALETTE.gold);
  assert.throws(() => toShot(t["keyword-card"], { phrase: "x" }, 2, "g4"), /built in/);
});

test("the keyword card renders an opaque 1080x960 clip", async () => {
  const r = await renderKeywordCard("Three times faster", 2, join(tmp(), "k.mp4"));
  const p = await probe(r.path);
  assert.deepEqual([p.width, p.height], [1080, 960]);
  assert.equal(p.fps, 30);
  assert.ok(Math.abs(p.durationSec - 2) < 0.1, `got ${p.durationSec}`);
  assert.equal(r.durationSec, 2);
  // One frame after the fade, as RGB: the corners are ink and the middle has yellow text.
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "1", "-i", r.path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const px = (x: number, y: number) => [...raw.subarray((y * 1080 + x) * 3, (y * 1080 + x) * 3 + 3)];
  for (const [x, y] of [[5, 5], [1074, 954]]) {
    const [r0, g0, b0] = px(x, y);
    assert.ok(Math.abs(r0 - 0x14) < 8 && Math.abs(g0 - 0x11) < 8 && Math.abs(b0 - 0x0f) < 8, `corner ${x},${y} is ${px(x, y)}`);
  }
  let yellow = 0;
  for (let y = 300; y < 660; y += 2) for (let x = 100; x < 980; x += 2) {
    const [r0, g0, b0] = px(x, y);
    if (r0 > 220 && g0 > 180 && b0 < 110) yellow++;
  }
  assert.ok(yellow > 500, `only ${yellow} yellow pixels`);
});

test("the keyword card copes with long phrases and ASS's special characters", async () => {
  const r = await renderKeywordCard("{Every} single \\ word, again and again and again", 1, join(tmp(), "long k.mp4"));
  const p = await probe(r.path);
  assert.deepEqual([p.width, p.height], [1080, 960]);
});
