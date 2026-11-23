import { format } from "node:util";

export type ConsoleLine = { seq: number; at: number; level: "info" | "error"; text: string };

export class ConsoleBuffer {
  private lines: ConsoleLine[] = [];
  private seq = 0;
  private limit: number;
  constructor(limit = 5000) { this.limit = limit; }

  push(level: ConsoleLine["level"], text: string): ConsoleLine {
    const line: ConsoleLine = { seq: ++this.seq, at: Date.now(), level, text };
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    return line;
  }

  since(after: number): { lines: ConsoleLine[]; latest: number; dropped: boolean } {
    let from = Number.isFinite(after) && after >= 0 ? after : 0;
    if (from > this.seq) from = 0; // the server restarted: the caller's cursor is stale
    const lines = this.lines.filter((l) => l.seq > from);
    const dropped = this.lines.length > 0 && this.lines[0].seq > from + 1;
    return { lines, latest: this.seq, dropped };
  }
}

const MARK = Symbol.for("freeposter.consoleCapture");
const METHODS = [["log", "info"], ["info", "info"], ["warn", "error"], ["error", "error"]] as const;

export function installConsoleCapture(buffer: ConsoleBuffer, target: Console = console): () => void {
  const t = target as any;
  if (t[MARK]) return t[MARK] as () => void;
  const originals: Record<string, (...a: unknown[]) => void> = {};
  for (const [method, level] of METHODS) {
    const prev = t[method];
    originals[method] = prev;
    t[method] = (...args: unknown[]) => {
      try { buffer.push(level, format(...args)); } catch { /* never break logging */ }
      return prev.apply(target, args);
    };
  }
  const undo = () => {
    for (const [method] of METHODS) t[method] = originals[method];
    delete t[MARK];
  };
  t[MARK] = undo;
  return undo;
}

export const consoleBuffer = new ConsoleBuffer();
