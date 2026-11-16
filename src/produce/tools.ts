// Finds the external tools productions use: Blender, WanGP and FreePoster's own pinned HyperFrames and Remotion.
// Settings win; these are the fallbacks when a setting is blank.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, dataDir } from "../config.ts";

/** The HyperFrames release productions are tested against; installed into FreePoster's own tools folder. */
export const HYPERFRAMES_VERSION = "0.9.20";
/** The Remotion release (and the React it renders with) remotion shots are tested against; also in FreePoster's tools folder. */
export const REMOTION_VERSION = "4.0.538";
export const REMOTION_REACT_VERSION = "19.2.0";

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

export interface ToolCommand { bin: string; args: string[]; env?: NodeJS.ProcessEnv }

/**
 * How to run HyperFrames: the HYPERFRAMES_CMD setting split on spaces, else our own runtime + the pinned install's
 * script. In the desktop app process.execPath is FreePoster.exe, not node: without ELECTRON_RUN_AS_NODE it would
 * start a second FreePoster, which loses the single-instance lock and exits 0 having printed and rendered nothing.
 */
export function hyperframesCommand(): ToolCommand | null {
  const custom = config.produce.hyperframesCmd.trim();
  if (custom) {
    const [bin, ...args] = custom.split(/\s+/);
    return { bin, args };
  }
  if (!existsSync(hyperframesScript())) return null;
  return { bin: process.execPath, args: [hyperframesScript()], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/** npm install of exact package versions into a folder of its own under data/tools. */
function npmInstall(dir: string, packages: string[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "freeposter-tools", private: true }));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((done, fail) =>
    execFile(npm, ["install", "--no-audit", "--no-fund", ...packages], { cwd: dir, shell: process.platform === "win32", timeout: 10 * 60_000, windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(`npm install ${packages.join(" ")} failed: ${stderr.trim() || err.message}`)) : done(),
    ),
  );
}

/** Installs the pinned HyperFrames into data/tools/hyperframes (npm, a minute or two the first time). */
export async function installHyperframes(): Promise<string> {
  await npmInstall(hyperframesDir(), [`hyperframes@${HYPERFRAMES_VERSION}`]);
  return hyperframesScript();
}

/**
 * The Remotion project every remotion shot renders inside: shots are written to work/<shot> under it, so their
 * imports of remotion and react resolve to this install, and Remotion's own headless Chrome lives in its node_modules.
 */
export const remotionDir = () => join(dataDir, "tools", "remotion");
const remotionScript = () => join(remotionDir(), "node_modules", "@remotion", "cli", "remotion-cli.js");

/** How to run Remotion's CLI: our own runtime (node mode, as for HyperFrames) + the pinned install's script. */
export function remotionCommand(): ToolCommand | null {
  if (!existsSync(remotionScript())) return null;
  return { bin: process.execPath, args: [remotionScript()], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/** Installs the pinned Remotion into data/tools/remotion, then fetches its headless Chrome so the first render doesn't. */
export async function installRemotion(): Promise<string> {
  const dir = remotionDir();
  await npmInstall(dir, [`remotion@${REMOTION_VERSION}`, `@remotion/cli@${REMOTION_VERSION}`, `react@${REMOTION_REACT_VERSION}`, `react-dom@${REMOTION_REACT_VERSION}`]);
  const cmd = remotionCommand();
  if (!cmd) throw new Error("npm finished but Remotion's CLI isn't there");
  await new Promise<void>((done, fail) =>
    execFile(cmd.bin, [...cmd.args, "browser", "ensure"], { cwd: dir, env: cmd.env, timeout: 10 * 60_000, windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(`Remotion couldn't download its browser: ${stderr.trim() || err.message}`)) : done(),
    ),
  );
  return remotionScript();
}
