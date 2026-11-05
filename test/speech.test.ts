import assert from "node:assert/strict";
import { test } from "node:test";
import { dropSoundTags, phrases, spokenWords } from "../src/edit/speech.ts";
import type { Word } from "../src/edit/transcribe.ts";

/** One word per token, a little apart, the way whisper's max_len=1 output comes. */
const toks = (text: string, start = 0, step = 0.3): Word[] =>
  text.split(" ").map((t, i) => ({ text: t, start: start + i * step, end: start + i * step + 0.25 }));
const said = (ws: Word[]) => ws.map((w) => w.text).join(" ");

test("a music-only video has no speech", () => {
  // What whisper wrote for a real video with only music in it.
  const heard = [
    { text: "(upbeat", start: 0, end: 1.4 }, { text: "music)", start: 1.4, end: 3 },
    { text: "(gentle", start: 3, end: 4.4 }, { text: "music)", start: 4.4, end: 6 },
    { text: "(upbeat", start: 6, end: 7.4 }, { text: "music)", start: 7.4, end: 9 },
  ];
  assert.deepEqual(dropSoundTags(heard), []);
});

test("sound tags go, the talking around them stays", () => {
  assert.equal(said(dropSoundTags(toks("So [Applause] here's the *laughs* app (music playing) I made"))), "So here's the app I made");
  assert.equal(said(dropSoundTags(toks("[MUSIC]"))), "");
  assert.equal(said(dropSoundTags(toks("look(laughs) here"))), "look here");
});

test("lines marked as sung go", () => {
  assert.equal(said(dropSoundTags(toks("♪ never gonna stop ♪ okay so this is it"))), "okay so this is it");
  assert.equal(said(dropSoundTags(toks("♪never gonna stop♪ okay"))), "okay");
  // Only the opening note: the line ends at the next real pause.
  const heard = [...toks("♪ la la la"), ...toks("hey everyone", 3)];
  assert.equal(said(dropSoundTags(heard)), "hey everyone");
});

test("a bracket that never closes was just a bracket", () => {
  assert.equal(said(dropSoundTags(toks("I said (well not really and then we went home after that"))), "I said well not really and then we went home after that");
  assert.equal(said(dropSoundTags(toks("this one (no close"))), "this one no close");
});

test("unmarked lyrics go when the check names them", async () => {
  const heard = [...toks("baby baby baby oh"), ...toks("so today I'm showing you my app", 3)];
  assert.deepEqual(phrases(heard).map(said), ["baby baby baby oh", "so today I'm showing you my app"]);
  let asked: string[] = [];
  const out = await spokenWords(heard, async (lines) => { asked = lines; return [0]; });
  assert.deepEqual(asked, ["baby baby baby oh", "so today I'm showing you my app"]);
  assert.equal(said(out.words), "so today I'm showing you my app");
  assert.equal(out.lyricsChecked, true);
});

test("if the lyrics check can't run, the talking still gets through", async () => {
  const out = await spokenWords(toks("(music) hello there"), async () => { throw new Error("Claude Code isn't installed"); });
  assert.equal(said(out.words), "hello there");
  assert.equal(out.lyricsChecked, false);
});

test("nothing said, nothing asked", async () => {
  let called = false;
  const out = await spokenWords(toks("(upbeat music)"), async () => { called = true; return []; });
  assert.deepEqual(out.words, []);
  assert.equal(called, false);
});
