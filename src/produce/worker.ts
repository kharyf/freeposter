// Runs productions: claims shots from the store per lane (GPU: one at a time, so WanGP and Blender never fight
// over VRAM; CPU: CPU_LANE_CONCURRENCY), renders each through its adapter, caches the result by input hash,
// assembles once every shot of the current revision is done, and tells the webhook.
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { config, dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import type { Transcript } from "../edit/transcribe.ts";
import { queueEvent } from "../notify.ts";
import { backoffMs } from "../runner.ts";
import { blenderTemplates } from "./adapters/blender.ts";
import { Retryable, type Adapters } from "./adapters/index.ts";
import { assemble as realAssemble } from "./assemble.ts";
import { sfxLibrary, sfxPath } from "./sfx.ts";
import { parseSpec, shotsChanged, type ProductionSpec, type ShotSpec, type SpecContext } from "./spec.ts";
import { ProductionStore, type Lane, type Production, type Shot, type ShotPlan } from "./store.ts";

/** Tries per shot for errors worth retrying (out of memory, tool not reachable, timeout). */
export const MAX_SHOT_ATTEMPTS = 3;

export interface WorkerOptions {
  adapters: Adapters;
  /** data/productions */
  dir?: string;
  assemble?: typeof realAssemble;
  /** the voiceover's words, for captions */
  transcribe?: (path: string) => Promise<Transcript>;
  retryDelayMs?: (attempt: number) => number;
}

const log = (id: number, msg: string) => console.log(`[production ${id}] ${msg}`);

export const previewUrl = (id: number) => `${config.baseUrl}/api/productions/${id}/preview.mp4`;
export const thumbUrl = (id: number) => `${config.baseUrl}/api/productions/${id}/thumb.jpg`;

export class ProductionWorker {
  productions: ProductionStore;
  store: Store;
  adapters: Adapters;
  dir: string;
  assemble: typeof realAssemble;
  transcribe?: (path: string) => Promise<Transcript>;
  retryDelayMs: (attempt: number) => number;
  /** running shot rows → their cancel switch */
  running = new Map<number, { controller: AbortController; productionId: number; lane: Lane }>();
  assembling = new Map<number, AbortController>();
  timer: NodeJS.Timeout | undefined;
  lastCleanup = 0;

  constructor(store: Store, opts: WorkerOptions) {
    this.store = store;
    this.productions = new ProductionStore(store);
    this.adapters = opts.adapters;
    this.dir = opts.dir ?? join(dataDir, "productions");
    this.assemble = opts.assemble ?? realAssemble;
    this.transcribe = opts.transcribe;
    this.retryDelayMs = opts.retryDelayMs ?? backoffMs;
    this.productions.requeueInterrupted();
  }

  start(intervalMs = 2_000) {
    const tick = () => {
      void this.tick();
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
    for (const r of this.running.values()) r.controller.abort();
    for (const c of this.assembling.values()) c.abort();
  }

  busy() {
    return this.running.size > 0 || this.assembling.size > 0;
  }

  /** What specs are checked against: the installed Blender templates and the SFX library. */
  context(): SpecContext {
    return { templates: blenderTemplates(), sfx: sfxLibrary().map((s) => s.name) };
  }

  /** Validates a spec without touching anything (dry runs). */
  check(raw: unknown): ProductionSpec {
    return parseSpec(raw, this.context());
  }

  async create(raw: unknown): Promise<Production> {
    const { spec, plan } = await this.prepare(raw);
    const p = this.productions.create(spec, plan);
    log(p.id, `queued ${spec.shots.length} shot${spec.shots.length === 1 ? "" : "s"}`);
    void this.tick();
    return p;
  }

  /** A new revision from a whole new spec; only new or changed shots render again. */
  async revise(id: number, raw: unknown): Promise<{ revision: number; changed: string[] }> {
    const p = this.productions.get(id);
    if (!p) throw new Error(`no production ${id}`);
    const { spec, plan } = await this.prepare(raw);
    const changed = shotsChanged(p.spec, spec);
    const revision = this.productions.revise(id, spec, plan, changed);
    if (revision === null) throw new Error(`production ${id} is ${p.state} and can't be revised`);
    log(id, `revision ${revision}: ${changed.length ? changed.join(", ") : "no shots"} to render`);
    void this.tick();
    return { revision, changed };
  }

  /** Stops a production: its running tools are killed. False once approved. */
  cancel(id: number): boolean {
    if (!this.productions.cancel(id)) return false;
    for (const r of this.running.values()) if (r.productionId === id) r.controller.abort();
    this.assembling.get(id)?.abort();
    log(id, "cancelled");
    return true;
  }

  /** Checks the spec, copies its input files in (by content, so a later change to the original doesn't matter), and plans its shots. */
  async prepare(raw: unknown): Promise<{ spec: ProductionSpec; plan: ShotPlan[] }> {
    const spec = parseSpec(raw, this.context());
    const inputs = join(this.dir, "inputs");
    mkdirSync(inputs, { recursive: true });
    const copy = async (path: string) => {
      const hash = createHash("sha256");
      await pipeline(createReadStream(path), hash);
      const dest = join(inputs, `${hash.digest("hex")}${extname(path).toLowerCase()}`);
      if (!existsSync(dest)) copyFileSync(path, dest);
      return dest;
    };
    for (const s of spec.shots) {
      if (s.kind === "file" || s.kind === "edit") s.path = await copy(s.path);
      if (s.kind === "wan" && s.image) s.image = await copy(s.image);
      if (s.kind === "hyperframes") s.assets = await Promise.all(s.assets.map(copy));
    }
    if (spec.audio.voiceover) spec.audio.voiceover = await copy(spec.audio.voiceover);
    const plan = spec.shots.map((s): ShotPlan => {
      const adapter = this.adapters[s.kind];
      const { id: _id, ...content } = s;
      // Paths are content hashes now, so equal keys mean equal renders.
      const inputKey = createHash("sha256").update(JSON.stringify([s.kind, adapter.version, content])).digest("hex");
      return { shotId: s.id, kind: s.kind, lane: adapter.lane, inputKey };
    });
    return { spec, plan };
  }

  /** Starts what the lanes have room for, and assembles finished productions. Returns once started. */
  async tick(): Promise<void> {
    const limits: Record<Lane, number> = { gpu: 1, cpu: config.produce.cpuLane };
    for (const lane of ["gpu", "cpu"] as Lane[]) {
      while ([...this.running.values()].filter((r) => r.lane === lane).length < limits[lane]) {
        const shot = this.productions.claimShot(lane);
        if (!shot) break;
        this.runShot(shot);
      }
    }
    for (const p of this.readyToAssemble()) if (!this.assembling.has(p.id)) void this.assembleProduction(p);
    if (Date.now() - this.lastCleanup > 3_600_000) this.cleanup();
  }

  /**
   * Open productions whose current revision has every shot done. Includes queued ones: a revise that changed
   * no shots (only transitions, sound or captions) carries every shot over and never claims one.
   */
  readyToAssemble(): Production[] {
    const ids = this.productions.db.prepare(
      `SELECT p.id FROM productions p WHERE p.state IN ('queued', 'rendering')
       AND NOT EXISTS (SELECT 1 FROM shots s WHERE s.production_id = p.id AND s.revision = p.revision AND s.state != 'done')`,
    ).all() as { id: number }[];
    return ids.map((r) => this.productions.get(r.id)!);
  }

  runShot(shot: Shot) {
    const controller = new AbortController();
    this.running.set(shot.id, { controller, productionId: shot.productionId, lane: shot.lane });
    void this.renderShot(shot, controller).finally(() => {
      this.running.delete(shot.id);
      void this.tick();
    });
  }

  async renderShot(shot: Shot, controller: AbortController) {
    const ps = this.productions;
    const p = ps.get(shot.productionId)!;
    const spec = p.spec.shots.find((s) => s.id === shot.shotId);
    const cached = ps.cached(shot.inputKey);
    if (cached && existsSync(cached.path)) {
      ps.finishShot(shot.id, { state: "done", outputPath: cached.path, durationSec: cached.durationSec });
      this.noteProgress(p.id);
      return;
    }
    if (!spec) {
      ps.finishShot(shot.id, { state: "failed", error: "not in the spec" });
      return;
    }
    const dir = join(this.dir, String(p.id), "shots", `${shot.shotId}-r${shot.revision}`);
    mkdirSync(dir, { recursive: true });
    let last = 0;
    try {
      const out = await (this.adapters[spec.kind] as { render(s: ShotSpec, c: object): Promise<{ path: string; durationSec: number }> }).render(spec, {
        dir, signal: controller.signal,
        onProgress: (f: number) => { if (f - last >= 0.05) { last = f; ps.shotProgress(shot.id, f); } },
      });
      ps.putCache(shot.inputKey, out.path, out.durationSec);
      ps.finishShot(shot.id, { state: "done", outputPath: out.path, durationSec: out.durationSec });
      log(p.id, `${shot.shotId} done (${out.durationSec.toFixed(1)} s)`);
      this.noteProgress(p.id);
    } catch (err) {
      const message = (err as Error).message;
      const now = ps.get(p.id)!;
      if (controller.signal.aborted || now.state === "cancelled") {
        ps.finishShot(shot.id, { state: "cancelled", error: "cancelled" });
        return;
      }
      if (err instanceof Retryable && shot.attempts < MAX_SHOT_ATTEMPTS) {
        const wait = this.retryDelayMs(shot.attempts);
        log(p.id, `${shot.shotId} attempt ${shot.attempts} failed, retrying in ${Math.round(wait / 1000)} s: ${message}`);
        ps.finishShot(shot.id, { state: "queued", nextTryAt: Date.now() + wait, error: message });
        return;
      }
      ps.finishShot(shot.id, { state: "failed", error: message });
      // A stale revision's failure doesn't fail the production; the new revision renders on.
      if (now.revision !== shot.revision) return;
      this.fail(p.id, message.startsWith(`${shot.shotId}:`) ? message : `${shot.shotId}: ${message}`);
    }
  }

  noteProgress(id: number) {
    const shots = this.productions.shots(id);
    if (!shots.length) return;
    const done = shots.filter((s) => s.state === "done").length;
    this.productions.setState(id, { progress: (done / shots.length) * 0.9 });
  }

  fail(id: number, error: string) {
    const p = this.productions.get(id)!;
    if (p.state === "failed" || p.state === "cancelled") return;
    this.productions.setState(id, { state: "failed", error });
    this.productions.db.prepare("UPDATE shots SET state = 'cancelled' WHERE production_id = ? AND revision = ? AND state = 'queued'").run(id, p.revision);
    for (const r of this.running.values()) if (r.productionId === id) r.controller.abort();
    log(id, `failed: ${error}`);
    queueEvent(this.store, "production.failed", `production.failed:${id}:${p.revision}`, { production_id: id, revision: p.revision, error },
      `Production ${id} failed: ${error}`);
  }

  async assembleProduction(p: Production) {
    const controller = new AbortController();
    this.assembling.set(p.id, controller);
    const ps = this.productions;
    ps.setState(p.id, { state: "assembling" });
    const shots = ps.shots(p.id);
    // Every shot may have come from the cache, so the production's folder may not exist yet.
    mkdirSync(join(this.dir, String(p.id)), { recursive: true });
    const base = join(this.dir, String(p.id), `r${p.revision}`);
    const out = { final: `${base}-final.mp4`, preview: `${base}-preview.mp4`, thumb: `${base}-thumb.jpg` };
    try {
      log(p.id, "assembling");
      const { durationSec } = await this.assemble(shots.map((s) => ({ path: s.outputPath!, durationSec: s.durationSec! })), p.spec, out, {
        sfxPath: (name) => sfxPath(name), transcribe: this.transcribe, signal: controller.signal,
        onProgress: (f) => ps.setState(p.id, { progress: 0.9 + f * 0.1 }),
      });
      const now = ps.get(p.id)!;
      // Revised or cancelled while assembling: this result is for an old revision.
      if (now.revision !== p.revision || now.state !== "assembling") return;
      ps.setState(p.id, { state: "ready", progress: 1, outputPath: out.final, previewPath: out.preview, thumbPath: out.thumb, durationSec, error: null });
      log(p.id, `ready (${durationSec.toFixed(1)} s)`);
      queueEvent(this.store, "production.ready", `production.ready:${p.id}:${p.revision}`,
        { production_id: p.id, revision: p.revision, title: p.spec.title, duration_sec: durationSec, preview_url: previewUrl(p.id), thumb_url: thumbUrl(p.id) },
        `Production ${p.id}${p.spec.title ? ` (${p.spec.title})` : ""} is ready: ${durationSec.toFixed(1)} s. Show the preview and ask before approving.`);
    } catch (err) {
      const now = ps.get(p.id)!;
      if (controller.signal.aborted || now.state !== "assembling" || now.revision !== p.revision) return;
      this.fail(p.id, `assembly: ${(err as Error).message}`);
    } finally {
      this.assembling.delete(p.id);
    }
  }

  /** Deletes shot renders of productions posted more than SHOT_RETENTION_DAYS ago; finals stay. */
  cleanup() {
    this.lastCleanup = Date.now();
    const before = Date.now() - config.produce.shotRetentionDays * 86_400_000;
    const old = this.productions.db.prepare("SELECT id FROM productions WHERE state = 'approved' AND approved_at < ?").all(before) as { id: number }[];
    for (const { id } of old) {
      const shotsDir = join(this.dir, String(id), "shots");
      if (!existsSync(shotsDir)) continue;
      this.productions.db.prepare("DELETE FROM shot_cache WHERE output_path LIKE ?").run(`${shotsDir}%`);
      rmSync(shotsDir, { recursive: true, force: true });
    }
  }
}
