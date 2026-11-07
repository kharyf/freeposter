// Finds the external tools productions use: Blender, WanGP and FreePoster's own pinned HyperFrames.
// Settings win; these are the fallbacks when a setting is blank.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, dataDir } from "../config.ts";

/** The HyperFrames release productions are tested against; installed into FreePoster's own tools folder. */
export const HYPERFRAMES_VERSION = "0.9.20";

/** "4.2" > "3.10" > "2.92" */
const versionOf = (name: string) => (name.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const newer = (a: number[], b: number[]) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0);

/** The newest Blender Foundation/<version>/blender.exe, else "blender" (on PATH). */
export function findBlender(programFiles = process.env.ProgramFiles || "C:\\Program Files"): string {
  const root = join(programFiles, "Blender Foundation");
  let found: { path: string; v: number[] } | undefined;
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name, "blender.exe");
      const v = versionOf(name);
      if (existsSync(path) && (!found || newer(v, found.v) > 0)) found = { path, v };
    }
  } catch {}
  return found?.path ?? "blender";
}

/** The first folder holding WanGP's wgp.py, else "". */
export function findWanGP(candidates = ["C:\\src\\WanGP", join(process.env.USERPROFILE ?? "", "WanGP")]): string {
  return candidates.find((dir) => dir && existsSync(join(dir, "wgp.py"))) ?? "";
}

/** WanGP's own virtual environment's Python when it has one (the installer makes env_venv), else "python". */
export function wangpPython(dir: string): string {
  const venv = join(dir, "env_venv", "Scripts", "python.exe");
  return existsSync(venv) ? venv : "python";
}

/** The model WanGP last used, from its wgp_config.json. */
export function wangpDefaultModel(dir: string): string {
  try {
    return String(JSON.parse(readFileSync(join(dir, "wgp_config.json"), "utf8")).last_model_type ?? "");
  } catch {
    return "";
  }
}

export const blenderPath = () => config.produce.blenderPath || findBlender();
export const wangpDir = () => config.produce.wangpDir || findWanGP();
export const wangpModel = () => config.produce.wangpModel || wangpDefaultModel(wangpDir());

const hyperframesDir = () => join(dataDir, "tools", "hyperframes");
const hyperframesScript = () => join(hyperframesDir(), "node_modules", "hyperframes", "bin", "hyperframes.mjs");

/** How to run HyperFrames: the HYPERFRAMES_CMD setting split on spaces, else node + the pinned install's script. */
export function hyperframesCommand(): { bin: string; args: string[] } | null {
  const custom = config.produce.hyperframesCmd.trim();
  if (custom) {
    const [bin, ...args] = custom.split(/\s+/);
    return { bin, args };
  }
  return existsSync(hyperframesScript()) ? { bin: process.execPath, args: [hyperframesScript()] } : null;
}

/** Installs the pinned HyperFrames into data/tools/hyperframes (npm, a minute or two the first time). */
export function installHyperframes(): Promise<string> {
  const dir = hyperframesDir();
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "freeposter-tools", private: true }));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((done, fail) =>
    execFile(npm, ["install", "--no-audit", "--no-fund", `hyperframes@${HYPERFRAMES_VERSION}`], { cwd: dir, shell: process.platform === "win32", timeout: 10 * 60_000, windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(`npm install hyperframes failed: ${stderr.trim() || err.message}`)) : done(hyperframesScript()),
    ),
  );
}
