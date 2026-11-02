// Local speech-to-text: ffmpeg's built-in whisper filter (whisper.cpp). With max_len=1 it writes one JSON
// line per word, {"start": ms, "end": ms, "text": " word"}, which is the word timing cutting and captions need.
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { config, dataDir } from "../config.ts";
import { randomToken } from "../crypto.ts";

const run = promisify(execFile);

export const WHISPER_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

/** seconds on the source timeline */
export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Transcript {
  words: Word[];
  language: string | null;
}

export const whisperModelPath = () => config.whisperModel;

/**
 * A path as an ffmpeg filter option value. ffmpeg unescapes twice (the filter graph, then the option), so
 * colons get one backslash inside graph quotes, and a quote becomes \' for the option level, written as
 * close-quote, escaped quote, reopen at the graph level.
 */
export function filterPath(path: string): string {
  return `'${path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'\\''")}'`;
}

export function parseWhisperJson(raw: string): Transcript {
  const words: Word[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let seg: { start?: unknown; end?: unknown; text?: unknown };
    try { seg = JSON.parse(line); } catch { continue; }
    const text = String(seg.text ?? "").trim();
    let start = Number(seg.start) / 1000;
    const end = Number(seg.end) / 1000;
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    // whisper.cpp's word edges can overlap by a few ms; keep the timeline ordered.
    const prev = words.at(-1);
    if (prev && start < prev.end) start = prev.end;
    if (end <= start) continue;
    words.push({ text, start, end });
  }
  return { words, language: null };
}

/** Downloads the whisper model on first use. */
export async function ensureWhisperModel(onProgress?: (fraction: number) => void): Promise<string> {
  const path = whisperModelPath();
  if (existsSync(path)) return path;
  const res = await fetch(WHISPER_MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`could not download the speech model (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (chunk: Buffer) => { got += chunk.length; if (total) onProgress?.(got / total); });
  const part = `${path}.part`;
  await pipeline(body, createWriteStream(part));
  renameSync(part, path);
  return path;
}

async function hasAudio(source: string): Promise<boolean> {
  const { stdout } = await run(config.ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", source], { windowsHide: true })
    .catch((err) => { throw new Error(`transcription failed: not a readable media file (${(err as any).stderr?.trim() || (err as Error).message})`); });
  return stdout.trim().length > 0;
}

export async function transcribe(source: string, model = whisperModelPath()): Promise<Transcript> {
  // Screen recordings and B-roll have no sound at all: nothing to hear, not a failure.
  if (!(await hasAudio(source))) return { words: [], language: null };
  if (!existsSync(model)) await ensureWhisperModel();
  const out = join(dataDir, "edits", `whisper-${randomToken(8)}.json`);
  const af = `aresample=16000,whisper=model=${filterPath(model)}:language=auto:format=json:max_len=1:use_gpu=true:destination=${filterPath(out)}`;
  try {
    await run(config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-af", af, "-f", "null", "-"], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return parseWhisperJson(existsSync(out) ? readFileSync(out, "utf8") : "");
  } catch (err) {
    throw new Error(`transcription failed: ${(err as any).stderr?.trim() || (err as Error).message}`);
  } finally {
    try { unlinkSync(out); } catch {}
  }
}
