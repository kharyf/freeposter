// Turns landscape footage into a 9:16 crop that follows the speaker's face, instead of black bars.
// Faces come from UltraFace (a 1.2 MB ONNX model run locally) on frames sampled twice a second.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config, dataDir } from "../config.ts";
import type { Probe } from "../media.ts";

export const FACE_MODEL_URL = "https://github.com/onnx/models/raw/main/validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx";
export const faceModelPath = () => join(dataDir, "models", "ultraface-rfb-320.onnx");

/** crop's left edge (source px) at source time t (s) */
export interface CropKey {
  t: number;
  x: number;
}

export interface ReframePlan {
  width: number;
  height: number;
  keys: CropKey[];
}

const SAMPLE_FPS = 2;
const IN_W = 320;
const IN_H = 240;
const MIN_SCORE = 0.7;
/** Below this share of sampled frames with a face, keep the letterbox. */
const MIN_FACE_SHARE = 0.3;

export async function ensureFaceModel(path = faceModelPath()): Promise<string> {
  if (existsSync(path)) return path;
  const res = await fetch(FACE_MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`could not download the face model (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(`${path}.part`));
  renameSync(`${path}.part`, path);
  return path;
}

/** Sampled frames as 320x240 RGB, streamed from ffmpeg. */
async function* frames(source: string): AsyncGenerator<Buffer> {
  const ff = spawn(config.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", source,
    "-vf", `fps=${SAMPLE_FPS},scale=${IN_W}:${IN_H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { windowsHide: true });
  const size = IN_W * IN_H * 3;
  let pending = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= size) {
      yield pending.subarray(0, size);
      pending = pending.subarray(size);
    }
  }
}

/** The largest confident face, as fractions (0..1) of the frame, or null. */
interface DetectedFace { cx: number; cy: number; h: number }

function largestFace(scores: Float32Array, boxes: Float32Array): DetectedFace | null {
  let best = 0;
  let face: DetectedFace | null = null;
  for (let i = 0; i < scores.length / 2; i++) {
    if (scores[i * 2 + 1] < MIN_SCORE) continue;
    const [x1, y1, x2, y2] = boxes.subarray(i * 4, i * 4 + 4);
    const area = (x2 - x1) * (y2 - y1);
    if (area > best) {
      best = area;
      face = { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, h: y2 - y1 };
    }
  }
  return face;
}

/** The largest face in each sampled frame (null where none), as fractions of the frame. */
async function detect(source: string, modelPath: string): Promise<(DetectedFace | null)[]> {
  const ort = (await import("onnxruntime-node")).default;
  const session = await ort.InferenceSession.create(await ensureFaceModel(modelPath), { logSeverityLevel: 3 });
  const out: (DetectedFace | null)[] = [];
  const input = new Float32Array(3 * IN_W * IN_H);
  for await (const frame of frames(source)) {
    for (let px = 0; px < IN_W * IN_H; px++) {
      for (let c = 0; c < 3; c++) input[c * IN_W * IN_H + px] = (frame[px * 3 + c] - 127) / 128;
    }
    const res = await session.run({ input: new ort.Tensor("float32", input, [1, 3, IN_H, IN_W]) });
    out.push(largestFace(res.scores.data as Float32Array, res.boxes.data as Float32Array));
  }
  await session.release();
  return out;
}

export async function planReframe(source: string, p: Probe, modelPath = faceModelPath()): Promise<ReframePlan | null> {
  if (p.width / p.height <= (9 / 16) * 1.02) return null;
  const width = Math.round((p.height * 9) / 16 / 2) * 2;
  const maxX = p.width - width;
  const raw = (await detect(source, modelPath)).map((f) =>
    f === null ? null : Math.min(Math.max(f.cx * p.width - width / 2, 0), maxX));
  const found = raw.filter((x) => x !== null).length;
  if (!raw.length || found / raw.length < MIN_FACE_SHARE) return null;

  // Frames without a face hold the nearest known position; small moves are ignored so the crop stays still.
  const first = raw.find((x) => x !== null)!;
  const deadZone = p.width * 0.05;
  const keys: CropKey[] = [];
  let x = first;
  raw.forEach((r, i) => {
    if (r !== null && Math.abs(r - x) > deadZone) x = r;
    keys.push({ t: i / SAMPLE_FPS, x });
  });
  return { width, height: p.height, keys: smoothKeys(keys, p.width * 0.25) };
}

/** The speaker's face over time, in source pixels (`size` is the face box height). */
export interface FaceKey {
  t: number;
  cx: number;
  cy: number;
  size: number;
}

/** A face track for any orientation, or null when a face shows in too few frames. */
export async function planFaceTrack(source: string, p: Probe, modelPath = faceModelPath()): Promise<FaceKey[] | null> {
  const raw = await detect(source, modelPath);
  const found = raw.filter((f) => f !== null).length;
  if (!raw.length || found / raw.length < MIN_FACE_SHARE) return null;

  // Frames without a face hold the last known one (the first known one, at the start).
  let last = raw.find((f) => f !== null)!;
  const held = raw.map((f) => (last = f ?? last));
  const speed = p.width * 0.25;
  const out: FaceKey[] = [];
  held.forEach((f, i) => {
    const key = { t: i / SAMPLE_FPS, cx: f.cx * p.width, cy: f.cy * p.height, size: f.h * p.height };
    const prev = out.at(-1);
    if (!prev) { out.push(key); return; }
    const step = speed * (key.t - prev.t);
    const move = (from: number, to: number) => from + Math.max(-step, Math.min(step, to - from));
    out.push({ ...key, cx: move(prev.cx, key.cx), cy: move(prev.cy, key.cy) });
  });
  return out;
}

/** The largest crop of `aspect` (w/h) in `src`, divided by `zoom`, with the face centre 40% down from its top. */
export function cropAround(
  face: FaceKey | null,
  src: { width: number; height: number },
  aspect: number,
  zoom: number,
): { x: number; y: number; w: number; h: number } {
  const even = (n: number) => Math.round(n / 2) * 2;
  const evenDown = (n: number) => Math.floor(n / 2) * 2;
  const fit = Math.min(src.width, src.height * aspect);
  const w = Math.min(src.width, even(fit / zoom));
  const h = Math.min(src.height, even(fit / aspect / zoom));
  const cx = face?.cx ?? src.width / 2;
  const cy = face ? face.cy + (0.5 - 0.4) * h : src.height / 2;
  const x = Math.min(Math.max(even(cx - w / 2), 0), evenDown(src.width - w));
  const y = Math.min(Math.max(even(cy - h / 2), 0), evenDown(src.height - h));
  return { x, y, w, h };
}

/** Limits how fast the crop may pan (px per second). */
export function smoothKeys(raw: CropKey[], maxSpeedPxPerSec: number): CropKey[] {
  const out: CropKey[] = [];
  for (const k of raw) {
    const prev = out.at(-1);
    if (!prev) { out.push({ ...k }); continue; }
    const step = maxSpeedPxPerSec * (k.t - prev.t);
    out.push({ t: k.t, x: prev.x + Math.max(-step, Math.min(step, k.x - prev.x)) });
  }
  return out;
}

/** Commands for ffmpeg's sendcmd filter that move the crop named "rf". */
export function sendcmdScript(keys: CropKey[]): string {
  return keys.map((k) => `${k.t.toFixed(3)} crop@rf x ${Math.round(k.x)};`).join("\n") + "\n";
}
