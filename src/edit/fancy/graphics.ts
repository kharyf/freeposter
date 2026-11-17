// Renders the planned Fancy graphics through the production adapters. A graphic never fails: an unhealthy tool or a
// failed render moves down the template's fallback chain, which ends at the built-in ffmpeg keyword card.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapters } from "../../produce/adapters/index.ts";
import { checkParams, fallbackParamsFor, fancyTemplateDir, fancyTemplates, GRAPHIC_SIZE, toShot, type FancyTemplate } from "./templates.ts";
import { renderKeywordCard } from "./keyword-card.ts";
import type { PlannedGraphic } from "./plan.ts";

export interface RenderedGraphic { path: string; durationSec: number; template: string }

type Params = Record<string, string | number | boolean>;
type Tool = FancyTemplate["tool"];
type Tools = Pick<Adapters, "remotion" | "hyperframes" | "blender">;

const TOOL_NAME: Record<Tool, string> = { remotion: "Remotion", hyperframes: "HyperFrames", blender: "Blender", builtin: "a keyword card" };
/** The built-in card has no adapter: its cache is keyed on this instead of an adapter version. */
const BUILTIN_VERSION = 1;

class Semaphore {
  private waiting: (() => void)[] = [];
  private free: number;
  constructor(n: number) { this.free = n; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.free++;
    }
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]);
}

/** A hash of what the template renders from: its own files, and the shared ones it loads (GSAP, for HyperFrames). */
function templateHash(t: FancyTemplate): string {
  const files = filesUnder(t.dir);
  if (t.tool === "hyperframes") files.push(join(fancyTemplateDir(), "_shared", "gsap.min.js"));
  const h = createHash("sha256");
  for (const f of files) if (existsSync(f) && statSync(f).isFile()) h.update(f.slice(t.dir.length)).update(readFileSync(f));
  return h.digest("hex");
}

/** Cut at a word boundary to at most `max` characters (a single longer word is cut hard). */
function truncate(text: string, max: number): string {
  const s = text.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = s[max] === " " ? max : cut.lastIndexOf(" ");
  return (at > 0 ? cut.slice(0, at) : cut).trim();
}

/** Cheap repairs for params that came out of a fallback mapping: word lists to their most words, text to its maxLength. */
function repair(t: FancyTemplate, params: Params): Params {
  const out = { ...params };
  for (const [k, p] of Object.entries(t.params)) {
    let v = out[k];
    if (typeof v !== "string") continue;
    if (p.parts?.separator === " ") v = v.trim().split(/\s+/).slice(0, p.parts.max).join(" ");
    if (p.maxLength !== undefined) v = truncate(v, p.maxLength);
    out[k] = v;
  }
  return out;
}

/** The params to render t with, or null when they can't be made valid. */
function usable(t: FancyTemplate, raw: Params): Params | null {
  for (const attempt of [raw, repair(t, raw)]) {
    const r = checkParams(t, attempt);
    if (!r.problems.length) return r.params;
  }
  return null;
}

interface Failure { tool: Tool; reason: string }

const oneLine = (m: string) => m.replace(/\s+/g, " ").trim().slice(0, 200);

export async function renderGraphics(
  graphics: PlannedGraphic[],
  opts: { dir: string; adapters: Tools; signal: AbortSignal; onProgress?: (f: number) => void },
): Promise<{ clips: RenderedGraphic[]; notes: string[] }> {
  const catalogue = fancyTemplates();
  const health = new Map<string, Promise<{ ok: boolean; detail: string }>>();
  const healthOf = (tool: "remotion" | "hyperframes" | "blender") => {
    if (!health.has(tool)) health.set(tool, opts.adapters[tool].health().catch((e) => ({ ok: false, detail: (e as Error).message })));
    return health.get(tool)!;
  };
  const hashes = new Map<string, string>();
  const hashOf = (t: FancyTemplate) => {
    if (!hashes.has(t.id)) hashes.set(t.id, templateHash(t));
    return hashes.get(t.id)!;
  };
  // Blender is heavy enough to go alone, and HyperFrames refuses a second render while one is running ("Another
  // render is running for this user account"): each has a lane of one. Remotion and the keyword card share two slots.
  const cpu = new Semaphore(2);
  const blender = new Semaphore(1);
  const hyperframes = new Semaphore(1);
  const slot = (tool: Tool) => (tool === "blender" ? blender : tool === "hyperframes" ? hyperframes : cpu);

  // Identical graphics (same cache key) share one render: they would otherwise write the same folder at once.
  const inFlight = new Map<string, Promise<{ path: string; durationSec: number }>>();
  const render = (t: FancyTemplate, params: Params, sec: number, id: string): Promise<{ path: string; durationSec: number }> => {
    const version = t.tool === "builtin" ? BUILTIN_VERSION : opts.adapters[t.tool].version;
    const key = createHash("sha256")
      .update(JSON.stringify([t.id, params, sec, GRAPHIC_SIZE.width, GRAPHIC_SIZE.height, version, hashOf(t)]))
      .digest("hex").slice(0, 16);
    const running = inFlight.get(key);
    if (running) return running;
    const p = renderTo(join(opts.dir, key), t, params, sec, id);
    inFlight.set(key, p);
    return p;
  };

  // A cached clip counts only with its .done marker, written after a render succeeded: a killed process leaves none.
  const renderTo = async (dir: string, t: FancyTemplate, params: Params, sec: number, id: string): Promise<{ path: string; durationSec: number }> => {
    const clip = join(dir, "shot.mp4");
    const marker = join(dir, ".done");
    if (existsSync(marker) && existsSync(clip) && statSync(clip).size > 0) return { path: clip, durationSec: sec };
    mkdirSync(dir, { recursive: true });
    rmSync(marker, { force: true });
    rmSync(clip, { force: true });
    try {
      let out: { path: string; durationSec: number };
      if (t.tool === "builtin") out = await renderKeywordCard(String(params.phrase), sec, clip);
      else {
        const adapter = opts.adapters[t.tool] as any;
        const ctx = { dir, signal: opts.signal, onProgress: () => {} };
        const shot = toShot(t, params, sec, id);
        try {
          out = await adapter.render(shot, ctx);
        } catch (err) {
          // Remotion sometimes exits non-zero right after "Webpack config change detected. Clearing cache"; a second go works.
          if (t.tool !== "remotion" || opts.signal.aborted) throw err;
          out = await adapter.render(shot, ctx);
        }
      }
      writeFileSync(marker, "");
      return out;
    } catch (err) {
      rmSync(clip, { force: true });
      throw err;
    }
  };

  let done = 0;
  const clips: RenderedGraphic[] = new Array(graphics.length);
  const outcomes: { failed: Failure[]; final: Tool }[] = new Array(graphics.length);

  await Promise.all(graphics.map(async (g, i) => {
    const sec = Math.round((g.end - g.start) * 1000) / 1000;
    const failed: Failure[] = [];
    let t: FancyTemplate | undefined = catalogue[g.template];
    let raw: Params = g.params;
    while (t) {
      opts.signal.throwIfAborted();
      let params = usable(t, raw);
      // The last step always works: the phrase, shortened to fit.
      if (!params && t.tool === "builtin") params = { phrase: truncate(g.phrase, t.params.phrase?.maxLength ?? 40) || "…" };
      if (params) {
        let reason: string | null = null;
        if (t.tool !== "builtin") {
          const h = await healthOf(t.tool);
          if (!h.ok) reason = `isn't available (${oneLine(h.detail)})`;
        }
        if (!reason) {
          try {
            const out = await slot(t.tool).run(() => render(t!, params!, sec, `fancy-${i}`));
            clips[i] = { path: out.path, durationSec: out.durationSec, template: t.id };
            outcomes[i] = { failed, final: t.tool };
            break;
          } catch (err) {
            opts.signal.throwIfAborted();
            reason = `couldn't render (${oneLine((err as Error).message)})`;
          }
        }
        failed.push({ tool: t.tool, reason });
        raw = fallbackParamsFor(t, params, g.phrase);
      } else {
        raw = fallbackParamsFor(t, raw, g.phrase);
      }
      t = t.fallback ? catalogue[t.fallback] : undefined;
    }
    if (!clips[i]) throw new Error(`graphic ${i} (${g.template}) couldn't be rendered, not even as a keyword card`);
    opts.onProgress?.(++done / graphics.length);
  }));

  // One note per tool that let graphics down, and what made them instead, in the order graphics appear.
  const groups = new Map<string, { tool: Tool; reason: string; final: Tool; n: number }>();
  for (const { failed, final } of outcomes) {
    for (const f of failed) {
      const k = `${f.tool}>${final}`;
      const g = groups.get(k);
      if (g) g.n++; else groups.set(k, { tool: f.tool, reason: f.reason, final, n: 1 });
    }
  }
  const notes = [...groups.values()].map((g) =>
    `${TOOL_NAME[g.tool]} ${g.reason}: ${g.n} graphic${g.n === 1 ? "" : "s"} made with ${TOOL_NAME[g.final]} instead`);
  return { clips, notes };
}
