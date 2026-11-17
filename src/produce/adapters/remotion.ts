// Remotion: a React component rendered to video, frame by frame, in headless Chrome. The agent writes the
// component; FreePoster wraps it in a composition of the shot's length at 1080x1920, 30 fps, and renders it with
// its own pinned Remotion. Each render is a small project in the install's work folder, so the component's
// imports of remotion and react resolve to that install; it's removed once the clip is out.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomToken } from "../../crypto.ts";
import { probe } from "../../media.ts";
import { runTool } from "../proc.ts";
import type { FrameSize, RemotionShot } from "../spec.ts";
import { REMOTION_VERSION, remotionCommand, remotionDir, type ToolCommand } from "../tools.ts";
import { Fatal, Retryable } from "./errors.ts";
import type { RenderContext, ShotAdapter } from "./index.ts";

export const REMOTION_FPS = 30;
/** After the entry, composition id and output: H.264 (what assembly expects), replacing a leftover file. */
export const REMOTION_ARGS = ["--codec", "h264", "--overwrite"];

/** The entry Remotion bundles: the agent's component as the one composition, "Shot", sized and timed by FreePoster. */
export function remotionEntry(durationSec: number, size: FrameSize = { width: 1080, height: 1920 }): string {
  const frames = Math.max(1, Math.round(durationSec * REMOTION_FPS));
  return `import { Composition, registerRoot } from "remotion";
import Shot from "./Shot";
import props from "./props.json";

const Root = () => (
  <Composition id="Shot" component={Shot as any} width={${size.width}} height={${size.height}} fps={${REMOTION_FPS}} durationInFrames={${frames}} defaultProps={props as any} />
);
registerRoot(Root);
`;
}

export function remotionAdapter(opts: { command?: () => ToolCommand | null; root?: () => string } = {}): ShotAdapter<RemotionShot> {
  const command = opts.command ?? remotionCommand;
  const root = opts.root ?? remotionDir;
  return {
    kind: "remotion",
    lane: "cpu",
    version: 1,
    async health() {
      const cmd = command();
      if (!cmd) return { ok: false, missing: true, detail: `version ${REMOTION_VERSION} isn't installed yet (Setup → Production tools)` };
      try {
        const { code, tail } = await runTool(cmd.bin, [...cmd.args, "versions"], { cwd: root(), signal: AbortSignal.timeout(60_000), env: cmd.env });
        if (code !== 0) return { ok: false, detail: tail };
        // Like HyperFrames: a run that prints nothing isn't Remotion (FreePoster.exe without node mode exits 0 silently).
        if (!tail.includes(REMOTION_VERSION)) return { ok: false, detail: tail.trim() || `${cmd.bin} exited without printing Remotion's versions` };
        return { ok: true, detail: `Remotion ${REMOTION_VERSION}` };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
    async render(shot: RemotionShot, ctx: RenderContext) {
      const cmd = command();
      if (!cmd) throw new Retryable(`Remotion ${REMOTION_VERSION} isn't installed yet; install it from FreePoster's Setup`);
      const work = join(root(), "work", `${shot.id}-${randomToken(6)}`);
      const pub = join(work, "public");
      mkdirSync(pub, { recursive: true });
      try {
        writeFileSync(join(work, "Shot.tsx"), shot.tsx);
        writeFileSync(join(work, "props.json"), JSON.stringify(shot.props));
        writeFileSync(join(work, "index.tsx"), remotionEntry(shot.duration_sec, shot.size));
        for (const a of shot.assets) copyFileSync(a.path, join(pub, a.name));
        // Kept beside the clip, so a failed shot can be looked at.
        writeFileSync(join(ctx.dir, "Shot.tsx"), shot.tsx);
        const out = join(ctx.dir, "shot.mp4");
        const onLine = (line: string) => {
          const m = /Rendered (\d+)\/(\d+)/.exec(line);
          if (m) ctx.onProgress(0.9 * (Number(m[1]) / Number(m[2])));
        };
        const args = [...cmd.args, "render", join(work, "index.tsx"), "Shot", out, "--props", join(work, "props.json"), "--public-dir", pub, ...REMOTION_ARGS];
        const { code, tail } = await runTool(cmd.bin, args, { cwd: root(), signal: ctx.signal, timeoutMs: 30 * 60_000, env: cmd.env, onLine });
        if (code !== 0) throw new Fatal(`${shot.id}: Remotion couldn't render the component:\n${tail}`);
        if (!existsSync(out)) throw new Fatal(`${shot.id}: Remotion exited without writing ${basename(out)}${tail.trim() ? `:\n${tail}` : ` (${cmd.bin} printed nothing)`}`);
        const p = await probe(out);
        return { path: out, durationSec: Math.min(p.durationSec, shot.duration_sec) };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
