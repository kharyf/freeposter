// WanGP, headless: one settings file per shot, run with `wgp.py --process`. Each run loads the model, renders and
// exits, which frees the GPU for the next job. The settings start from the user's own tuned file for the model
// (WanGP's settings/<model>_settings.json), so their steps, attention and quality choices carry over.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../config.ts";
import { probe } from "../../media.ts";
import { runTool } from "../proc.ts";
import type { WanShot } from "../spec.ts";
import { wangpDir, wangpModel, wangpPython } from "../tools.ts";
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

export function wanAdapter(opts: WanOptions = {}): ShotAdapter<WanShot> {
  const dir = opts.dir ?? wangpDir;
  const model = opts.model ?? wangpModel;
  const command = opts.command ?? ((args: string[]) => ({ bin: wangpPython(dir()), args: [join(dir(), "wgp.py"), ...args] }));
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
      const m = model();
      if (!m) throw new Fatal(`${shot.id}: no WanGP model chosen; set WANGP_MODEL in Setup`);
      let base: Record<string, unknown> = {};
      const own = join(d, "settings", `${m}_settings.json`);
      if (existsSync(own)) try { base = JSON.parse(readFileSync(own, "utf8")); } catch {}
      const settings = {
        ...base,
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
      const file = join(ctx.dir, "wan-settings.json");
      writeFileSync(file, JSON.stringify(settings, null, 2));

      const run = async (args: string[], timeoutMs?: number) => {
        const cmd = command(args);
        let frames = 0;
        return runTool(cmd.bin, cmd.args, {
          cwd: d || undefined, signal: ctx.signal, timeoutMs,
          onLine: (line) => {
            const step = /\[(\d+)\/(\d+)\]/.exec(line);
            if (step) ctx.onProgress(Math.min(Number(step[1]) / Number(step[2]), 0.99));
            if (/Video saved/i.test(line)) frames++;
          },
        });
      };
      const check = await run(["--process", file, "--dry-run"], 10 * 60_000);
      if (check.code !== 0) {
        if (OOM.test(check.tail)) throw new Retryable(`${shot.id}: WanGP ran out of GPU memory:\n${check.tail}`);
        throw new Fatal(`${shot.id}: WanGP refused the settings:\n${check.tail}`);
      }
      const { code, tail } = await run(["--process", file, "--output-dir", ctx.dir], config.produce.wangpTimeoutMin * 60_000);
      if (code !== 0) {
        if (OOM.test(tail)) throw new Retryable(`${shot.id}: WanGP ran out of GPU memory:\n${tail}`);
        throw new Fatal(`${shot.id}: WanGP failed:\n${tail}`);
      }
      const clip = newestVideo(ctx.dir);
      if (!clip) throw new Fatal(`${shot.id}: WanGP finished but wrote no video:\n${tail}`);
      const p = await probe(clip);
      return { path: clip, durationSec: Math.min(p.durationSec, shot.duration_sec) };
    },
  };
}

function newestVideo(dir: string): string | null {
  const vids = readdirSync(dir).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f)).map((f) => join(dir, f));
  return vids.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}
