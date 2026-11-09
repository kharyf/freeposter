// Productions and their shots in SQLite: the worker's queue and the source of truth for every state.
// Shot rows are kept per revision, so a result that finishes after a revise lands on its own (stale) row and
// never overwrites the new revision's.
import type { Store } from "../db.ts";
import type { ProductionSpec, ShotKind } from "./spec.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS productions (
  id INTEGER PRIMARY KEY,
  spec TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  output_path TEXT,
  preview_path TEXT,
  thumb_path TEXT,
  duration_sec REAL,
  error TEXT,
  approved_at INTEGER,
  post_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY,
  production_id INTEGER NOT NULL REFERENCES productions(id),
  shot_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  lane TEXT NOT NULL,
  input_key TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  output_path TEXT,
  duration_sec REAL,
  error TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (production_id, shot_id, revision)
);
CREATE TABLE IF NOT EXISTS shot_cache (
  input_key TEXT PRIMARY KEY,
  output_path TEXT NOT NULL,
  duration_sec REAL NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** rejected: the user turned down its current revision; revise_production can still make a new one. */
export type ProductionState = "queued" | "rendering" | "assembling" | "ready" | "approved" | "failed" | "cancelled" | "rejected";
export type ShotState = "queued" | "running" | "done" | "failed" | "cancelled";
export type Lane = "gpu" | "cpu";

export interface Production {
  id: number;
  spec: ProductionSpec;
  revision: number;
  state: ProductionState;
  progress: number;
  outputPath: string | null;
  previewPath: string | null;
  thumbPath: string | null;
  durationSec: number | null;
  error: string | null;
  approvedAt: number | null;
  postId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Shot {
  id: number;
  productionId: number;
  shotId: string;
  position: number;
  revision: number;
  kind: ShotKind;
  lane: Lane;
  inputKey: string;
  state: ShotState;
  attempts: number;
  nextTryAt: number;
  progress: number;
  outputPath: string | null;
  durationSec: number | null;
  error: string | null;
}

/** What the worker needs to queue a shot: computed from the spec by the caller (adapters decide lanes and keys). */
export interface ShotPlan { shotId: string; kind: ShotKind; lane: Lane; inputKey: string }

const toProduction = (r: any): Production => ({
  id: r.id, spec: JSON.parse(r.spec), revision: r.revision, state: r.state, progress: r.progress,
  outputPath: r.output_path, previewPath: r.preview_path, thumbPath: r.thumb_path, durationSec: r.duration_sec,
  error: r.error, approvedAt: r.approved_at, postId: r.post_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

const toShot = (r: any): Shot => ({
  id: r.id, productionId: r.production_id, shotId: r.shot_id, position: r.position, revision: r.revision, kind: r.kind,
  lane: r.lane, inputKey: r.input_key, state: r.state, attempts: r.attempts, nextTryAt: r.next_try_at,
  progress: r.progress, outputPath: r.output_path, durationSec: r.duration_sec, error: r.error,
});

const OPEN: ProductionState[] = ["queued", "rendering", "assembling"];

export class ProductionStore {
  store: Store;

  constructor(store: Store) {
    this.store = store;
    store.db.exec(SCHEMA);
  }

  get db() {
    return this.store.db;
  }

  create(spec: ProductionSpec, plan: ShotPlan[]): Production {
    const now = Date.now();
    const id = Number(this.db.prepare("INSERT INTO productions (spec, state, created_at, updated_at) VALUES (?, 'queued', ?, ?)").run(JSON.stringify(spec), now, now).lastInsertRowid);
    this.insertShots(id, 1, plan, new Map());
    return this.get(id)!;
  }

  private insertShots(productionId: number, revision: number, plan: ShotPlan[], keep: Map<string, Shot>) {
    const insert = this.db.prepare(
      `INSERT INTO shots (production_id, shot_id, position, revision, kind, lane, input_key, state, progress, output_path, duration_sec, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    plan.forEach((p, position) => {
      const done = keep.get(p.shotId);
      insert.run(productionId, p.shotId, position, revision, p.kind, p.lane, p.inputKey, done ? "done" : "queued", done ? 1 : 0,
        done?.outputPath ?? null, done?.durationSec ?? null, Date.now());
    });
  }

  get(id: number): Production | undefined {
    const r = this.db.prepare("SELECT * FROM productions WHERE id = ?").get(id);
    return r ? toProduction(r) : undefined;
  }

  recent(limit = 20): Production[] {
    return this.db.prepare("SELECT * FROM productions ORDER BY id DESC LIMIT ?").all(limit).map(toProduction);
  }

  /** Productions still rendering or assembling (they keep the app running in the background). */
  openCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM productions WHERE state IN (${OPEN.map(() => "?").join(",")})`).get(...OPEN) as { n: number }).n;
  }

  /** The shots of a revision (default: the current one), in spec order. */
  shots(productionId: number, revision?: number): Shot[] {
    const rev = revision ?? this.get(productionId)?.revision ?? 0;
    return this.db.prepare("SELECT * FROM shots WHERE production_id = ? AND revision = ? ORDER BY position").all(productionId, rev).map(toShot);
  }

  shot(id: number): Shot | undefined {
    const r = this.db.prepare("SELECT * FROM shots WHERE id = ?").get(id);
    return r ? toShot(r) : undefined;
  }

  /** The oldest due queued shot of a lane, on a current revision of an open production; marked running. */
  claimShot(lane: Lane): Shot | undefined {
    const r = this.db.prepare(
      `UPDATE shots SET state = 'running', attempts = attempts + 1, progress = 0, updated_at = ?
       WHERE id = (
         SELECT s.id FROM shots s JOIN productions p ON p.id = s.production_id
         WHERE s.lane = ? AND s.state = 'queued' AND s.next_try_at <= ? AND s.revision = p.revision AND p.state IN ('queued', 'rendering')
         ORDER BY p.id, s.position LIMIT 1)
       RETURNING *`,
    ).get(Date.now(), lane, Date.now());
    if (!r) return undefined;
    const shot = toShot(r);
    this.db.prepare("UPDATE productions SET state = 'rendering', updated_at = ? WHERE id = ? AND state = 'queued'").run(Date.now(), shot.productionId);
    return shot;
  }

  finishShot(id: number, f: { state: ShotState; outputPath?: string; durationSec?: number; error?: string | null; nextTryAt?: number; progress?: number }) {
    this.db.prepare(
      `UPDATE shots SET state = ?, output_path = COALESCE(?, output_path), duration_sec = COALESCE(?, duration_sec), error = ?,
       next_try_at = COALESCE(?, next_try_at), progress = COALESCE(?, progress), updated_at = ? WHERE id = ?`,
    ).run(f.state, f.outputPath ?? null, f.durationSec ?? null, f.error ?? null, f.nextTryAt ?? null, f.progress ?? (f.state === "done" ? 1 : null), Date.now(), id);
  }

  shotProgress(id: number, progress: number) {
    this.db.prepare("UPDATE shots SET progress = ? WHERE id = ?").run(progress, id);
  }

  setState(id: number, f: Partial<Pick<Production, "state" | "progress" | "outputPath" | "previewPath" | "thumbPath" | "durationSec" | "error">>) {
    const cols = { state: "state", progress: "progress", outputPath: "output_path", previewPath: "preview_path", thumbPath: "thumb_path", durationSec: "duration_sec", error: "error" } as const;
    const keys = Object.keys(f) as (keyof typeof cols)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE productions SET ${keys.map((k) => `${cols[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => f[k] ?? null), Date.now(), id);
  }

  /**
   * A new revision with the given spec: changed shots render again, unchanged finished ones are carried over.
   * Null when the production is approved or cancelled.
   */
  revise(id: number, spec: ProductionSpec, plan: ShotPlan[], changed: string[]): number | null {
    const p = this.get(id);
    if (!p || p.state === "approved" || p.state === "cancelled") return null;
    const keep = new Map(this.shots(id).filter((s) => s.state === "done" && !changed.includes(s.shotId)).map((s) => [s.shotId, s]));
    const revision = p.revision + 1;
    this.db.exec("BEGIN");
    try {
      // The old revision's unfinished shots stop; a running one finishes onto its own (now stale) row.
      this.db.prepare("UPDATE shots SET state = 'cancelled' WHERE production_id = ? AND revision = ? AND state = 'queued'").run(id, p.revision);
      this.db.prepare(
        `UPDATE productions SET spec = ?, revision = ?, state = 'queued', progress = 0, output_path = NULL, preview_path = NULL,
         thumb_path = NULL, duration_sec = NULL, error = NULL, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(spec), revision, Date.now(), id);
      this.insertShots(id, revision, plan, keep);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return revision;
  }

  /** Stops a production that isn't approved; its unfinished shots are cancelled. */
  cancel(id: number): boolean {
    const p = this.get(id);
    if (!p || p.state === "approved" || p.state === "cancelled") return false;
    this.db.prepare("UPDATE shots SET state = 'cancelled', updated_at = ? WHERE production_id = ? AND state IN ('queued', 'running')").run(Date.now(), id);
    this.setState(id, { state: "cancelled" });
    return true;
  }

  /** The user turned the ready revision down. Returns false unless it was ready. */
  reject(id: number, revision: number): boolean {
    const { changes } = this.db.prepare("UPDATE productions SET state = 'rejected', updated_at = ? WHERE id = ? AND revision = ? AND state = 'ready'").run(Date.now(), id, revision);
    return changes > 0;
  }

  approve(id: number, postId: number) {
    this.db.prepare("UPDATE productions SET state = 'approved', approved_at = ?, post_id = ?, updated_at = ? WHERE id = ? AND state = 'ready'").run(Date.now(), postId, Date.now(), id);
  }

  /** After a quit or crash: running shots start over, and an interrupted assembly is redone. */
  requeueInterrupted() {
    this.db.prepare("UPDATE shots SET state = 'queued', progress = 0 WHERE state = 'running'").run();
    this.db.prepare("UPDATE productions SET state = 'rendering' WHERE state = 'assembling'").run();
  }

  cached(key: string): { path: string; durationSec: number } | undefined {
    const r = this.db.prepare("SELECT output_path, duration_sec FROM shot_cache WHERE input_key = ?").get(key) as any;
    return r ? { path: r.output_path, durationSec: r.duration_sec } : undefined;
  }

  putCache(key: string, path: string, durationSec: number) {
    this.db.prepare("INSERT OR REPLACE INTO shot_cache VALUES (?, ?, ?, ?)").run(key, path, durationSec, Date.now());
  }

  dropCache(key: string) {
    this.db.prepare("DELETE FROM shot_cache WHERE input_key = ?").run(key);
  }
}
