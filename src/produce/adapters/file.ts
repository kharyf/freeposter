// An existing clip, used as it is or trimmed to [start, end].
import { join } from "node:path";
import { config } from "../../config.ts";
import { probe } from "../../media.ts";
import { runTool } from "../proc.ts";
import type { FileShot } from "../spec.ts";
import { Fatal } from "./errors.ts";
import type { RenderContext, ShotAdapter } from "./index.ts";

export function fileAdapter(): ShotAdapter<FileShot> {
  return {
    kind: "file",
    lane: "cpu",
    version: 1,
    async health() {
      return { ok: true, detail: "uses ffmpeg" };
    },
    async render(shot: FileShot, ctx: RenderContext) {
      if (!shot.trim) return { path: shot.path, durationSec: (await probe(shot.path)).durationSec };
      const out = join(ctx.dir, "shot.mp4");
      const [start, end] = shot.trim;
      const { code, tail } = await runTool(config.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", shot.path, "-t", String(end - start),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", out,
      ], { signal: ctx.signal });
      if (code !== 0) throw new Fatal(`${shot.id}: trimming failed: ${tail}`);
      return { path: out, durationSec: (await probe(out)).durationSec };
    },
  };
}
