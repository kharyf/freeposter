// HyperFrames: HTML compositions rendered to video by headless Chrome. The agent writes the HTML; FreePoster
// renders it with its own pinned HyperFrames install. --strict refuses compositions with lint errors.
import { copyFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { probe } from "../../media.ts";
import { runTool } from "../proc.ts";
import type { HyperframesShot } from "../spec.ts";
import { HYPERFRAMES_VERSION, hyperframesCommand } from "../tools.ts";
import { Fatal, Retryable } from "./errors.ts";
import type { RenderContext, ShotAdapter } from "./index.ts";

/** Every render: 30 fps portrait, default "looks" quality, fail on lint errors, never wait on another render. */
export const HYPERFRAMES_ARGS = ["--fps", "30", "--resolution", "portrait", "--quality", "looks", "--strict", "--no-wait", "--json"];

export function hyperframesAdapter(opts: { command?: () => { bin: string; args: string[] } | null } = {}): ShotAdapter<HyperframesShot> {
  const command = opts.command ?? hyperframesCommand;
  return {
    kind: "hyperframes",
    lane: "cpu",
    version: 1,
    async health() {
      const cmd = command();
      if (!cmd) return { ok: false, detail: `HyperFrames ${HYPERFRAMES_VERSION} isn't installed yet; install it from Setup` };
      try {
        const { code, tail } = await runTool(cmd.bin, [...cmd.args, "--version"], { signal: AbortSignal.timeout(60_000) });
        return code === 0 ? { ok: true, detail: `HyperFrames ${tail.trim().split("\n").at(-1)}` } : { ok: false, detail: tail };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
    async render(shot: HyperframesShot, ctx: RenderContext) {
      const cmd = command();
      if (!cmd) throw new Retryable(`HyperFrames ${HYPERFRAMES_VERSION} isn't installed yet; install it from FreePoster's Setup`);
      writeFileSync(join(ctx.dir, "index.html"), shot.html);
      for (const asset of shot.assets) copyFileSync(asset, join(ctx.dir, basename(asset)));
      const out = join(ctx.dir, "shot.mp4");
      const { code, tail } = await runTool(cmd.bin, [...cmd.args, "render", ctx.dir, "--output", out, ...HYPERFRAMES_ARGS], { cwd: ctx.dir, signal: ctx.signal, timeoutMs: 30 * 60_000 });
      if (code !== 0) throw new Fatal(`${shot.id}: HyperFrames couldn't render the composition:\n${tail}`);
      const p = await probe(out);
      return { path: out, durationSec: Math.min(p.durationSec, shot.duration_sec) };
    },
  };
}
