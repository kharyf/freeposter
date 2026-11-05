// Asks Claude through the user's own Claude Code (`claude -p`), so it runs on their Claude plan (Pro, Max…)
// rather than a separately billed API key. Claude Code must be installed and signed in on this computer.
// Any feature that wants Claude (titles, captions, anything else) goes through askClaude.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setting } from "./config.ts";

export const CLAUDE_MODEL = "claude-opus-5-5";
const TIMEOUT_MS = 3 * 60_000;

export type ClaudeRun = (cmd: string, args: string[], stdin: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const NOT_INSTALLED = "Claude Code isn't installed: install it from claude.com/claude-code and run `claude` once to sign in with your Claude plan";

/** Where the `claude` program is: CLAUDE_CODE_PATH, else PATH, else the usual install folders. "" if not found. */
export function findClaude(): string {
  const override = setting("CLAUDE_CODE_PATH");
  if (override) return override;
  const win = process.platform === "win32";
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    // Desktop apps don't always get the shell's PATH (macOS especially).
    join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (win) {
      const exe = join(dir, "claude.exe");
      if (existsSync(exe)) return exe;
      // npm's claude.cmd wraps the real program; run that directly, since Node won't start .cmd files without a shell.
      if (existsSync(join(dir, "claude.cmd"))) {
        const inner = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (existsSync(inner)) return inner;
      }
    } else if (existsSync(join(dir, "claude"))) {
      return join(dir, "claude");
    }
  }
  return "";
}

const run: ClaudeRun = (cmd, args, stdin) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  // An API key in the environment would make Claude Code bill the API instead of the user's plan.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn(cmd, args, { cwd: tmpdir(), env, windowsHide: true, timeout: TIMEOUT_MS });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (err: NodeJS.ErrnoException) => reject(err.code === "ENOENT" ? new Error(NOT_INSTALLED) : err));
  child.on("close", (code, signal) => signal ? reject(new Error(`Claude Code didn't answer within ${TIMEOUT_MS / 60_000} minutes`)) : resolve({ code, stdout, stderr }));
  child.stdin.end(stdin);
});

/** One question to Claude with no tools, answered as JSON matching `schema`. */
export async function askClaude<T>(
  q: { system: string; prompt: string; schema: object; effort?: "low" | "medium" | "high" },
  opts: { run?: ClaudeRun; claudePath?: string } = {},
): Promise<T> {
  const cmd = opts.claudePath ?? findClaude();
  if (!cmd) throw new Error(NOT_INSTALLED);
  const args = [
    "-p", "--output-format", "json", "--no-session-persistence",
    "--model", CLAUDE_MODEL, "--effort", q.effort ?? "low",
    // No tools, MCP servers, slash commands or user settings: a plain question, and few tokens off the plan's limit.
    "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "",
    "--system-prompt", q.system,
    "--json-schema", JSON.stringify(q.schema),
  ];
  const { code, stdout, stderr } = await (opts.run ?? run)(cmd, args, q.prompt);
  let out: { is_error?: boolean; result?: string; stop_reason?: string; structured_output?: T };
  try {
    out = JSON.parse(stdout);
  } catch {
    const said = (stderr || stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
    throw new Error(`Claude Code failed${code ? ` (exit ${code})` : ""}${said ? `: ${said}` : ""}`);
  }
  if (out.stop_reason === "refusal") throw new Error("Claude declined to answer");
  if (out.is_error) throw new Error(`Claude Code: ${String(out.result ?? "it reported an error").slice(0, 300)}`);
  if (out.structured_output !== undefined) return out.structured_output;
  try {
    return JSON.parse(out.result ?? "");
  } catch {
    throw new Error("Claude's reply wasn't the expected JSON");
  }
}
