// Blender, headless, from vetted templates only: each template is a Python script that builds its scene in
// code from params.json (no .blend files, so templates work across Blender versions) and renders PNG frames,
// which FreePoster encodes. The agent never sends Python; it picks a template and fills its params.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeDir, config, dataDir } from "../../config.ts";
import { probe } from "../../media.ts";
import { runTool } from "../proc.ts";
import type { BlenderShot, TemplateSchema } from "../spec.ts";
import { blenderPath } from "../tools.ts";
import { Fatal } from "./errors.ts";
import type { RenderContext, ShotAdapter } from "./index.ts";

const FPS = 30;

/** Template folders: the ones FreePoster ships, then the user's own (which win on a name clash). */
// In the installed app they are unpacked beside app.asar, since Blender can't read inside it.
export const templateDirs = () => [join(codeDir.replace(/app\.asar$/, "app.asar.unpacked"), "templates", "blender"), join(dataDir, "blender-templates")];

/** Every template with a template.py and a schema.json, by folder name. */
export function blenderTemplates(): Record<string, TemplateSchema & { script: string }> {
  const out: Record<string, TemplateSchema & { script: string }> = {};
  for (const root of templateDirs()) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const script = join(root, name, "template.py");
      const schema = join(root, name, "schema.json");
      if (!existsSync(script) || !existsSync(schema)) continue;
      try {
        const parsed = JSON.parse(readFileSync(schema, "utf8")) as TemplateSchema;
        out[name] = { description: parsed.description ?? "", params: parsed.params ?? {}, script };
      } catch (err) {
        console.error(`blender template ${name}: bad schema.json: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

export function blenderAdapter(opts: { command?: (args: string[]) => { bin: string; args: string[] } } = {}): ShotAdapter<BlenderShot> {
  const command = opts.command ?? ((args: string[]) => ({ bin: blenderPath(), args }));
  return {
    kind: "blender",
    lane: "gpu",
    version: 1,
    async health() {
      const cmd = command(["-b", "--version"]);
      try {
        const { code, tail } = await runTool(cmd.bin, cmd.args, { signal: AbortSignal.timeout(60_000) });
        const line = tail.split("\n").find((l) => /^Blender \d/.test(l));
        return code === 0 && line ? { ok: true, detail: line.trim() } : { ok: false, detail: tail || "Blender didn't start" };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
    async render(shot: BlenderShot, ctx: RenderContext) {
      const template = blenderTemplates()[shot.template];
      if (!template) throw new Fatal(`${shot.id}: unknown template "${shot.template}"`);
      const frames = join(ctx.dir, "frames");
      mkdirSync(frames, { recursive: true });
      const paramsFile = join(ctx.dir, "params.json");
      writeFileSync(paramsFile, JSON.stringify({ params: shot.params, duration_sec: shot.duration_sec, fps: FPS, width: 1080, height: 1920, engine: shot.engine, out_dir: frames }, null, 2));
      const total = Math.round(shot.duration_sec * FPS);
      const cmd = command(["-b", "--factory-startup", "-P", template.script, "--", paramsFile]);
      const { code, tail } = await runTool(cmd.bin, cmd.args, {
        cwd: ctx.dir, signal: ctx.signal, timeoutMs: 60 * 60_000,
        onLine: (line) => {
          const f = /^Fra:\s*(\d+)/.exec(line) ?? /Saved: .*frame_(\d+)/.exec(line);
          if (f) ctx.onProgress(Math.min(Number(f[1]) / total, 0.95));
        },
      });
      const rendered = readdirSync(frames).filter((f) => /^frame_\d+\.png$/.test(f)).length;
      if (code !== 0 || rendered === 0) throw new Fatal(`${shot.id}: Blender template "${shot.template}" failed:\n${tail}`);
      const out = join(ctx.dir, "shot.mp4");
      const enc = await runTool(config.ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-start_number", "1", "-i", join(frames, "frame_%04d.png"),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", out,
      ], { signal: ctx.signal });
      if (enc.code !== 0) throw new Fatal(`${shot.id}: encoding Blender's frames failed: ${enc.tail}`);
      const p = await probe(out);
      return { path: out, durationSec: Math.min(p.durationSec, shot.duration_sec) };
    },
  };
}
