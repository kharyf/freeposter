import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseWhisperJson, transcribe, whisperModelPath } from "../src/edit/transcribe.ts";

const fixtures = join(import.meta.dirname, "fixtures");
// The real model lives in the checkout's data/models (tests use an isolated home, so point at it directly).
const realModel = join(import.meta.dirname, "..", "data", "models", "ggml-base.bin");

test("parseWhisperJson reads the fixture into ordered words", () => {
  const { words } = parseWhisperJson(readFileSync(join(fixtures, "whisper-sample.json"), "utf8"));
  assert.ok(words.length > 5);
  for (let i = 0; i < words.length; i++) {
    assert.ok(words[i].start < words[i].end, `word ${i} ${JSON.stringify(words[i])}`);
    assert.equal(words[i].text, words[i].text.trim());
    assert.ok(words[i].text.length > 0);
    if (i) assert.ok(words[i].start >= words[i - 1].start);
  }
  assert.equal(words[0].text, "Um,");
  assert.equal(words[0].start, 0.12);
});

test("parseWhisperJson ignores blank and malformed lines", () => {
  const { words } = parseWhisperJson('{"start":0,"end":100,"text":" hi"}\n\nnot json\n{"start":100,"end":100,"text":" "}\n');
  assert.deepEqual(words, [{ text: "hi", start: 0, end: 0.1 }]);
});

test("transcribe finds the spoken words", { skip: !existsSync(realModel) && "whisper model not downloaded" }, async () => {
  const { words } = await transcribe(join(fixtures, "speech.ogg"), realModel);
  const text = words.map((w) => w.text.toLowerCase()).join(" ");
  assert.match(text, /gatekeeping/);
  assert.ok(whisperModelPath().endsWith("ggml-base.bin"));
});
