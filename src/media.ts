import { execFile } from "node:child_process";
import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";

const run = promisify(execFile);

export interface Probe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  hasAudio: boolean;
  audioCodec: string | null;
  audioRate: number | null;
  pixFmt: string;
  faststart: boolean;
}

export async function probe(path: string): Promise<Probe> {
  let out: string;
  try {
    ({ stdout: out } = await run(config.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (err) {
    throw new Error(`not a readable video file (${(err as any).stderr?.trim() || (err as Error).message})`);
  }
  const info = JSON.parse(out);
  const video = info.streams.find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) throw new Error("the file has no video stream");
  const audio = info.streams.find((s: any) => s.codec_type === "audio");
  const [num, den] = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number);
  // Rotation metadata (phone portrait clips) swaps the displayed width/height.
  const rotation = Math.abs(Number(video.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0));
  const swap = rotation === 90 || rotation === 270;
  return {
    durationSec: Number(info.format.duration ?? video.duration ?? 0),
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    fps: den ? num / den : 0,
    videoCodec: video.codec_name,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    audioRate: audio ? Number(audio.sample_rate) : null,
    pixFmt: video.pix_fmt,
    faststart: await moovAtStart(path),
  };
}

/** True when the MP4 index (moov) precedes the media data, which streaming uploads expect. */
async function moovAtStart(path: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    let off = 0;
    while (off + 8 <= bytesRead) {
      const size = buf.readUInt32BE(off);
      const type = buf.toString("latin1", off + 4, off + 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (size < 8) return false;
      off += size;
    }
    return false;
  } finally {
    await fh.close();
  }
}

/** The single render every platform accepts: 1080x1920, H.264 High, 30 fps, AAC 48 kHz stereo, faststart. */
export const TARGET = { width: 1080, height: 1920, fps: 30, maxBitrate: "10M" } as const;

export function ffmpegArgs(input: string, output: string, hasAudio: boolean): string[] {
  const vf = [
    `scale=${TARGET.width}:${TARGET.height}:force_original_aspect_ratio=decrease`,
    `pad=${TARGET.width}:${TARGET.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `fps=${TARGET.fps}`,
    "format=yuv420p",
  ].join(",");
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input,
    // Silent clips get a silent track: some platforms reject or mishandle video-only files.
    ...(hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
    "-map", "0:v:0", "-map", hasAudio ? "0:a:0" : "1:a:0",
    "-vf", vf,
    "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1", "-preset", "medium", "-crf", "20",
    "-maxrate", TARGET.maxBitrate, "-bufsize", "20M", "-g", String(TARGET.fps * 2), "-keyint_min", String(TARGET.fps),
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    ...(hasAudio ? [] : ["-shortest"]),
    "-movflags", "+faststart",
    output,
  ];
}

/** Checks a render against the spec every platform publisher assumes. Returns the problems found. */
export function specProblems(p: Probe): string[] {
  const problems: string[] = [];
  if (p.width !== TARGET.width || p.height !== TARGET.height) problems.push(`size ${p.width}x${p.height}, expected 1080x1920`);
  if (p.videoCodec !== "h264") problems.push(`video codec ${p.videoCodec}, expected h264`);
  if (Math.abs(p.fps - TARGET.fps) > 0.01) problems.push(`frame rate ${p.fps}, expected 30`);
  if (p.pixFmt !== "yuv420p") problems.push(`pixel format ${p.pixFmt}, expected yuv420p`);
  if (p.audioCodec !== "aac" || p.audioRate !== 48000) problems.push(`audio ${p.audioCodec}@${p.audioRate}, expected aac@48000`);
  if (!p.faststart) problems.push("moov atom not at start (faststart missing)");
  return problems;
}

const renders = new Map<string, Promise<{ path: string; size: number; probe: Probe }>>();

/** Renders once per source (keyed by its hash, or an edit's key) no matter how many platform jobs ask. */
export function render(source: string, key: string, dir: string) {
  let pending = renders.get(key);
  if (!pending) {
    pending = doRender(source, join(dir, `${key}.mp4`));
    renders.set(key, pending);
    pending.catch(() => renders.delete(key));
  }
  return pending;
}

async function doRender(source: string, output: string) {
  if (!existsSync(output)) {
    const src = await probe(source);
    const tmp = `${output}.part.mp4`;
    try {
      await run(config.ffmpeg, ffmpegArgs(source, tmp, src.hasAudio), { maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      throw new Error(`ffmpeg failed: ${(err as any).stderr?.trim() || (err as Error).message}`);
    }
    renameSync(tmp, output);
  }
  const result = await probe(output);
  const problems = specProblems(result);
  if (problems.length) throw new Error(`render does not meet spec: ${problems.join("; ")}`);
  return { path: output, size: statSync(output).size, probe: result };
}
