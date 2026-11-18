import "./isolated-home.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AiService } from "../src/ai/router.ts";
import type { Question } from "../src/ai/providers.ts";
import { config } from "../src/config.ts";
import type { LibraryEntry } from "../src/campaigns/store.ts";
import { buildGeneratedProduction, checkScript, writeScript, type Script } from "../src/campaigns/script.ts";
import type { Adapters } from "../src/produce/adapters/index.ts";
import { ProductionWorker } from "../src/produce/worker.ts";
import { newStore, tmp } from "./helpers.ts";

const entry = (kind: LibraryEntry["kind"], text: string, url: string | null = null): LibraryEntry => ({ id: 1, kind, name: kind, text, keywords: [], url, createdAt: 0 });
const choice = {
  hook: entry("hook", "Stop scrolling!"),
  angle: entry("angle", "Your week is a mess and you never plan it."),
  cta: entry("cta", "Try it free today", "https://example.com/plan"),
};
const good = (): Script => ({
  lines: ["Stop scrolling, this plans your week.", "One tap and it is done.", "Try it free today at example.com/plan"],
  shots: [{ prompt: "a calendar filling in", sec: 4 }, { prompt: "a happy person", sec: 5 }],
  caption: "Plan your week https://example.com/plan",
  title: "Plan your week",
  musicPrompt: "upbeat lo-fi",
});
const fakeAi = (answers: Script[]) => {
  const asked: Question[] = [];
  const ai = { ask: async (job: string, q: Question) => { assert.equal(job, "script"); asked.push(q); return answers[asked.length - 1]; } } as unknown as AiService;
  return { ai, asked };
};

test("checkScript accepts a good script and normalizes the hook and CTA", () => {
  assert.deepEqual(checkScript(good(), choice), []);
});

test("a hook that is not first, an extra URL, a missing caption URL, bad seconds and '#' lines are problems", () => {
  const s = good();
  s.lines = ["Welcome.", "Stop scrolling, this plans your week.", "# note", "Visit other.org or http://evil.com now. Try it free today"];
  s.caption = "no link";
  s.shots = [{ prompt: "x", sec: 2 }];
  const p = checkScript(s, choice).join("\n");
  assert.match(p, /first line must start with the hook/);
  assert.match(p, /other\.org/);
  assert.match(p, /evil\.com/);
  assert.match(p, /caption must contain/);
  assert.match(p, /seconds/);
  assert.match(p, /"#"/);
});

test("the CTA's own URL is allowed in any spelling; the CTA text must be in the last line", () => {
  const s = good();
  s.lines[2] = "Go to HTTP://Example.com/plan/ now";
  assert.match(checkScript(s, choice).join("\n"), /last line must contain/);
  s.lines[2] = "Try it free today, at http://example.com/plan/";
  assert.deepEqual(checkScript(s, choice), []);
});

test("writeScript asks once when the script is good, with the definitions in the system prompt", async () => {
  const { ai, asked } = fakeAi([good()]);
  assert.deepEqual(await writeScript({ ai }, choice), good());
  assert.equal(asked.length, 1);
  assert.match(asked[0].system, /a phrase that the video opens with in the first 2-3 seconds/);
  assert.match(asked[0].system, /the description of the problem the video is claiming to solve/);
  assert.match(asked[0].system, /an explicit, direct call to click a link or go to a web page that comes at the very end of the video/);
});

test("writeScript retries once with the problems listed, then succeeds", async () => {
  const bad = good(); bad.lines[0] = "Hello there.";
  const { ai, asked } = fakeAi([bad, good()]);
  assert.deepEqual(await writeScript({ ai }, choice), good());
  assert.equal(asked.length, 2);
  assert.match(asked[1].prompt, /first line must start with the hook/);
});

test("two bad scripts fail, naming the problems, after exactly two asks", async () => {
  const bad = good(); bad.caption = "nothing";
  const { ai, asked } = fakeAi([bad, bad]);
  await assert.rejects(writeScript({ ai }, choice), (e: Error) => /caption must contain/.test(e.message));
  assert.equal(asked.length, 2);
});

test("buildGeneratedProduction: one wan shot per script shot, presenter on the first, stageable without parseSpec", async () => {
  const dir = tmp();
  const vo = join(dir, "vo.wav"), music = join(dir, "m.wav");
  writeFileSync(vo, "a"); writeFileSync(music, "b");
  const saved = config.produce.wangpPresenterModel;
  config.produce.wangpPresenterModel = "infinitetalk";
  try {
    const spec = buildGeneratedProduction(good(), { voiceover: vo, music }, true);
    assert.equal(spec.title, "Plan your week");
    assert.equal(spec.shots.length, 2);
    const [a, b] = spec.shots as any[];
    assert.deepEqual([a.kind, a.duration_sec, a.prompt, a.negative_prompt, a.image, a.model, a.audio_guide], ["wan", 4, "a calendar filling in", "", null, "infinitetalk", vo]);
    assert.equal(b.model, undefined);
    assert.equal(b.audio_guide, undefined);
    assert.notEqual(a.seed, b.seed);
    assert.equal(buildGeneratedProduction(good(), { voiceover: vo, music }, true).shots[0].kind === "wan" && (buildGeneratedProduction(good(), { voiceover: vo, music }, true).shots[0] as any).seed, a.seed);
    assert.deepEqual(spec.audio, { voiceover: vo, music });
    assert.deepEqual(spec.captions, { source: "voiceover" });
    assert.equal(spec.post, null);
    assert.deepEqual(spec.sfx, []);
    assert.deepEqual(spec.transitions, { default: { type: "cut", sec: 0 } });
    assert.equal((buildGeneratedProduction(good(), { voiceover: vo, music }, false).shots[0] as any).model, undefined);

    const w = new ProductionWorker(newStore(), { adapters: { wan: { kind: "wan", lane: "gpu", version: 1 } } as unknown as Adapters, dir: tmp() });
    const staged = await w.stage(spec);
    assert.equal(staged.plan.length, 2);
    assert.match((staged.spec.shots[0] as any).audio_guide, /inputs/);
    assert.match(staged.spec.audio.music!, /inputs/);
  } finally { config.produce.wangpPresenterModel = saved; }
});

test("no presenter model configured: presenter=true still leaves the shot a plain video shot", () => {
  const saved = config.produce.wangpPresenterModel;
  config.produce.wangpPresenterModel = "";
  try {
    const s = buildGeneratedProduction(good(), { voiceover: "v.wav", music: "m.wav" }, true).shots[0] as any;
    assert.equal(s.model, undefined);
    assert.equal(s.audio_guide, undefined);
  } finally { config.produce.wangpPresenterModel = saved; }
});
