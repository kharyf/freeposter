// Lists every WanGP model definition (defaults/ and finetunes/) grouped by what it can make, so the
// campaign pipeline can pick real model ids instead of guessing. The grouping is wangpModels (src/produce/tools.ts).
//   node scripts/wangp-models.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { wangpDir, wangpModels, type WanGPGroup } from "../src/produce/tools.ts";

const dir = wangpDir();
if (!dir || !existsSync(join(dir, "wgp.py"))) {
  console.error("WanGP not found: set WANGP_DIR or install it at C:/src/WanGP");
  process.exit(1);
}
console.log(`WanGP: ${dir}`);
const groups = wangpModels(dir);
for (const group of Object.keys(groups) as WanGPGroup[]) console.log(`\n${group} (${groups[group].length}): ${groups[group].join(", ")}`);
if (!groups.speech.length || !groups.audio.length) {
  console.error("\nGATE FAILED: WanGP has no speech or no audio model");
  process.exit(2);
}
