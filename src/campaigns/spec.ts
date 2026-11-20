// The compiled campaign: what a campaign's plain-English text becomes once the user confirms it. Types only here;
// the strict parser lives with the format code.
import type { LibraryEntry } from "./store.ts";

export type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const DAYS: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type Pick = { pick: "named"; id: number } | { pick: "random" } | { pick: "best" } | { pick: "same_as_rule" };

export interface MakeInstruction {
  kind: "make";
  count: number;
  style: string;
  /** target length in seconds ("30 second ads"), or null/absent to let the script decide */
  sec?: number | null;
  hook: Pick;
  angle: Pick;
  cta: Pick;
  types: number[];
  post: { at: string } | null;
  source: string;
  /** extra direction for the script writer (a table row's Instructions) */
  instructions?: string;
  /** the table row it came from */
  row?: number;
}

export interface PostInstruction {
  kind: "post";
  name: string;
  at: string | null;
  style: string | null;
  types: number[];
  source: string;
  /** the table row it came from */
  row?: number;
  /** a table row's labels for the recorded video's analytics: only a named pick labels it */
  hook?: Pick;
  angle?: Pick;
  cta?: Pick;
  /** a table row's length, recorded for analytics */
  sec?: number | null;
}

export interface Rule {
  when: {
    label: "hook" | "angle" | "cta" | "style" | "type";
    is: "working" | "not_working";
    thresholdPct: number;
    minVideos: number;
    age: "24h" | "72h" | "7d";
    scope: "campaign" | "account";
  };
  then: { kind: "make"; count: number; keep: string[]; vary: string[]; post: boolean } | { kind: "stop_using" };
  source: string;
}

export interface CompiledCampaign {
  version: 1;
  days: Record<Day, (MakeInstruction | PostInstruction)[]>;
  rules: Rule[];
}

/** What the compiler may name: the user's styles, types and library. */
export interface Vocabulary {
  styles: { id: string; token: string }[];
  /** the editing style a make line takes when it names none (the user's default) */
  defaultStyle?: string;
  types: { id: number; name: string }[];
  hooks: LibraryEntry[];
  angles: LibraryEntry[];
  ctas: LibraryEntry[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LABELS = ["hook", "angle", "cta", "style", "type"];

/**
 * The strict check of a compiled campaign (the compiler's output, or a stored one). Unknown fields are refused and
 * every problem is collected, with a path like `days.tue[0].hook`. On success the value is a normalized deep copy.
 */
export function parseCompiled(raw: unknown, vocab: Vocabulary): { ok: true; value: CompiledCampaign } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const problem = (msg: string) => problems.push(msg);
  const only = (o: Obj, allowed: string[], where: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) problem(`${where}${where ? "." : ""}unknown field "${k}"`);
  };
  const intIn = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], where: string): T => {
    if (typeof v !== "string" || !allowed.includes(v as T)) { problem(`${where} must be one of ${allowed.join(", ")}`); return allowed[0]; }
    return v as T;
  };
  const source = (o: Obj, where: string): string => {
    if (typeof o.source !== "string") { problem(`${where}.source must be a string`); return ""; }
    return o.source;
  };
  const time = (v: unknown, where: string, allowDefault: boolean): string => {
    if (typeof v === "string" && (TIME.test(v) || (allowDefault && v === "default"))) return v;
    problem(`${where} must be a 24-hour "HH:MM" time${allowDefault ? ' or "default"' : ""}`);
    return "00:00";
  };
  const style = (v: unknown, where: string): string => {
    const hit = typeof v === "string" ? vocab.styles.find((s) => s.id.toLowerCase() === v.toLowerCase()) : undefined;
    if (!hit) { problem(`${where} is not one of the styles (${vocab.styles.map((s) => s.id).join(", ")})`); return typeof v === "string" ? v : ""; }
    return hit.id;
  };
  // A make line's target length: absent and null both mean "let the script decide"; a number is a whole 5-300 seconds.
  const targetSec = (v: unknown, where: string): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 5 || v > 300) { problem(`${where} must be a whole number of seconds from 5 to 300, or null`); return null; }
    return v;
  };
  const rowId = (v: unknown, where: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!intIn(v, 1, 1_000_000_000)) problem(`${where} must be a table row id`);
    return v as number;
  };
  const types = (v: unknown, where: string): number[] => {
    if (!Array.isArray(v)) { problem(`${where} must be a list of video type ids`); return []; }
    return v.map((id, i) => {
      if (typeof id !== "number" || !vocab.types.some((t) => t.id === id)) problem(`${where}[${i}]: no video type with id ${String(id)}`);
      return id as number;
    });
  };
  const pick = (v: unknown, where: string, library: LibraryEntry[], kindName: string): Pick => {
    if (!isObj(v)) { problem(`${where} must be an object like {"pick": "random"}`); return { pick: "random" }; }
    const p = v.pick;
    if (p === "named") {
      only(v, ["pick", "id"], where);
      if (typeof v.id !== "number" || !library.some((e) => e.id === v.id)) problem(`${where}: no ${kindName} in the library with id ${String(v.id)}`);
      return { pick: "named", id: v.id as number };
    }
    if (p === "random" || p === "best") { only(v, ["pick"], where); return { pick: p }; }
    if (p === "same_as_rule") {
      problem(`${where}: same_as_rule is only valid in instructions made by a rule`);
      return { pick: "same_as_rule" };
    }
    problem(`${where}.pick must be one of named, random, best`);
    return { pick: "random" };
  };

  const days = Object.fromEntries(DAYS.map((d) => [d, [] as (MakeInstruction | PostInstruction)[]])) as CompiledCampaign["days"];
  let namedCta = false;

  const instruction = (o: unknown, where: string): MakeInstruction | PostInstruction | null => {
    if (!isObj(o)) { problem(`${where} must be an object`); return null; }
    if (o.kind === "make") {
      only(o, ["kind", "count", "style", "sec", "hook", "angle", "cta", "types", "post", "source", "instructions", "row"], where);
      if (!intIn(o.count, 1, 20)) problem(`${where}.count must be a whole number from 1 to 20`);
      let post: { at: string } | null = null;
      if (o.post !== null) {
        if (!isObj(o.post)) problem(`${where}.post must be null or {"at": "HH:MM"}`);
        else { only(o.post, ["at"], `${where}.post`); post = { at: time(o.post.at, `${where}.post.at`, true) }; }
      }
      const cta = pick(o.cta, `${where}.cta`, vocab.ctas, "CTA");
      if (cta.pick === "named") namedCta = true;
      const out: MakeInstruction = {
        kind: "make", count: o.count as number, style: style(o.style, `${where}.style`),
        hook: pick(o.hook, `${where}.hook`, vocab.hooks, "hook"), angle: pick(o.angle, `${where}.angle`, vocab.angles, "angle"), cta,
        types: types(o.types, `${where}.types`), post, source: source(o, where),
      };
      const sec = targetSec(o.sec, `${where}.sec`);
      if (sec !== undefined) out.sec = sec;
      if (o.instructions !== undefined) {
        if (typeof o.instructions !== "string" || o.instructions.length > 2000) problem(`${where}.instructions must be text of at most 2000 characters`);
        else if (o.instructions.trim()) out.instructions = o.instructions.trim();
      }
      const row = rowId(o.row, `${where}.row`);
      if (row !== undefined) out.row = row;
      return out;
    }
    if (o.kind === "post") {
      only(o, ["kind", "name", "at", "style", "types", "source", "row", "hook", "angle", "cta", "sec"], where);
      if (typeof o.name !== "string" || !o.name.trim() || o.name.includes("_")) problem(`${where}.name must be non-empty and contain no underscore`);
      const out: PostInstruction = {
        kind: "post", name: typeof o.name === "string" ? o.name : "",
        at: o.at === null ? null : time(o.at, `${where}.at`, false),
        style: o.style === null ? null : style(o.style, `${where}.style`),
        types: types(o.types, `${where}.types`), source: source(o, where),
      };
      const row = rowId(o.row, `${where}.row`);
      if (row !== undefined) out.row = row;
      if (o.hook !== undefined) out.hook = pick(o.hook, `${where}.hook`, vocab.hooks, "hook");
      if (o.angle !== undefined) out.angle = pick(o.angle, `${where}.angle`, vocab.angles, "angle");
      if (o.cta !== undefined) out.cta = pick(o.cta, `${where}.cta`, vocab.ctas, "CTA");
      const sec = targetSec(o.sec, `${where}.sec`);
      if (sec !== undefined) out.sec = sec;
      return out;
    }
    problem(`${where}.kind must be "make" or "post"`);
    return null;
  };

  const rules: Rule[] = [];
  let needsCta = false;
  const parseRule = (o: unknown, where: string): Rule | null => {
    if (!isObj(o)) { problem(`${where} must be an object`); return null; }
    only(o, ["when", "then", "source"], where);
    let when: Rule["when"] = { label: "hook", is: "working", thresholdPct: 1, minVideos: 1, age: "24h", scope: "campaign" };
    if (!isObj(o.when)) problem(`${where}.when must be an object`);
    else {
      const w = o.when;
      only(w, ["label", "is", "thresholdPct", "minVideos", "age", "scope"], `${where}.when`);
      if (typeof w.thresholdPct !== "number" || !Number.isFinite(w.thresholdPct) || w.thresholdPct < 1 || w.thresholdPct > 99) problem(`${where}.when.thresholdPct must be a number from 1 to 99`);
      if (!intIn(w.minVideos, 1, 100)) problem(`${where}.when.minVideos must be a whole number from 1 to 100`);
      when = {
        label: oneOf(w.label, ["hook", "angle", "cta", "style", "type"], `${where}.when.label`),
        is: oneOf(w.is, ["working", "not_working"], `${where}.when.is`),
        thresholdPct: w.thresholdPct as number, minVideos: w.minVideos as number,
        age: oneOf(w.age, ["24h", "72h", "7d"], `${where}.when.age`),
        scope: oneOf(w.scope, ["campaign", "account"], `${where}.when.scope`),
      };
    }
    let then: Rule["then"] = { kind: "stop_using" };
    if (!isObj(o.then)) problem(`${where}.then must be an object`);
    else if (o.then.kind === "stop_using") {
      only(o.then, ["kind"], `${where}.then`);
      // Only hooks, angles and CTAs have random and best pools to stop using a value from.
      if (!["hook", "angle", "cta"].includes(when.label)) problem(`${where}.then: stop using only works for hooks, angles and CTAs`);
    }
    else if (o.then.kind === "make") {
      const t = o.then;
      only(t, ["kind", "count", "keep", "vary", "post"], `${where}.then`);
      needsCta = true;
      if (!intIn(t.count, 1, 20)) problem(`${where}.then.count must be a whole number from 1 to 20`);
      const labels = (v: unknown, key: string): string[] => {
        if (!Array.isArray(v)) { problem(`${where}.then.${key} must be a list of labels`); return []; }
        return v.map((l, i) => {
          if (typeof l !== "string" || !LABELS.includes(l)) problem(`${where}.then.${key}[${i}] must be one of ${LABELS.join(", ")}`);
          return l as string;
        });
      };
      const keep = labels(t.keep, "keep"), vary = labels(t.vary, "vary");
      for (const l of keep) if (vary.includes(l)) problem(`${where}.then: "${l}" is in both keep and vary`);
      if (typeof t.post !== "boolean") problem(`${where}.then.post must be true or false`);
      then = { kind: "make", count: t.count as number, keep, vary, post: t.post === true };
    } else problem(`${where}.then.kind must be "make" or "stop_using"`);
    return { when, then, source: source(o, where) };
  };

  if (!isObj(raw)) return { ok: false, problems: ["the compiled campaign must be a JSON object"] };
  only(raw, ["version", "days", "rules"], "");
  if (raw.version !== 1) problem("version must be 1");
  if (!isObj(raw.days)) problem("days must be an object with one list per day");
  else {
    only(raw.days, DAYS, "days");
    for (const d of DAYS) {
      const list = raw.days[d];
      if (list === undefined) { problem(`days.${d} is missing (use an empty list for a day with nothing)`); continue; }
      if (!Array.isArray(list)) { problem(`days.${d} must be a list`); continue; }
      list.forEach((o, i) => { const ins = instruction(o, `days.${d}[${i}]`); if (ins) days[d].push(ins); });
    }
  }
  if (!Array.isArray(raw.rules)) problem("rules must be a list");
  else raw.rules.forEach((o, i) => { const r = parseRule(o, `rules[${i}]`); if (r) rules.push(r); });
  if (needsCta && !namedCta) problem("a make rule needs a named CTA in the campaign");

  return problems.length ? { ok: false, problems } : { ok: true, value: { version: 1, days, rules } };
}
