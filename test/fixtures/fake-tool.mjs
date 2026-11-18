// Stands in for HyperFrames, Remotion, WanGP (wan: video, wan-audio: speech/music) and Blender in tests. Records its arguments, then behaves per FAKE_MODE:
//   ok (default)  writes a short test clip where the real tool would
//   fail          prints a few lines and exits 1
//   oom           prints a CUDA out-of-memory line and exits 1
//   hang          never exits (cancel and timeout tests)
//   silent        prints nothing, writes nothing, exits 0 (a second app instance that lost the single-instance lock)
// Usage: node fake-tool.mjs <tool> ...the tool's own arguments
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? "ok";
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, args }) + "\n");

const clip = (out, seconds = 2) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=720x1280:rate=24`, "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);

if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "silent") process.exit(0);
else if (mode === "fail") { console.log("working…\nsomething went wrong in the tool"); process.exit(1); }
else if (mode === "oom") { console.error("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB"); process.exit(1); }
else if (tool === "hyperframes") {
  clip(args[args.indexOf("--output") + 1]);
} else if (tool === "remotion") {
  if (args[0] === "versions") console.log("remotion@4.0.538\nAll packages have the correct version.");
  else {
    // The project only exists while the render runs: record what it held.
    const [, entry, , out] = args;
    const work = dirname(entry);
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ project: readdirSync(work).sort(), public: readdirSync(args[args.indexOf("--public-dir") + 1]).sort(), entry: readFileSync(entry, "utf8"), props: JSON.parse(readFileSync(args[args.indexOf("--props") + 1], "utf8")) }) + "\n");
    console.log("Rendered 30/60, time remaining: 1s");
    clip(out);
  }
} else if (tool === "wan") {
  const dry = args.includes("--dry-run");
  console.log("[DRY-RUN] Validation complete. 1/1 task(s) valid.");
  if (!dry) {
    const out = args[args.indexOf("--output-dir") + 1];
    const settings = JSON.parse(readFileSync(args[args.indexOf("--process") + 1], "utf8"));
    clip(join(out, `${settings.output_filename}.mp4`), 3);
  }
} else if (tool === "wan-audio") {
  // WanGP with a speech or music model: audio-only models save <output_filename>.wav (wgp.py, audio_only branch).
  console.log("[DRY-RUN] Validation complete. 1/1 task(s) valid.");
  if (!args.includes("--dry-run")) {
    const out = args[args.indexOf("--output-dir") + 1];
    const settings = JSON.parse(readFileSync(args[args.indexOf("--process") + 1], "utf8"));
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "3", join(out, `${settings.output_filename}.wav`)]);
  }
} else if (tool === "blender") {
  const params = JSON.parse(readFileSync(args[args.indexOf("--") + 1], "utf8"));
  mkdirSync(params.out_dir, { recursive: true });
  const frames = Math.round(params.duration_sec * params.fps);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${params.width}x${params.height}:rate=${params.fps}`, "-frames:v", String(frames), join(params.out_dir, "frame_%04d.png")]);
}
