// The files a review is about: the master (the exact file every platform will upload, made once and never
// re-encoded) and a viewing copy small enough for a Telegram bot to send.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { config } from "../config.ts";
import { render } from "../media.ts";
import { runTool } from "../produce/proc.ts";

/** Telegram's cloud Bot API takes uploads of up to 50 MB; leave room for the multipart wrapping. */
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const VIEW_COPY_LIMIT = 45 * 1024 * 1024;

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** The platform render of a review's video: what the runner uploads, byte for byte. */
export async function makeMaster(source: string, key: string, dir: string): Promise<{ path: string; sha256: string; size: number; durationSec: number }> {
  const out = await render(source, `master-${key}`, dir);
  return { path: out.path, sha256: await hashFile(out.path), size: out.size, durationSec: out.probe.durationSec };
}

/**
 * What the reviewer watches on the phone: the master itself when it fits Telegram, else a 720x1280 copy sized to fit.
 * It's for looking at; what posts is decided by the master's hash.
 */
export async function makeViewCopy(master: string, durationSec: number, out: string, limit = VIEW_COPY_LIMIT): Promise<string> {
  if (statSync(master).size <= limit) return master;
  if (existsSync(out) && statSync(out).size <= limit) return out;
  const part = `${out}.part.mp4`;
  // Bits per second that fit the limit, with room for the audio and the container.
  let videoKbps = Math.min(4000, Math.floor(((limit * 8) / Math.max(durationSec, 1) / 1000) * 0.85) - 96);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { code, tail } = await runTool(config.ffmpeg, [
        "-y", "-hide_banner", "-loglevel", "error", "-i", master, "-vf", "scale=720:1280",
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${Math.max(videoKbps, 200)}k`, "-maxrate", `${Math.max(videoKbps, 200)}k`, "-bufsize", `${Math.max(videoKbps, 200) * 2}k`,
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", part,
      ], { signal: new AbortController().signal, timeoutMs: 30 * 60_000 });
      if (code !== 0) throw new Error(`the viewing copy failed: ${tail}`);
      if (statSync(part).size <= limit) {
        renameSync(part, out);
        return out;
      }
      videoKbps = Math.floor(videoKbps * 0.7);
    }
    throw new Error("the viewing copy doesn't fit Telegram's upload limit");
  } finally {
    try { unlinkSync(part); } catch {}
  }
}
