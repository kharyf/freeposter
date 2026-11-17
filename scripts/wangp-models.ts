// Lists every WanGP model definition (defaults/ and finetunes/) grouped by what it can make, so the
// campaign pipeline can pick real model ids instead of guessing.
//   node scripts/wangp-models.ts
// A definition holds `model.architecture` and `model.name`; WanGP's handlers decide audio-only output per
// architecture, so the groups come from the architecture (with the name prefix WanGP gives TTS/Music models).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wangpDir } from "../src/produce/tools.ts";

type Group = "video" | "speech" | "audio" | "presenter";
const SPEECH_ARCHS = new Set(["dramabox_audio", "scenema_audio", "auk", "minimax_h3_tts_ref2va_pruned"]);
const PRESENTER_ARCH = /multitalk|infinitetalk|fantasy|avatar|hunyuan_custom_audio/;

export function classify(model: { architecture?: string; name?: string; image_outputs?: boolean }): Group | "" {
  const arch = String(model.architecture ?? "");
  const name = String(model.name ?? "");
  if (!arch) return "";
  if (/^(TTS|Speech)\b/i.test(name) || /_tts(_|$)/.test(arch) || SPEECH_ARCHS.has(arch)) return "speech";
  if (/^Music\b/i.test(name)) return "audio";
  if (PRESENTER_ARCH.test(arch)) return "presenter";
  if (model.image_outputs) return "";
  return "video";
}

const dir = wangpDir();
if (!dir || !existsSync(join(dir, "wgp.py"))) {
  console.error("WanGP not found: set WANGP_DIR or install it at C:\src\WanGP");
  process.exit(1);
}
console.log(`WanGP: ${dir}`);

const groups: Record<Group, string[]> = { video: [], speech: [], audio: [], presenter: [] };
for (const folder of ["defaults", "finetunes"]) {
  const path = join(dir, folder);
  if (!existsSync(path)) continue;
  for (const file of readdirSync(path).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const model = JSON.parse(readFileSync(join(path, file), "utf8"))?.model;
      const group = model && classify(model);
      if (group) groups[group].push(file.slice(0, -5));
    } catch {} // not a model definition
  }
}
for (const group of Object.keys(groups) as Group[]) console.log(`\n${group} (${groups[group].length}): ${groups[group].join(", ")}`);
if (!groups.speech.length || !groups.audio.length) {
  console.error("\nGATE FAILED: WanGP has no speech or no audio model");
  process.exit(2);
}
