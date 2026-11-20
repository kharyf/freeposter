// Finding and running the AI programs people install with their plans (Codex, Copilot, Grok...).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const TIMEOUT_MS = 3 * 60_000;

/**
 * cwd defaults to the temp folder and timeoutMs to TIMEOUT_MS. signal stops the run. With killTree, a timeout or
 * stop ends the program's whole process tree (what it started too), not just the program.
 */
export type ProgramRun = (cmd: string, args: string[], stdin: string, opts?: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; signal?: AbortSignal; killTree?: boolean }) =>
  Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Folders to look in besides PATH: desktop apps don't always get the shell's PATH. */
function searchDirs(extra: string[]): string[] {
  const home = homedir();
  return [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : []),
    "/opt/homebrew/bin", "/usr/local/bin",
    ...extra,
  ];
}

/** The first of `names` found, as a full path ("" when none is). On Windows: name.exe, then npm's name.cmd. */
export function findProgram(names: string[], extraDirs: string[] = []): string {
  const win = process.platform === "win32";
  for (const dir of searchDirs(extraDirs)) {
    for (const name of names) {
      if (win) {
        for (const ext of [".exe", ".cmd", ".bat"]) if (existsSync(join(dir, name + ext))) return join(dir, name + ext);
      } else if (existsSync(join(dir, name))) {
        return join(dir, name);
      }
    }
  }
  return "";
}

/**
 * What a Windows .cmd launcher runs, so it can be started without a shell (where a multi-line prompt in an
 * argument can't survive cmd.exe's quoting). npm's launchers end with `"%_prog%" "%dp0%\...\cli.js" %*`.
 */
export function unwrapCmd(path: string): string[] | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const line = text.split(/\r?\n/).reverse().find((l) => l.includes("%*"));
  if (!line) return null;
  const dir = dirname(path);
  const tokens = [...line.slice(0, line.lastIndexOf("%*")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!tokens.length) return null;
  const local = (s: string) => s.replace(/%~dp0\\?|%dp0%\\?/gi, `${dir}\\`);
  const out = tokens.map((t) => {
    if (/^%_prog%$/i.test(t)) return existsSync(join(dir, "node.exe")) ? join(dir, "node.exe") : findProgram(["node"]) || "node";
    return local(t);
  });
  return out.some((t) => t.includes("%")) ? null : out;
}

/** Ends a process and everything it started (replaced in tests). */
export const processTree = {
  kill(pid: number) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } else {
      // The program was started as its own process group, so the negative pid reaches the whole group.
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
  },
};

export const runProgram: ProgramRun = (cmd, args, stdin, opts = {}) => new Promise((resolve, reject) => {
  let file = cmd;
  let argv = args;
  let shell = false;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd)) {
    const inner = unwrapCmd(cmd);
    if (inner) [file, ...argv] = [...inner, ...args];
    else {
      // Last resort: through cmd.exe, which can't carry line breaks inside an argument.
      shell = true;
      file = `"${cmd}"`;
      argv = args.map((a) => `"${a.replace(/\r?\n/g, " ").replace(/"/g, '""')}"`);
    }
  }
  const timeout = opts.timeoutMs ?? TIMEOUT_MS;
  const tree = Boolean(opts.killTree);
  const late = () => new Error(`it didn't answer within ${timeout / 60_000} minutes`);
  if (opts.signal?.aborted) return reject(new Error(`${cmd} was stopped`));
  const child = spawn(file, argv, {
    cwd: opts.cwd ?? tmpdir(), env: opts.env ?? process.env, windowsHide: true, shell,
    // A tree-killed run keeps its own timer; elsewhere spawn's timeout ends just the program, as it always has.
    ...(tree ? { detached: process.platform !== "win32" } : { timeout, signal: opts.signal }),
  });
  let stdout = "";
  let stderr = "";
  let ended: Error | null = null;
  const end = (why: Error) => {
    if (ended || child.pid === undefined || child.exitCode !== null) return;
    ended = why;
    processTree.kill(child.pid);
  };
  const timer = tree ? setTimeout(() => end(late()), timeout) : undefined;
  const onAbort = () => end(new Error(`${cmd} was stopped`));
  if (tree) opts.signal?.addEventListener("abort", onAbort, { once: true });
  const done = () => { clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); };
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (err: NodeJS.ErrnoException) => {
    done();
    if (err.name === "AbortError") return reject(new Error(`${cmd} was stopped`));
    reject(err.code === "ENOENT" ? new Error(`${cmd} couldn't be started`) : err);
  });
  child.on("close", (code, signal) => {
    done();
    if (ended) reject(ended);
    else if (signal) reject(late());
    else resolve({ code, stdout, stderr });
  });
  child.stdin.on("error", () => {}); // a program that doesn't read stdin closes it early
  child.stdin.end(stdin);
});

/** The environment minus API keys that would make a program bill an API account instead of the user's plan. */
export function planEnv(drop: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of drop) delete env[k];
  return env;
}

/** The last few lines a failed program printed, for the error message. */
export function lastWords(stdout: string, stderr: string): string {
  return (stderr || stdout).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
}
