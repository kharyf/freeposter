// Campaigns: the library of hooks/angles/CTAs, video types, campaigns (text plus its confirmed compiled schedule),
// the daily tasks they materialize, rule firings and the Autorun audit log.
import { createHash } from "node:crypto";
import type { Store } from "../db.ts";
import type { DriveFileRecord } from "../types.ts";
import { compileRows, type Row } from "./rows.ts";
import type { CompiledCampaign } from "./spec.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  owner_campaign_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS video_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  auto_post INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  text_sha TEXT NOT NULL,
  compiled TEXT,
  compiled_sha TEXT,
  confirmed_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  autorun INTEGER NOT NULL DEFAULT 0,
  account_set_id INTEGER,
  default_post_times TEXT NOT NULL DEFAULT '[]',
  daily_post_cap INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_tasks (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  day_index INTEGER NOT NULL,
  instruction_index INTEGER NOT NULL,
  copy INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  choices TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'queued',
  production_id INTEGER,
  edit_id INTEGER,
  review_id INTEGER,
  post_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (campaign_id, date, instruction_index, copy)
);
CREATE INDEX IF NOT EXISTS campaign_tasks_state ON campaign_tasks(state);
CREATE TABLE IF NOT EXISTS rule_firings (
  campaign_id INTEGER NOT NULL,
  rule_index INTEGER NOT NULL,
  matched_key TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, rule_index, matched_key)
);
CREATE TABLE IF NOT EXISTS campaign_changes (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  at INTEGER NOT NULL,
  before TEXT NOT NULL,
  after TEXT NOT NULL,
  reason TEXT NOT NULL,
  undone_at INTEGER
);
CREATE INDEX IF NOT EXISTS campaign_changes_campaign ON campaign_changes(campaign_id);
`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type LibraryKind = "hook" | "angle" | "cta";

export interface LibraryEntry {
  id: number;
  kind: LibraryKind;
  name: string;
  text: string;
  keywords: string[];
  url: string | null;
  /**
   * The campaign whose Autorun added it: only that campaign's random and best picks use it, and no other campaign's
   * agent may name it. Null (or absent in older snapshots) = the user's own, for every campaign.
   */
  ownerCampaignId?: number | null;
  createdAt: number;
}

export interface VideoType {
  id: number;
  name: string;
  color: string;
  autoPost: boolean;
  createdAt: number;
}

export interface Campaign {
  id: number;
  name: string;
  /** the table the Campaigns tab edits; its compiled schedule is what runs */
  rows: Row[];
  text: string;
  textSha: string;
  compiled: CompiledCampaign | null;
  compiledSha: string | null;
  confirmedAt: number | null;
  enabled: boolean;
  autorun: boolean;
  accountSetId: number | null;
  defaultPostTimes: string[];
  dailyPostCap: number;
  createdAt: number;
  updatedAt: number;
}

export type TaskKind = "make" | "post" | "rule";
export type TaskState = "queued" | "scripting" | "rendering" | "editing" | "reviewing" | "scheduled" | "posted" | "kept" | "missed" | "failed";

export interface CampaignTask {
  id: number;
  campaignId: number;
  /** local calendar date, YYYY-MM-DD */
  date: string;
  dayIndex: number;
  instructionIndex: number;
  copy: number;
  kind: TaskKind;
  /** the resolved hook / angle / CTA / style / types for this copy */
  choices: Record<string, unknown>;
  state: TaskState;
  productionId: number | null;
  editId: number | null;
  reviewId: number | null;
  postId: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NewTask = Pick<CampaignTask, "campaignId" | "date" | "dayIndex" | "instructionIndex" | "kind"> &
  Partial<Pick<CampaignTask, "copy" | "choices" | "state" | "productionId" | "editId" | "reviewId" | "postId" | "error">>;

export interface CampaignChange {
  id: number;
  campaignId: number;
  agent: string;
  at: number;
  before: unknown;
  after: unknown;
  reason: string;
  undoneAt: number | null;
}

const toEntry = (r: any): LibraryEntry => ({
  id: r.id, kind: r.kind, name: r.name, text: r.text, keywords: JSON.parse(r.keywords), url: r.url, ownerCampaignId: r.owner_campaign_id ?? null, createdAt: r.created_at,
});
const toType = (r: any): VideoType => ({ id: r.id, name: r.name, color: r.color, autoPost: Boolean(r.auto_post), createdAt: r.created_at });
const toCampaign = (r: any): Campaign => ({
  id: r.id, name: r.name, rows: r.rows ? JSON.parse(r.rows) : [], text: r.text, textSha: r.text_sha, compiled: r.compiled ? JSON.parse(r.compiled) : null,
  compiledSha: r.compiled_sha, confirmedAt: r.confirmed_at, enabled: Boolean(r.enabled), autorun: Boolean(r.autorun),
  accountSetId: r.account_set_id, defaultPostTimes: JSON.parse(r.default_post_times), dailyPostCap: r.daily_post_cap,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toTask = (r: any): CampaignTask => ({
  id: r.id, campaignId: r.campaign_id, date: r.date, dayIndex: r.day_index, instructionIndex: r.instruction_index, copy: r.copy,
  kind: r.kind, choices: JSON.parse(r.choices), state: r.state, productionId: r.production_id, editId: r.edit_id,
  reviewId: r.review_id, postId: r.post_id, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toChange = (r: any): CampaignChange => ({
  id: r.id, campaignId: r.campaign_id, agent: r.agent, at: r.at, before: JSON.parse(r.before), after: JSON.parse(r.after),
  reason: r.reason, undoneAt: r.undone_at,
});

const TASK_COLUMNS: Record<string, string> = {
  state: "state", choices: "choices", productionId: "production_id", editId: "edit_id", reviewId: "review_id",
  postId: "post_id", error: "error", copy: "copy",
};
const ENTRY_COLUMNS: Record<string, string> = { name: "name", text: "text", keywords: "keywords", url: "url" };

const ready = new WeakSet<Store>();

/** The daily post cap every campaign made from the window gets: no longer shown, a safety net only. */
export const HIDDEN_CAP = 100;

/** Enabled, and its compiled schedule was confirmed for its current text. */
/** Whether the confirmed schedule is the one for the campaign's current text (editing the text unconfirms it). */
export const confirmedForText = (c: Campaign) => c.compiledSha !== null && c.compiledSha === c.textSha;
const runnable = (c: Campaign) => c.enabled && confirmedForText(c);

/**
 * Whether a campaign video with these types may post without the user's approval: it has at least one type, and
 * every one of them exists and allows it. Anything else (no types, one that doesn't allow it, one since deleted)
 * waits for approval. Asked when the video goes to review, so a type switched off before then means it waits.
 */
export function mayPostUnseen(cs: CampaignStore, typeIds: number[]): boolean {
  if (!typeIds.length) return false;
  const types = new Map(cs.types().map((t) => [t.id, t]));
  return typeIds.every((id) => types.get(id)?.autoPost === true);
}

/**
 * The campaign task a production or edit belongs to (an edit: itself or any edit it was revised from), or null.
 * Other workers ask, to tell agents that the campaign sends it for review itself.
 */
export function campaignTaskFor(store: Store, kind: "production" | "edit", id: number): number | null {
  if (!ready.has(store)) { store.db.exec(SCHEMA); ready.add(store); }
  if (kind === "production") {
    const r = store.db.prepare("SELECT id FROM campaign_tasks WHERE production_id = ? ORDER BY id LIMIT 1").get(id) as { id: number } | undefined;
    return r?.id ?? null;
  }
  const find = store.db.prepare("SELECT id FROM campaign_tasks WHERE edit_id = ? ORDER BY id LIMIT 1");
  let edit: number | null = id;
  for (let hops = 0; edit !== null && hops < 50; hops++) {
    const r = find.get(edit) as { id: number } | undefined;
    if (r) return r.id;
    edit = store.edit(edit)?.parentEditId ?? null;
  }
  return null;
}

/** The lowercased Drive names a compiled schedule's "post" lines mention. */
const postNames = (c: Campaign): string[] =>
  c.compiled ? Object.values(c.compiled.days).flatMap((lines) => (lines ?? []).flatMap((ins) => (ins.kind === "post" ? [ins.name.toLowerCase()] : []))) : [];

/**
 * The Drive names (the `{name}` part, lowercased) the "post" lines of every enabled campaign's last confirmed
 * schedule mention, each with the first such campaign. Drive intake holds a new file with one of these names for its
 * campaign, so it's never also posted by its filename. A campaign paused for an edit (its text not confirmed yet)
 * still holds by the schedule it last confirmed.
 */
export function heldBy(store: Store): Map<string, { id: number; name: string }> {
  if (!ready.has(store)) { store.db.exec(SCHEMA); ready.add(store); }
  const held = new Map<string, { id: number; name: string }>();
  for (const c of store.db.prepare("SELECT * FROM campaigns ORDER BY id").all().map(toCampaign)) {
    if (!c.enabled) continue;
    for (const name of postNames(c)) if (!held.has(name)) held.set(name, { id: c.id, name: c.name });
  }
  return held;
}

/**
 * The campaign holding this held Drive file, or undefined when none can be found (it was deleted: an orphan). A file
 * held before the holder was recorded is tied to the campaign its note names, else one whose schedule names it.
 */
export function holderOf(store: Store, f: DriveFileRecord): Campaign | undefined {
  if (!ready.has(store)) { store.db.exec(SCHEMA); ready.add(store); }
  const all = store.db.prepare("SELECT * FROM campaigns ORDER BY id").all().map(toCampaign);
  if (f.heldBy != null) return all.find((c) => c.id === f.heldBy);
  const noted = /^held by campaign (.+)$/.exec(f.note ?? "")?.[1];
  const name = (f.choice?.name ?? "").toLowerCase();
  return all.find((c) => c.name === noted) ?? all.find((c) => postNames(c).includes(name));
}

/**
 * The user lets a held Drive file go from its campaign (the Campaigns tab's Release): Drive intake then carries it
 * on by its filename, and it's never held again. A file a campaign task has already taken can't be released.
 */
export function releaseHeldFile(store: Store, driveId: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
  const f = store.driveFile(driveId);
  if (!f || f.state !== "held") return { ok: false, error: "no held Drive file with that id" };
  if (driveFileTaken(store, driveId)) return { ok: false, error: "its campaign has already taken it to post; it can't be released" };
  if (!f.releasedAt) store.upsertDriveFile(driveId, { releasedAt: now });
  return { ok: true };
}

/** The held Drive files a campaign holds, for the Campaigns tab. */
export function filesHeldBy(store: Store, campaignId: number): { driveId: string; name: string; taken: boolean; released: boolean }[] {
  return store.driveFilesIn(["held"]).filter((f) => f.heldBy === campaignId)
    .map((f) => ({ driveId: f.driveId, name: f.name, taken: driveFileTaken(store, f.driveId), released: Boolean(f.releasedAt) }));
}

/** Whether a campaign task has taken this held Drive file to post (in any state since: it's never released). */
export function driveFileTaken(store: Store, driveId: string): boolean {
  if (!ready.has(store)) { store.db.exec(SCHEMA); ready.add(store); }
  return Boolean(store.db.prepare("SELECT 1 FROM campaign_tasks WHERE json_extract(choices, '$.driveId') = ? LIMIT 1").get(driveId));
}

/** The lowercased `{name}`s new Drive files are held for (see heldBy). */
export function heldNames(store: Store): Set<string> {
  return new Set(heldBy(store).keys());
}

export class CampaignStore {
  store: Store;

  constructor(store: Store) {
    this.store = store;
    store.db.exec(SCHEMA);
    const libraryColumns = store.db.prepare("PRAGMA table_info(library)").all() as { name: string }[];
    if (!libraryColumns.some((c) => c.name === "owner_campaign_id")) store.db.exec("ALTER TABLE library ADD COLUMN owner_campaign_id INTEGER");
    const campaignColumns = store.db.prepare("PRAGMA table_info(campaigns)").all() as { name: string }[];
    if (!campaignColumns.some((c) => c.name === "rows")) {
      // The table replaced the plain-English text: every campaign starts with an empty table (the user's choice),
      // so nothing runs from text it no longer shows. Default post times and the daily cap left the window too: the
      // cap stays as a hidden safety net at its highest.
      store.db.exec("BEGIN");
      try {
        store.db.exec("ALTER TABLE campaigns ADD COLUMN rows TEXT");
        store.db.prepare(`UPDATE campaigns SET rows = '[]', compiled = ?, compiled_sha = text_sha, confirmed_at = ?, default_post_times = '[]', daily_post_cap = ?`)
          .run(JSON.stringify(compileRows([])), Date.now(), HIDDEN_CAP);
        store.db.exec("COMMIT");
      } catch (err) {
        store.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  get db() {
    return this.store.db;
  }

  // ---- library ----

  addEntry(e: { kind: LibraryKind; name: string; text: string; keywords?: string[]; url?: string; ownerCampaignId?: number | null }): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO library (kind, name, text, keywords, url, owner_campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(e.kind, e.name, e.text, JSON.stringify(e.keywords ?? []), e.url ?? null, e.ownerCampaignId ?? null, Date.now());
    return Number(lastInsertRowid);
  }

  entries(kind?: LibraryKind): LibraryEntry[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM library WHERE kind = ? ORDER BY id").all(kind)
      : this.db.prepare("SELECT * FROM library ORDER BY id").all();
    return rows.map(toEntry);
  }

  entry(id: number): LibraryEntry | undefined {
    const r = this.db.prepare("SELECT * FROM library WHERE id = ?").get(id);
    return r ? toEntry(r) : undefined;
  }

  updateEntry(id: number, patch: Partial<Pick<LibraryEntry, "name" | "text" | "keywords" | "url">>) {
    this.patch("library", ENTRY_COLUMNS, id, patch, false);
  }

  deleteEntry(id: number) {
    this.db.prepare("DELETE FROM library WHERE id = ?").run(id);
  }

  // ---- video types ----

  addType(t: { name: string; color: string }): number {
    const { lastInsertRowid } = this.db.prepare("INSERT INTO video_types (name, color, created_at) VALUES (?, ?, ?)").run(t.name, t.color, Date.now());
    return Number(lastInsertRowid);
  }

  types(): VideoType[] {
    return this.db.prepare("SELECT * FROM video_types ORDER BY id").all().map(toType);
  }

  setTypeAutoPost(id: number, on: boolean) {
    this.db.prepare("UPDATE video_types SET auto_post = ? WHERE id = ?").run(on ? 1 : 0, id);
  }

  // ---- campaigns ----

  create(c: { name: string; text: string; accountSetId: number | null; defaultPostTimes: string[]; dailyPostCap?: number }): number {
    const now = Date.now();
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO campaigns (name, text, text_sha, account_set_id, default_post_times, daily_post_cap, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.name, c.text, sha(c.text), c.accountSetId, JSON.stringify(c.defaultPostTimes), c.dailyPostCap ?? 3, now, now);
    return Number(lastInsertRowid);
  }

  campaign(id: number): Campaign | undefined {
    const r = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
    return r ? toCampaign(r) : undefined;
  }

  campaigns(): Campaign[] {
    return this.db.prepare("SELECT * FROM campaigns ORDER BY id").all().map(toCampaign);
  }

  /** New text: the old compiled schedule stays stored, but stops being runnable until it is confirmed again. */
  setText(id: number, text: string) {
    this.db.prepare("UPDATE campaigns SET text = ?, text_sha = ?, updated_at = ? WHERE id = ?").run(text, sha(text), Date.now(), id);
  }

  /** The user confirmed this compiled schedule for the campaign's current text. */
  confirm(id: number, compiled: CompiledCampaign) {
    const now = Date.now();
    this.db
      .prepare("UPDATE campaigns SET compiled = ?, compiled_sha = text_sha, confirmed_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(compiled), now, now, id);
  }

  /** The table saved: its schedule is what runs, confirmed at once (the table is the user's own authority). */
  setRows(id: number, rows: Row[]) {
    const now = Date.now();
    this.db
      .prepare("UPDATE campaigns SET rows = ?, compiled = ?, compiled_sha = text_sha, confirmed_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(rows), JSON.stringify(compileRows(rows)), now, now, id);
  }

  setEnabled(id: number, on: boolean) {
    this.db.prepare("UPDATE campaigns SET enabled = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, Date.now(), id);
  }

  setAutorun(id: number, on: boolean) {
    this.db.prepare("UPDATE campaigns SET autorun = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, Date.now(), id);
  }

  setAccountSet(id: number, accountSetId: number | null) {
    this.db.prepare("UPDATE campaigns SET account_set_id = ?, updated_at = ? WHERE id = ?").run(accountSetId, Date.now(), id);
  }

  setDefaultPostTimes(id: number, times: string[]) {
    this.db.prepare("UPDATE campaigns SET default_post_times = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(times), Date.now(), id);
  }

  setDailyPostCap(id: number, cap: number) {
    this.db.prepare("UPDATE campaigns SET daily_post_cap = ?, updated_at = ? WHERE id = ?").run(cap, Date.now(), id);
  }

  /** Undoing an Autorun change: the table, text, compiled schedule (and what it was confirmed for) and cap as they were. */
  restore(id: number, c: Pick<Campaign, "text" | "textSha" | "compiled" | "compiledSha" | "confirmedAt" | "dailyPostCap"> & { rows?: Row[] }) {
    this.db
      .prepare(`UPDATE campaigns SET rows = ?, text = ?, text_sha = ?, compiled = ?, compiled_sha = ?, confirmed_at = ?, daily_post_cap = ?, updated_at = ?
                WHERE id = ?`)
      .run(JSON.stringify(c.rows ?? []), c.text, c.textSha, c.compiled ? JSON.stringify(c.compiled) : null, c.compiledSha, c.confirmedAt, c.dailyPostCap, Date.now(), id);
  }

  isRunnable(c: Campaign): boolean {
    return runnable(c);
  }

  // ---- tasks ----

  /** Materialize one instruction copy for a date; null when it already exists (a day is never materialized twice). */
  addTask(t: NewTask): number | null {
    const now = Date.now();
    const { changes, lastInsertRowid } = this.db
      .prepare(`INSERT OR IGNORE INTO campaign_tasks (campaign_id, date, day_index, instruction_index, copy, kind, choices, state,
                  production_id, edit_id, review_id, post_id, error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.campaignId, t.date, t.dayIndex, t.instructionIndex, t.copy ?? 1, t.kind, JSON.stringify(t.choices ?? {}), t.state ?? "queued",
        t.productionId ?? null, t.editId ?? null, t.reviewId ?? null, t.postId ?? null, t.error ?? null, now, now);
    return changes > 0 ? Number(lastInsertRowid) : null;
  }

  task(id: number): CampaignTask | undefined {
    const r = this.db.prepare("SELECT * FROM campaign_tasks WHERE id = ?").get(id);
    return r ? toTask(r) : undefined;
  }

  tasksOn(campaignId: number, date: string): CampaignTask[] {
    return this.db
      .prepare("SELECT * FROM campaign_tasks WHERE campaign_id = ? AND date = ? ORDER BY instruction_index, copy")
      .all(campaignId, date).map(toTask);
  }

  tasksIn(states: TaskState[]): CampaignTask[] {
    if (!states.length) return [];
    return this.db
      .prepare(`SELECT * FROM campaign_tasks WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY id`)
      .all(...states).map(toTask);
  }

  updateTask(id: number, patch: Partial<Pick<CampaignTask, "state" | "choices" | "productionId" | "editId" | "reviewId" | "postId" | "error" | "copy">>) {
    this.patch("campaign_tasks", TASK_COLUMNS, id, patch, true);
  }

  // ---- rules ----

  /** True the first time a rule fires for a matched key, false after that. */
  ruleFired(campaignId: number, ruleIndex: number, key: string): boolean {
    const { changes } = this.db
      .prepare("INSERT OR IGNORE INTO rule_firings (campaign_id, rule_index, matched_key, fired_at) VALUES (?, ?, ?, ?)")
      .run(campaignId, ruleIndex, key, Date.now());
    return changes > 0;
  }

  /**
   * The hooks, angles and CTAs a "stop using" rule took out of this campaign's random and best picks (pref
   * `campaign.<id>.excluded`). Named lines still use them; the week table warns next to those.
   */
  excluded(campaignId: number): Record<LibraryKind, number[]> {
    const raw = this.store.pref<Partial<Record<LibraryKind, number[]>>>(`campaign.${campaignId}.excluded`) ?? {};
    return { hook: [...(raw.hook ?? [])], angle: [...(raw.angle ?? [])], cta: [...(raw.cta ?? [])] };
  }

  /** A rule stopped using this value: random and best skip it from now on. */
  exclude(campaignId: number, kind: LibraryKind, id: number) {
    const x = this.excluded(campaignId);
    if (x[kind].includes(id)) return;
    x[kind].push(id);
    this.store.setPref(`campaign.${campaignId}.excluded`, x);
  }

  // ---- Autorun audit log ----

  logChange(c: { campaignId: number; agent: string; before: unknown; after: unknown; reason: string }): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO campaign_changes (campaign_id, agent, at, before, after, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(c.campaignId, c.agent, Date.now(), JSON.stringify(c.before), JSON.stringify(c.after), c.reason);
    return Number(lastInsertRowid);
  }

  changes(campaignId: number): CampaignChange[] {
    return this.db.prepare("SELECT * FROM campaign_changes WHERE campaign_id = ? ORDER BY id").all(campaignId).map(toChange);
  }

  change(id: number): CampaignChange | undefined {
    const r = this.db.prepare("SELECT * FROM campaign_changes WHERE id = ?").get(id);
    return r ? toChange(r) : undefined;
  }

  markUndone(id: number) {
    this.db.prepare("UPDATE campaign_changes SET undone_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // ---- global kill switch ----

  killed(): boolean {
    return this.store.pref<boolean>("campaigns.killed") === true;
  }

  setKilled(on: boolean) {
    this.store.setPref("campaigns.killed", on);
  }

  private patch(table: string, columns: Record<string, string>, id: number, patch: Record<string, unknown>, touch: boolean) {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = columns[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(typeof v === "object" && v !== null ? JSON.stringify(v) : (v as string | number | null));
    }
    if (touch) {
      sets.push("updated_at = ?");
      args.push(Date.now());
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }
}
