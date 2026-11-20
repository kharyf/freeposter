// The campaign table: what the Campaigns tab edits (and an Autorun agent sends), one row per kind of video. Rows
// compile into the day-by-day schedule the worker runs. A row the table can hold but can't run yet (no days ticked,
// a Drive row with no file name or time, a Create row with no length) is kept as it is and left out of the schedule.
import { LOOK_KEY } from "./looks.ts";
import { DAYS, type CompiledCampaign, type Day, type MakeInstruction, type PostInstruction, type Vocabulary } from "./spec.ts";

export type RowPick = { pick: "random" } | { pick: "best" } | { pick: "named"; id: number };

export interface Row {
  /** stable within its campaign (a task names the row it came from by this id) */
  id: number;
  /** videos to make (Create; a Drive row posts its file once) */
  quantity: number;
  hook: RowPick;
  angle: RowPick;
  cta: RowPick;
  /** the editing style id; null only for an Agent row, which has a look instead */
  style: string | null;
  /** a video type id, or none */
  type: number | null;
  /** 24-hour "HH:MM" it posts at, or null: a Create video made and kept, not posted */
  time: string | null;
  days: Day[];
  /** seconds: a Create video's length; a Drive row's, recorded for analytics. Null until it's filled in. */
  sec: number | null;
  origin: "create" | "drive" | "agent";
  /** Agent: the looks catalogue key the film is made in. Null for every other origin. */
  look: string | null;
  /** Drive: the file name (the `{name}` part of the Drive filename). Create and Agent: instructions for the script writer or the agent. */
  text: string;
}

export const ROWS_MAX = 100;
export const QTY_MIN = 1, QTY_MAX = 10;
export const SEC_MIN = 5, SEC_MAX = 300;
export const ROW_TEXT_MAX = 2000;
/** A row's tasks number their instructions from here (this + the row's id), apart from older line-indexed tasks. */
export const ROW_INSTRUCTION_BASE = 100_000;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const KEYS = ["id", "quantity", "hook", "angle", "cta", "style", "type", "time", "days", "sec", "origin", "look", "text"];

/** The strict check of a table. Unknown fields are refused; every problem is collected. On success, a normalized copy. */
export function parseRows(raw: unknown, vocab: Vocabulary): { ok: true; value: Row[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, problems: ["rows must be a list"] };
  if (raw.length > ROWS_MAX) return { ok: false, problems: [`at most ${ROWS_MAX} rows`] };
  const ids = new Set<number>();
  const value: Row[] = [];
  raw.forEach((r, i) => {
    const at = `row ${i + 1}`;
    const problem = (msg: string) => problems.push(`${at}: ${msg}`);
    if (!isObj(r)) return problem("must be an object");
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
    const style = r.style === null && agentRow ? null : typeof r.style === "string" ? vocab.styles.find((s) => s.id.toLowerCase() === (r.style as string).toLowerCase())?.id : undefined;
    if (style === undefined) problem(`style must be one of the editing styles (${vocab.styles.map((s) => s.id).join(", ")})`);
    if (r.type !== null && !(typeof r.type === "number" && vocab.types.some((t) => t.id === r.type))) problem(`no video type with id ${String(r.type)}`);
    if (r.time !== null && !(typeof r.time === "string" && TIME.test(r.time))) problem('time must be a 24-hour "HH:MM" time, or null');
    let days: Day[] = [];
    if (!Array.isArray(r.days) || r.days.some((d) => !DAYS.includes(d as Day))) problem(`days must be a list of ${DAYS.join(", ")}`);
    else days = DAYS.filter((d) => (r.days as unknown[]).includes(d)); // Sunday first, each once
    if (r.sec !== null && !int(r.sec, SEC_MIN, SEC_MAX)) problem(`length must be a whole number of seconds from ${SEC_MIN} to ${SEC_MAX}, or null`);
    if (r.origin !== "create" && r.origin !== "drive" && r.origin !== "agent") problem('origin must be "create", "drive" or "agent"');
    // Rows saved before looks existed have no look field; that reads as no look.
    let look: string | null = null;
    if (r.look !== undefined && r.look !== null) {
      if (typeof r.look !== "string" || !LOOK_KEY.test(r.look)) problem('look must be a looks catalogue key like "lemo:ukiyo-e", or null');
      else if (!agentRow) problem("only an Agent row has a look");
      else look = r.look;
    }
    let text = "";
    if (typeof r.text !== "string" || r.text.length > ROW_TEXT_MAX) problem(`text must be text of at most ${ROW_TEXT_MAX} characters`);
    else text = r.text;
    if (r.origin === "drive" && text.includes("_")) problem("a Drive file name is the part before the first underscore, so it can't contain one");
    value.push({
      id: r.id as number, quantity: r.quantity as number, hook, angle, cta, style: style === undefined ? String(r.style) : style, type: (r.type as number | null) ?? null,
      time: (r.time as string | null) ?? null, days, sec: (r.sec as number | null) ?? null, origin: r.origin as Row["origin"], look, text,
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

/** Why a row isn't in the schedule yet; empty when it runs. */
export function rowIssues(r: Row, vocab?: Vocabulary): string[] {
  const out: string[] = [];
  if (!r.days.length) out.push("no days ticked");
  if (r.origin === "drive") {
    if (!r.text.trim()) out.push("no file name");
    if (r.time === null) out.push("a Drive video needs a time");
  } else {
    if (r.origin === "agent") {
      if (r.look === null) out.push("no look");
      else if (vocab && !(vocab.looks ?? []).some((l) => l.key === r.look)) out.push("look no longer in the catalogue");
    }
    if (r.sec === null) out.push("no length");
  }
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
        kind: "make", count: r.quantity, style: r.style, ...(r.origin === "agent" && r.look !== null ? { look: r.look } : {}), sec: r.sec, hook: { ...r.hook }, angle: { ...r.angle }, cta: { ...r.cta }, types,
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
