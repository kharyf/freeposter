// HyperFrames: HTML compositions rendered to video by headless Chrome. The agent writes the HTML; FreePoster
// renders it with its own pinned HyperFrames install. --strict refuses compositions with lint errors.
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { probe } from "../../media.ts";
import { runTool } from "../proc.ts";
import type { FrameSize, HyperframesShot } from "../spec.ts";
import { HYPERFRAMES_VERSION, hyperframesCommand, type ToolCommand } from "../tools.ts";
import { Fatal, Retryable } from "./errors.ts";
import type { RenderContext, ShotAdapter } from "./index.ts";

/** Every render: 30 fps portrait, default "looks" quality, fail on lint errors, never wait on another render. */
export const HYPERFRAMES_ARGS = ["--fps", "30", "--resolution", "portrait", "--quality", "looks", "--strict", "--no-wait", "--json"];

/**
 * A sized shot (the Fancy graphics, 1080x960) leaves out the portrait preset: the CLI then renders at the
 * composition's own data-width x data-height (a preset must match the composition's aspect ratio).
 */
export const hyperframesArgs = (size?: FrameSize) =>
  size ? HYPERFRAMES_ARGS.filter((a, i, all) => a !== "--resolution" && all[i - 1] !== "--resolution") : HYPERFRAMES_ARGS;

export function hyperframesAdapter(opts: { command?: () => ToolCommand | null } = {}): ShotAdapter<HyperframesShot> {
  const command = opts.command ?? hyperframesCommand;
  return {
    kind: "hyperframes",
    lane: "cpu",
    version: 1,
    async health() {
      const cmd = command();
      if (!cmd) return { ok: false, missing: true, detail: `version ${HYPERFRAMES_VERSION} isn't installed yet (Setup → Production tools)` };
      try {
        const { code, tail } = await runTool(cmd.bin, [...cmd.args, "--version"], { signal: AbortSignal.timeout(60_000), env: cmd.env });
        const version = tail.trim().split("\n").at(-1)?.trim();
        if (code === 0 && !version) return { ok: false, detail: `${cmd.bin} exited without printing a version; it isn't running HyperFrames` };
        return code === 0 ? { ok: true, detail: `HyperFrames ${version}` } : { ok: false, detail: tail };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
    async render(shot: HyperframesShot, ctx: RenderContext) {
      const cmd = command();
      if (!cmd) throw new Retryable(`HyperFrames ${HYPERFRAMES_VERSION} isn't installed yet; install it from FreePoster's Setup`);
      writeFileSync(join(ctx.dir, "index.html"), shot.html);
      for (const asset of shot.assets) copyFileSync(asset.path, join(ctx.dir, asset.name));
      const out = join(ctx.dir, "shot.mp4");
      const { code, tail } = await runTool(cmd.bin, [...cmd.args, "render", ctx.dir, "--output", out, ...hyperframesArgs(shot.size)], { cwd: ctx.dir, signal: ctx.signal, timeoutMs: 30 * 60_000, env: cmd.env });
      if (code !== 0) throw new Fatal(`${shot.id}: HyperFrames couldn't render the composition:\n${tail}`);
      if (!existsSync(out)) throw new Fatal(`${shot.id}: HyperFrames exited without writing ${basename(out)}${tail.trim() ? `:\n${tail}` : ` (${cmd.bin} printed nothing)`}`);
      const p = await probe(out);
      return { path: out, durationSec: Math.min(p.durationSec, shot.duration_sec) };
    },
  };
}
