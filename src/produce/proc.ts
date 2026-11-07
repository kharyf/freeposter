// Runs an external tool (HyperFrames, WanGP, Blender) as a child process: never inside FreePoster's own process,
// so a crash there can't take posting down. Cancelling kills the whole process tree, so a GPU job doesn't keep
// holding the card; the last lines of output are kept for the error message.
import { execFile, spawn } from "node:child_process";
import { Fatal, Retryable } from "./adapters/errors.ts";

export interface RunOptions {
  cwd?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** each line the tool prints (stdout and stderr) */
  onLine?: (line: string) => void;
}

const TAIL_LINES = 40;

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

/** Resolves with the exit code and the output's last 40 lines; rejects when cancelled, timed out or not runnable. */
export function runTool(bin: string, args: string[], opts: RunOptions): Promise<{ code: number; tail: string }> {
  return new Promise((done, fail) => {
    if (opts.signal.aborted) return fail(new Error("cancelled"));
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, detached: process.platform !== "win32" });
    const lines: string[] = [];
    let partial = "";
    let finished = false;
    const take = (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const parts = text.split(/\r?\n|\r/);
      partial = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push(line);
        if (lines.length > TAIL_LINES) lines.shift();
        opts.onLine?.(line);
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const settle = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => { killTree(child.pid); fail(new Error("cancelled")); });
    opts.signal.addEventListener("abort", onAbort);
    const timer = opts.timeoutMs
      ? setTimeout(() => settle(() => { killTree(child.pid); fail(new Retryable(`timed out after ${Math.round(opts.timeoutMs! / 60_000)} min`)); }), opts.timeoutMs)
      : undefined;
    child.on("error", (err: NodeJS.ErrnoException) =>
      settle(() => fail(err.code === "ENOENT" ? new Fatal(`can't run ${bin}: not found; set its path in FreePoster's setup`) : err)));
    child.on("close", (code) => settle(() => {
      if (partial.trim()) lines.push(partial);
      done({ code: code ?? 1, tail: lines.slice(-TAIL_LINES).join("\n") });
    }));
  });
}
