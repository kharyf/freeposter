// WanGP, headless: one settings file per shot, run with `wgp.py --process`. Each run loads the model, renders and
// exits, which frees the GPU for the next job. The settings start from the user's own tuned file for the model
// (WanGP's settings/<model>_settings.json), so their steps, attention and quality choices carry over.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config.ts";
import { probe } from "../../media.ts";
import { runTool } from "../proc.ts";
import type { WanShot } from "../spec.ts";
import { wangpArchitecture, wangpDir, wangpModel, wangpPython } from "../tools.ts";
import { Fatal, Retryable } from "./errors.ts";
import type { RenderContext, ShotAdapter } from "./index.ts";

/** Frames for a shot: enough at up to 25 fps, rounded up to the 8k+1 counts WanGP's video models take. */
export const wanFrames = (sec: number) => Math.ceil((sec * 25) / 8) * 8 + 1;

const OOM = /out of memory|OutOfMemoryError|CUDA error: out of memory/i;

export interface WanOptions {
  dir?: () => string;
  model?: () => string;
  /** how to run WanGP with these arguments (default: its venv Python + wgp.py) */
  command?: (args: string[]) => { bin: string; args: string[] };
}

/** How WanGP runs by default: its own venv Python and wgp.py. */
export const wanCommand = (dir: () => string) => (args: string[]) => ({ bin: wangpPython(dir()), args: [join(dir(), "wgp.py"), ...args] });

/** The user's own tuned settings for a model (WanGP's settings/<model>_settings.json), else {}. */
export function ownSettings(dir: string, model: string): Record<string, unknown> {
  const own = join(dir, "settings", `${model}_settings.json`);
  if (existsSync(own)) try { return JSON.parse(readFileSync(own, "utf8")); } catch {}
  return {};
}

export interface WanGPRun {
  dir: string;
  command: (args: string[]) => { bin: string; args: string[] };
  settings: Record<string, unknown>;
  /** where the settings file goes and WanGP writes its output */
  workDir: string;
  settingsName: string;
  /** what the error messages name: a shot id, "speech", "music" */
  label: string;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * One headless WanGP job: the settings file is written, checked with --dry-run (WanGP validates it the way its UI
 * would), then rendered into workDir. Out of memory is Retryable; refused settings and failed runs are Fatal.
 * Returns the run's last lines.
 */
export async function runWanGP(job: WanGPRun): Promise<string> {
  const file = join(job.workDir, job.settingsName);
  writeFileSync(file, JSON.stringify(job.settings, null, 2));
  const run = (args: string[], timeoutMs?: number) => {
    const cmd = job.command(args);
    return runTool(cmd.bin, cmd.args, {
      cwd: job.dir || undefined, signal: job.signal, timeoutMs,
      onLine: (line) => {
        const step = /\[(\d+)\/(\d+)\]/.exec(line);
        if (step) job.onProgress?.(Math.min(Number(step[1]) / Number(step[2]), 0.99));
      },
    });
  };
  const check = await run(["--process", file, "--dry-run"], 10 * 60_000);
  if (check.code !== 0) {
    if (OOM.test(check.tail)) throw new Retryable(`${job.label}: WanGP ran out of GPU memory:\n${check.tail}`);
    throw new Fatal(`${job.label}: WanGP refused the settings:\n${check.tail}`);
  }
  const { code, tail } = await run(["--process", file, "--output-dir", job.workDir], config.produce.wangpTimeoutMin * 60_000);
  if (code !== 0) {
    if (OOM.test(tail)) throw new Retryable(`${job.label}: WanGP ran out of GPU memory:\n${tail}`);
    throw new Fatal(`${job.label}: WanGP failed:\n${tail}`);
  }
  return tail;
}

/** The newest file in dir whose name matches, or null. */
export function newestFile(dir: string, name: RegExp): string | null {
  const files = readdirSync(dir).filter((f) => name.test(f)).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

export function wanAdapter(opts: WanOptions = {}): ShotAdapter<WanShot> {
  const dir = opts.dir ?? wangpDir;
  const model = opts.model ?? wangpModel;
  const command = opts.command ?? wanCommand(dir);
  return {
    kind: "wan",
    lane: "gpu",
    version: 1,
    async health() {
      const d = dir();
      if (!d || !existsSync(join(d, "wgp.py"))) return { ok: false, detail: "WanGP not found; set its folder in Setup" };
      if (!model()) return { ok: false, detail: "no WanGP model chosen; set WANGP_MODEL or use one in WanGP first" };
      return { ok: true, detail: `WanGP at ${d}, model ${model()}` };
    },
    async render(shot: WanShot, ctx: RenderContext) {
      const d = dir();
      const m = shot.model || model();
      if (!m) throw new Fatal(`${shot.id}: no WanGP model chosen; set WANGP_MODEL in Setup`);
      const settings: Record<string, unknown> = {
        ...ownSettings(d, m),
        model_type: m,
        prompt: shot.prompt,
        negative_prompt: shot.negative_prompt,
        seed: shot.seed,
        resolution: "704x1280",
        video_length: wanFrames(shot.duration_sec),
        batch_size: 1,
        repeat_generation: 1,
        image_prompt_type: shot.image ? "S" : "",
        image_start: shot.image ? [shot.image] : null,
        output_filename: "shot",
      };
      if (shot.audio_guide) {
        // A presenter shot: the voiceover drives the face (wgp.py needs audio_guide whenever audio_prompt_type has "A").
        settings.audio_guide = shot.audio_guide;
        settings.audio_prompt_type = "A";
        // InfiniteTalk takes the face as a reference image, not a start image: its deepy_tools map image_start to
        // image_refs (models/wan/wan_handler.py), and WanGP's gen_video_with_speech then sets Text Prompt ("T").
        if (shot.image && wangpArchitecture(d, m) === "infinitetalk") {
          settings.image_refs = [shot.image];
          settings.image_start = null;
          settings.image_prompt_type = "T";
        }
      }
      const tail = await runWanGP({ dir: d, command, settings, workDir: ctx.dir, settingsName: "wan-settings.json", label: shot.id, signal: ctx.signal, onProgress: ctx.onProgress });
      const clip = newestFile(ctx.dir, /\.(mp4|mkv|webm|mov)$/i);
      if (!clip) throw new Fatal(`${shot.id}: WanGP finished but wrote no video:\n${tail}`);
      const p = await probe(clip);
      return { path: clip, durationSec: Math.min(p.durationSec, shot.duration_sec) };
    },
  };
}
