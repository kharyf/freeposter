// Keeps only words a person in the video says. Whisper also writes down what it hears that nobody said:
// sound tags like "(upbeat music)" or "[Applause]", and the lyrics of any song playing. Those must never
// become captions, and they must not decide what the cut keeps either.
import { askAi } from "../ai/router.ts";
import type { Word } from "./transcribe.ts";

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "*": "*" };
const NOTES = /[♪♫♬🎵🎶]/u;
/** A sound tag is a few words at most; an opening bracket left unclosed this long was just a bracket. */
const MAX_TAG_WORDS = 6;
/** Whisper marks each sung line, sometimes only at its start; a pause this long ends the line. */
const LINE_GAP = 1.0;

const hasText = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** Drops Whisper's sound tags, and sung lines it marked with ♪. */
export function dropSoundTags(words: Word[]): Word[] {
  const out: Word[] = [];
  let close: string | null = null; // the bracket that ends the tag we're in
  let pending: { w: Word; text: string }[] = []; // what's inside an open tag, kept if it never closes
  let singing = false;
  let prevEnd = -Infinity;

  const keep = (w: Word, text: string) => {
    text = text.trim();
    if (!hasText(text)) return;
    // The word that opened an unclosed bracket already kept its text before the bracket: add to it.
    const same = out.find((o) => o.start === w.start && o.end === w.end);
    if (same) same.text = `${same.text} ${text}`;
    else out.push({ ...w, text });
  };

  for (const w of words) {
    if (singing && w.start - prevEnd > LINE_GAP) singing = false;
    prevEnd = w.end;
    let text = ""; // outside any tag
    let inside = ""; // inside a tag still open at the end of this word
    for (const ch of w.text) {
      if (NOTES.test(ch)) { singing = !singing; continue; }
      if (singing) continue;
      if (close) {
        if (ch === close) { close = null; pending = []; inside = ""; } else inside += ch;
        continue;
      }
      if (ch in OPEN) { close = OPEN[ch]; continue; }
      text += ch;
    }
    // Text outside the tag is speech; what's inside waits to see whether the tag closes.
    keep(w, text);
    if (!close) continue;
    pending.push({ w, text: inside });
    if (pending.length > MAX_TAG_WORDS) {
      close = null;
      for (const p of pending) keep(p.w, p.text);
      pending = [];
    }
  }
  // A bracket still open at the end never closed: it wasn't a tag.
  for (const p of pending) keep(p.w, p.text);
  return out.sort((a, b) => a.start - b.start);
}

/** Runs of words with no long pause inside: the lines a classifier judges as a whole. */
export function phrases(words: Word[], gap = 0.6): Word[][] {
  const out: Word[][] = [];
  for (const w of words) {
    const cur = out.at(-1);
    if (cur && w.start - cur.at(-1)!.end <= gap) cur.push(w);
    else out.push([w]);
  }
  return out;
}

/** Given the transcript's lines, the indices of the ones that are song lyrics rather than someone talking. */
export type FindLyrics = (lines: string[]) => Promise<number[]>;

export const findLyricsWithAi: FindLyrics = async (lines) => {
  const { lyrics } = await askAi<{ lyrics: number[] }>("lyrics", {
    system:
      "You read a speech-to-text transcript of a short video, one numbered line per phrase. The audio may contain " +
      "a person talking, music with sung lyrics, or both. Name the lines that are lyrics of a song (sung or rapped " +
      "music playing in the video) rather than words a person in the video is saying. Lyrics tend to rhyme, repeat, " +
      "or be recognizable songs; talking explains, addresses the viewer, or reacts. If a line could be either, it " +
      "is talking: leave it out.",
    prompt: lines.map((l, i) => `${i}: ${l}`).join("\n"),
    schema: {
      type: "object",
      properties: { lyrics: { type: "array", items: { type: "integer" } } },
      required: ["lyrics"],
      additionalProperties: false,
    },
  });
  return lyrics;
};

/**
 * The words people in the video speak: sound tags and ♪-marked lines always go; unmarked lyrics go when
 * `findLyrics` can tell. If it can't (no AI provider, no answer), the words it couldn't judge stay.
 */
export async function spokenWords(
  words: Word[],
  findLyrics: FindLyrics = findLyricsWithAi,
): Promise<{ words: Word[]; lyricsChecked: boolean }> {
  const said = dropSoundTags(words);
  if (!said.length) return { words: said, lyricsChecked: true };
  const lines = phrases(said);
  let lyrics: number[];
  try {
    lyrics = await findLyrics(lines.map((l) => l.map((w) => w.text).join(" ")));
  } catch (err) {
    console.error(`lyrics check skipped: ${(err as Error).message}`);
    return { words: said, lyricsChecked: false };
  }
  const drop = new Set(lyrics);
  return { words: lines.filter((_, i) => !drop.has(i)).flat(), lyricsChecked: true };
}
