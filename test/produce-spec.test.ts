import "./isolated-home.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseSpec, shotsChanged, SpecError, toWindowsPath, type SpecContext } from "../src/produce/spec.ts";
import { tmp } from "./helpers.ts";

const dir = tmp();
const clip = join(dir, "take3.mp4");
writeFileSync(clip, "x");
const html = (sec: number) => `<html><body><div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="${sec}"></div></body></html>`;

const ctx: SpecContext = {
  templates: { "logo-spin": { description: "spinning logo", params: { text: { type: "string", required: true, maxLength: 40 }, color: { type: "color", default: "#ffffff" } } } },
  sfx: ["whoosh", "hits/boom"],
};

const good = () => ({
  version: 1,
  title: "Launch teaser",
  shots: [
    { id: "intro", kind: "hyperframes", duration_sec: 3, html: html(3) },
    { id: "hero", kind: "wan", duration_sec: 5, prompt: "slow dolly toward a phone", negative_prompt: "text", seed: 42 },
    { id: "logo", kind: "blender", duration_sec: 2.5, template: "logo-spin", params: { text: "FreePoster", color: "#ff5a36" } },
    { id: "talk", kind: "edit", path: clip, settings: { tighten: true, captions: false } },
    { id: "b-roll", kind: "file", path: clip, trim: [1, 3] },
  ],
  transitions: { default: "cut", "intro->hero": { type: "crossfade", sec: 0.3 } },
  audio: { voiceover: clip },
  sfx: [{ name: "whoosh", at_sec: 2.9, gain_db: -6 }],
  captions: { source: "voiceover" },
  post: { account_ids: [1, 4], caption: "hi" },
});

test("the spec's own example parses", () => {
  const spec = parseSpec(good(), ctx);
  assert.equal(spec.shots.length, 5);
  assert.equal(spec.shots[2].kind === "blender" && spec.shots[2].params.color, "#ff5a36");
  assert.deepEqual(spec.transitions["intro->hero"], { type: "crossfade", sec: 0.3 });
  assert.equal(spec.transitions.default.type, "cut");
  assert.equal(spec.captions.source, "voiceover");
});

test("template params get their defaults", () => {
  const raw = good();
  raw.shots[2] = { id: "logo", kind: "blender", duration_sec: 2, template: "logo-spin", params: { text: "Hi" } } as any;
  const spec = parseSpec(raw, ctx);
  assert.deepEqual(spec.shots[2].kind === "blender" && spec.shots[2].params, { text: "Hi", color: "#ffffff" });
});

test("every problem is reported at once", () => {
  const raw: any = good();
  raw.shots.push({ id: "intro", kind: "wan", duration_sec: 0.3, prompt: "x" }); // duplicate id, too short
  raw.shots.push({ id: "card", kind: "hyperframes", duration_sec: 2 }); // no html
  raw.shots.push({ id: "spin", kind: "blender", duration_sec: 2, template: "nope", params: {} }); // unknown template
  raw.shots.push({ id: "spin2", kind: "blender", duration_sec: 2, template: "logo-spin", params: { color: "red" } }); // missing text, bad color
  raw.shots.push({ id: "rel", kind: "file", path: "clips/a.mp4" }); // relative path
  raw.sfx.push({ name: "laser", at_sec: 1 });
  raw.surprise = true;
  try {
    parseSpec(raw, ctx);
    assert.fail("should refuse");
  } catch (err) {
    assert.ok(err instanceof SpecError);
    const all = err.problems.join("\n");
    for (const needle of [/duplicate shot id "intro"/, /0\.5 to 20/, /card: html is required/, /unknown template "nope"/, /text is required/, /color must be a color like #ff5a36/, /absolute path/, /unknown sound effect "laser"/, /unknown field "surprise"/]) {
      assert.match(all, needle);
    }
  }
});

test("shot count, html size and composition attributes are checked", () => {
  const many: any = good();
  many.shots = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, kind: "file", path: clip }));
  assert.throws(() => parseSpec(many, ctx), /1 to 20 shots/);
  const bad: any = good();
  bad.shots[0].html = "<html><body>no root</body></html>";
  assert.throws(() => parseSpec(bad, ctx), /data-composition-id/);
  bad.shots[0].html = html(3).replace('data-height="1920"', 'data-height="1080"');
  assert.throws(() => parseSpec(bad, ctx), /data-height="1920"/);
  bad.shots[0].html = html(3) + " ".repeat(256 * 1024);
  assert.throws(() => parseSpec(bad, ctx), /256 KB/);
});

test("WSL paths become Windows paths", () => {
  assert.equal(toWindowsPath("/mnt/c/clips/a b.mp4"), "C:\\clips\\a b.mp4");
  assert.equal(toWindowsPath("C:\\clips\\a.mp4"), "C:\\clips\\a.mp4");
});

test("shotsChanged names new and changed shots only", () => {
  const a = parseSpec(good(), ctx);
  const raw: any = good();
  raw.shots[1].prompt = "a different prompt";
  raw.shots.push({ id: "outro", kind: "file", path: clip });
  assert.deepEqual(shotsChanged(a, parseSpec(raw, ctx)), ["hero", "outro"]);
});

test("a parsed spec parses again unchanged (revise re-reads stored specs)", () => {
  const once = parseSpec(good(), ctx);
  assert.deepEqual(parseSpec(JSON.parse(JSON.stringify(once)), ctx), once);
});
