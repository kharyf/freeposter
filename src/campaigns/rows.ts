// The campaign table: what the Campaigns tab edits (and an Autorun agent sends), one row per kind of video. Rows
// compile into the day-by-day schedule the worker runs. A row the table can hold but can't run yet (no days ticked,
// a Drive row with no file name or time, a Create row with no length, a Lemo style with no Claude model to write it) is
// kept as it is and left out of the schedule.
import { LOOK_KEY } from "./looks.ts";
import { DAYS, isModelId, type CompiledCampaign, type Day, type MakeInstruction, type PostInstruction, type Vocabulary } from "./spec.ts";

export type RowPick = { pick: "random" } | { pick: "best" } | { pick: "named"; id: number };

export interface Row {
  /** stable within its campaign (a task names the row it came from by this id) */
  id: number;
  /** videos to make (Create; a Drive row posts its file once) */
  quantity: number;
  hook: RowPick;
  angle: RowPick;
  cta: RowPick;
  /**
   * The editing style: a FreePoster style id, or a Lemo style (a looks catalogue key like "lemo:ukiyo-e"), which the
   * lemo-opuscar skill makes the film in. Null only on an Agent row whose style hasn't been chosen.
   */
  style: string | null;
  /** the AI model (`provider:model`) that writes it; null means the AI settings' choice (Create) or Claude Code's own setting (Agent) */
  model: string | null;
  /** a video type id, or none */
  type: number | null;
  /** 24-hour "HH:MM" it posts at, or null: a Create video made and kept, not posted */
  time: string | null;
  days: Day[];
  /** seconds: a Create video's length; a Drive row's, recorded for analytics. Null until it's filled in. */
  sec: number | null;
  origin: "create" | "drive" | "agent";
  /** Drive: the file name (the `{name}` part of the Drive filename). Create and Agent: instructions for the script writer or the agent. */
  text: string;
}

export const ROWS_MAX = 100;
export const QTY_MIN = 1, QTY_MAX = 10;
export const SEC_MIN = 5, SEC_MAX = 300;
export const ROW_TEXT_MAX = 2000;
/** A row's tasks number their instructions from here (this + the row's id), apart from older line-indexed tasks. */
export const ROW_INSTRUCTION_BASE = 100_000;
/** The next row id to hand out: one counter for every campaign, so a row id is never reused. */
export const ROW_ID_PREF = "campaigns.rowId.next";
/** Set once the ids rows had per campaign were renumbered from the global counter. */
export const ROW_IDS_MIGRATED_PREF = "campaigns.rowIds.v1";
/** How a row's id is shown: seven hex digits, or "new" for a row not saved yet (id <= 0). */
export const rowIdHex = (id: number): string => (id <= 0 ? "new" : id.toString(16).padStart(7, "0"));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const KEYS = ["id", "quantity", "hook", "angle", "cta", "style", "model", "type", "time", "days", "sec", "origin", "text"];

/** A Lemo style (a looks catalogue key), not a FreePoster editing style id (which never contains ":"). */
export const isLemo = (style: string | null): boolean => style !== null && style.startsWith("lemo:");
/** A Claude model run by the Claude program (an OpenRouter "anthropic/..." model doesn't count). */
export const isClaudeModel = (model: string | null): boolean => model !== null && model.startsWith("claude:");

/**
 * A row as saved before the Lemo style moved into `style`: an Agent row's `look` becomes its style (any FreePoster
 * style it had is dropped), `look` goes, and a missing `model` is null. A row already in today's shape is unchanged.
 */
export function migrateRow(raw: Record<string, unknown>): Record<string, unknown> {
  const { look, ...out } = raw;
  if (raw.origin === "agent" && look !== undefined && look !== null) out.style = look;
  if (out.model === undefined) out.model = null;
  return out;
}

/**
 * The strict check of a table. Unknown fields are refused; every problem is collected. On success, a normalized copy,
 * with a warning for each row sent in the old shape (with "look").
 */
export function parseRows(raw: unknown, vocab: Vocabulary): { ok: true; value: Row[]; warnings: string[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, problems: ["rows must be a list"] };
  if (raw.length > ROWS_MAX) return { ok: false, problems: [`at most ${ROWS_MAX} rows`] };
  const ids = new Set<number>();
  const value: Row[] = [];
  raw.forEach((sent, i) => {
    const at = `row ${i + 1}`;
    const problem = (msg: string) => problems.push(`${at}: ${msg}`);
    if (!isObj(sent)) return problem("must be an object");
    if ("look" in sent) {
      warnings.push(`${at}: "look" is now part of "style"; send the Lemo style as style`);
      if (sent.look !== null && (typeof sent.look !== "string" || !LOOK_KEY.test(sent.look))) problem('look must be a Lemo style like "lemo:ukiyo-e", or null');
      else if (sent.look !== null && sent.origin !== "agent") problem("only an Agent row had a look; send the Lemo style as style");
    }
    const r = migrateRow(sent);
    for (const k of Object.keys(r)) if (!KEYS.includes(k)) problem(`unknown field "${k}"`);
    const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
    if (!int(r.id, 1, 1_000_000_000)) problem("id must be a whole number from 1");
    else if (ids.has(r.id as number)) problem(`id ${String(r.id)} is used twice`);
    else ids.add(r.id as number);
    if (!int(r.quantity, QTY_MIN, QTY_MAX)) problem(`quantity must be a whole number from ${QTY_MIN} to ${QTY_MAX}`);
    const pick = (v: unknown, kind: "hook" | "angle" | "cta", library: Vocabulary["hooks"]): RowPick => {
      const word = kind === "cta" ? "CTA" : kind;
      if (!isObj(v)) { problem(`${word} must be like {"pick": "random"}`); return { pick: "random" }; }
      if (v.pick === "random" || v.pick === "best") {
        if (Object.keys(v).length !== 1) problem(`${word}: only "pick" is allowed with ${v.pick}`);
        return { pick: v.pick };
      }
      if (v.pick === "named") {
        if (Object.keys(v).some((k) => k !== "pick" && k !== "id")) problem(`${word}: only "pick" and "id" are allowed`);
        if (typeof v.id !== "number" || !library.some((e) => e.id === v.id)) problem(`no ${word} in the library with id ${String(v.id)}`);
        return { pick: "named", id: v.id as number };
      }
      problem(`${word}.pick must be random, best or named`);
      return { pick: "random" };
    };
    const hook = pick(r.hook, "hook", vocab.hooks), angle = pick(r.angle, "angle", vocab.angles), cta = pick(r.cta, "cta", vocab.ctas);
    const agentRow = r.origin === "agent";
    // A Lemo style is checked against the catalogue by rowIssues: one that left it is kept, and reported.
    const style = (r.style === null || r.style === undefined) && agentRow ? null
      : typeof r.style !== "string" ? undefined
      : isLemo(r.style) && LOOK_KEY.test(r.style) ? r.style
      : vocab.styles.find((s) => s.id.toLowerCase() === (r.style as string).toLowerCase())?.id;
    if (style === undefined) problem(`style must be one of the editing styles (${vocab.styles.map((s) => s.id).join(", ")}) or a Lemo style like "lemo:ukiyo-e"`);
    if (r.model !== null && !isModelId(r.model)) problem('model must be a model id like "claude:claude-opus-5-5", or null');
    // Compacted results drop null and empty fields, so a missing one reads as null (text: "").
    if (r.type !== null && r.type !== undefined && !(typeof r.type === "number" && vocab.types.some((t) => t.id === r.type))) problem(`no video type with id ${String(r.type)}`);
    if (r.time !== null && r.time !== undefined && !(typeof r.time === "string" && TIME.test(r.time))) problem('time must be a 24-hour "HH:MM" time, or null');
    let days: Day[] = [];
    if (!Array.isArray(r.days) || r.days.some((d) => !DAYS.includes(d as Day))) problem(`days must be a list of ${DAYS.join(", ")}`);
    else days = DAYS.filter((d) => (r.days as unknown[]).includes(d)); // Sunday first, each once
    if (r.sec !== null && r.sec !== undefined && !int(r.sec, SEC_MIN, SEC_MAX)) problem(`length must be a whole number of seconds from ${SEC_MIN} to ${SEC_MAX}, or null`);
    if (r.origin !== "create" && r.origin !== "drive" && r.origin !== "agent") problem('origin must be "create", "drive" or "agent"');
    let text = "";
    if (r.text === undefined) text = "";
    else if (typeof r.text !== "string" || r.text.length > ROW_TEXT_MAX) problem(`text must be text of at most ${ROW_TEXT_MAX} characters`);
    else text = r.text;
    if (r.origin === "drive" && text.includes("_")) problem("a Drive file name is the part before the first underscore, so it can't contain one");
    value.push({
      id: r.id as number, quantity: r.quantity as number, hook, angle, cta, style: style === undefined ? String(r.style) : style, model: r.model as string | null,
      type: (r.type as number | null) ?? null, time: (r.time as string | null) ?? null, days, sec: (r.sec as number | null) ?? null, origin: r.origin as Row["origin"], text,
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, value, warnings };
}

/** Why a row isn't in the schedule yet; empty when it runs. */
export function rowIssues(r: Row, vocab?: Vocabulary): string[] {
  const out: string[] = [];
  if (!r.days.length) out.push("no days ticked");
  if (r.origin === "drive") {
    if (!r.text.trim()) out.push("no file name");
    if (r.time === null) out.push("a Drive video needs a time");
  } else if (r.sec === null) out.push("no length");
  const lemo = isLemo(r.style);
  if (r.origin === "agent") {
    if (r.style === null) out.push("no editing style");
    else if (!lemo) out.push("an Agent row needs a Lemo style");
    if (r.model !== null && !isClaudeModel(r.model)) out.push("an Agent row needs a Claude model");
  }
  if (r.origin === "create" && lemo && !isClaudeModel(r.model)) out.push("Lemo styles need a Claude model");
  if (r.origin === "drive" && lemo) out.push("Drive videos can't use a Lemo style");
  if (lemo && vocab?.looks) {
    // An empty catalogue alone decides (one filled by sync_looks runs without the library on this computer). The
    // server can't tell whether the library is installed, so it says so; the browser refines the wording when it is.
    if (!vocab.looks.length) out.push("Lemo-Opuscar isn't installed on this computer");
    else if (!vocab.looks.some((l) => l.key === r.style)) out.push(`${r.style} is no longer in Lemo-Opuscar`);
  }
  if (r.origin !== "drive" && r.model !== null && vocab?.models && !vocab.models.includes(r.model)) out.push(`${r.model} isn't available; pick another model`);
  return out;
}

const empty = (): CompiledCampaign => ({ version: 1, days: Object.fromEntries(DAYS.map((d) => [d, []])) as unknown as CompiledCampaign["days"], rules: [] });

/** The schedule a table runs: each runnable row on each of its days, in table order. */
export function compileRows(rows: Row[], vocab?: Vocabulary): CompiledCampaign {
  const out = empty();
  rows.forEach((r, i) => {
    if (rowIssues(r, vocab).length) return;
    const source = `table row ${i + 1}`;
    const types = r.type === null ? [] : [r.type];
    const ins: MakeInstruction | PostInstruction = r.origin !== "drive"
      ? {
        kind: "make", count: r.quantity, ...(isLemo(r.style) ? { style: null, look: r.style! } : { style: r.style }),
        ...(isLemo(r.style) && r.origin === "create" ? { scripted: true as const } : {}), ...(r.model !== null ? { model: r.model } : {}),
        sec: r.sec, hook: { ...r.hook }, angle: { ...r.angle }, cta: { ...r.cta }, types,
        post: r.time === null ? null : { at: r.time }, source, row: r.id, ...(r.text.trim() ? { instructions: r.text.trim() } : {}),
      }
      : {
        kind: "post", name: r.text.trim(), at: r.time, style: r.style, types, source, row: r.id,
        hook: { ...r.hook }, angle: { ...r.angle }, cta: { ...r.cta }, sec: r.sec,
      };
    for (const d of r.days) out.days[d].push(structuredClone(ins));
  });
  return out;
}

/** A schedule with nothing in it (a new campaign's, or an empty table's). */
export const emptyCompiled = empty;
