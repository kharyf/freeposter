// A production spec: the one JSON document an agent sends to describe a multi-shot video.
// Everything is checked before anything renders, and every problem is reported at once so the agent can fix
// the whole spec in one go. Unknown fields are refused, so a typo fails instead of being silently ignored.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEFAULT_EDIT, type EditSettings } from "../edit/settings.ts";

export const SHOT_KINDS = ["hyperframes", "wan", "blender", "file", "edit"] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

export const LIMITS = { maxShots: 20, minShotSec: 0.5, maxShotSec: 20, maxHtmlBytes: 256 * 1024, maxFileBytes: 4 * 1024 ** 3, maxCrossfadeSec: 2 } as const;

export interface HyperframesShot { id: string; kind: "hyperframes"; duration_sec: number; html: string; assets: string[] }
export interface WanShot { id: string; kind: "wan"; duration_sec: number; prompt: string; negative_prompt: string; image: string | null; seed: number }
export interface BlenderShot { id: string; kind: "blender"; duration_sec: number; template: string; params: Record<string, string | number | boolean>; engine: "eevee" | "cycles" }
export interface FileShot { id: string; kind: "file"; path: string; trim: [number, number] | null }
export interface EditShot { id: string; kind: "edit"; path: string; settings: EditSettings }
export type ShotSpec = HyperframesShot | WanShot | BlenderShot | FileShot | EditShot;

export interface Transition { type: "cut" | "crossfade"; sec: number }
export interface SfxCue { name: string; at_sec: number; gain_db: number }

export interface ProductionSpec {
  version: 1;
  title: string;
  shots: ShotSpec[];
  /** "default" plus "<from>-><to>" overrides */
  transitions: { default: Transition } & Record<string, Transition>;
  audio: { voiceover: string | null };
  sfx: SfxCue[];
  captions: { source: "voiceover" | "none" };
  /** passed through to approve_production, which checks it like publish_video */
  post: Record<string, unknown> | null;
}

export interface TemplateParam {
  type: "string" | "number" | "color" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}
export interface TemplateSchema { description: string; params: Record<string, TemplateParam> }

/** What a spec is checked against: the Blender templates installed and the SFX library's names. */
export interface SpecContext { templates: Record<string, TemplateSchema>; sfx: string[] }

export class SpecError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`the production spec has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

/** /mnt/c/clips/a.mp4 → C:\clips\a.mp4 (an agent running under WSL); anything else as given. */
export function toWindowsPath(p: string): string {
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? "\\").replace(/\//g, "\\")}` : p;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const COLOR = /^#[0-9a-fA-F]{6}$/;

export function parseSpec(raw: unknown, ctx: SpecContext): ProductionSpec {
  const problems: string[] = [];
  const problem = (msg: string) => problems.push(msg);
  const only = (o: Obj, allowed: string[], where: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) problem(`${where}unknown field "${k}"`);
  };
  const num = (o: Obj, key: string, where: string, min: number, max: number, fallback?: number): number => {
    const v = o[key];
    if (v === undefined && fallback !== undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      problem(`${where}${key} must be a number from ${min} to ${max}`);
      return fallback ?? min;
    }
    return v;
  };
  const text = (o: Obj, key: string, where: string, required: boolean): string => {
    const v = o[key];
    if (v === undefined || v === null) {
      if (required) problem(`${where}${key} is required`);
      return "";
    }
    if (typeof v !== "string") { problem(`${where}${key} must be a string`); return ""; }
    if (required && !v.trim()) problem(`${where}${key} is required`);
    return v;
  };
  const file = (o: Obj, key: string, where: string, required: boolean): string | null => {
    const given = text(o, key, where, required);
    if (!given) return null;
    const p = toWindowsPath(given);
    if (!isAbsolute(p)) { problem(`${where}${key} must be an absolute path on this computer (got ${given})`); return null; }
    try {
      const st = statSync(p);
      if (!st.isFile()) throw new Error();
      if (st.size > LIMITS.maxFileBytes) problem(`${where}${key} is larger than 4 GB`);
    } catch {
      problem(`${where}${key}: no file at ${p}`);
    }
    return p;
  };

  if (!isObj(raw)) throw new SpecError(["the spec must be a JSON object"]);
  only(raw, ["version", "title", "shots", "transitions", "audio", "sfx", "captions", "post"], "");
  if (raw.version !== undefined && raw.version !== 1) problem("version must be 1");

  const shots: ShotSpec[] = [];
  const rawShots = Array.isArray(raw.shots) ? raw.shots : [];
  if (!Array.isArray(raw.shots) || rawShots.length < 1 || rawShots.length > LIMITS.maxShots) problem(`shots must be a list of 1 to ${LIMITS.maxShots} shots`);
  const seen = new Set<string>();
  rawShots.forEach((s: unknown, i: number) => {
    if (!isObj(s)) { problem(`shot ${i + 1} must be an object`); return; }
    const id = typeof s.id === "string" ? s.id : "";
    const at = `${id || `shot ${i + 1}`}: `;
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) problem(`${at}id must be 1 to 40 letters, digits or "-"`);
    else if (seen.has(id)) problem(`duplicate shot id "${id}"`);
    seen.add(id);
    const duration = () => num(s, "duration_sec", at, LIMITS.minShotSec, LIMITS.maxShotSec);
    switch (s.kind) {
      case "hyperframes": {
        only(s, ["id", "kind", "duration_sec", "html", "assets"], at);
        const sec = duration();
        const html = text(s, "html", at, true);
        if (html) checkComposition(html, sec, at, problem);
        const assets = Array.isArray(s.assets) ? s.assets : s.assets === undefined ? [] : (problem(`${at}assets must be a list of paths`), []);
        shots.push({ id, kind: "hyperframes", duration_sec: sec, html, assets: assets.map((_: unknown, j: number) => file(assets as unknown as Obj, String(j), `${at}assets `, true) ?? "") });
        break;
      }
      case "wan": {
        only(s, ["id", "kind", "duration_sec", "prompt", "negative_prompt", "image", "seed"], at);
        shots.push({
          id, kind: "wan", duration_sec: duration(), prompt: text(s, "prompt", at, true), negative_prompt: text(s, "negative_prompt", at, false),
          image: file(s, "image", at, false), seed: s.seed === undefined ? -1 : Math.round(num(s, "seed", at, -1, 2 ** 31 - 1)),
        });
        break;
      }
      case "blender": {
        only(s, ["id", "kind", "duration_sec", "template", "params", "engine"], at);
        const sec = duration();
        const name = text(s, "template", at, true);
        const schema = ctx.templates[name];
        if (name && !schema) problem(`${at}unknown template "${name}"; describe_production_tools lists them`);
        const engine = s.engine === undefined ? "eevee" : s.engine;
        if (engine !== "eevee" && engine !== "cycles") problem(`${at}engine must be "eevee" or "cycles"`);
        shots.push({ id, kind: "blender", duration_sec: sec, template: name, params: schema ? templateParams(s.params, schema, at, problem) : {}, engine: engine as "eevee" | "cycles" });
        break;
      }
      case "file": {
        only(s, ["id", "kind", "path", "trim"], at);
        let trim: [number, number] | null = null;
        if (s.trim !== undefined && s.trim !== null) {
          const t = s.trim;
          if (Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === "number" && x >= 0) && t[1] - t[0] >= LIMITS.minShotSec) trim = [t[0], t[1]];
          else problem(`${at}trim must be [start, end] in seconds, at least ${LIMITS.minShotSec} s apart`);
        }
        shots.push({ id, kind: "file", path: file(s, "path", at, true) ?? "", trim });
        break;
      }
      case "edit": {
        only(s, ["id", "kind", "path", "settings"], at);
        let settings = { ...DEFAULT_EDIT };
        if (s.settings !== undefined && s.settings !== null) {
          if (!isObj(s.settings)) problem(`${at}settings must be an object`);
          else for (const [k, v] of Object.entries(s.settings)) {
            if (!(k in DEFAULT_EDIT)) problem(`${at}settings: unknown field "${k}"`);
            else if (typeof v !== "boolean") problem(`${at}settings.${k} must be true or false`);
            else settings = { ...settings, [k]: v };
          }
        }
        shots.push({ id, kind: "edit", path: file(s, "path", at, true) ?? "", settings });
        break;
      }
      default:
        problem(`${at}kind must be one of ${SHOT_KINDS.join(", ")}`);
    }
  });

  const transitions = { default: { type: "cut", sec: 0 } as Transition } as ProductionSpec["transitions"];
  if (raw.transitions !== undefined && raw.transitions !== null) {
    if (!isObj(raw.transitions)) problem("transitions must be an object");
    else for (const [key, v] of Object.entries(raw.transitions)) {
      const where = `transitions.${key}: `;
      if (key !== "default") {
        const [from, to] = key.split("->");
        if (!seen.has(from) || !seen.has(to)) { problem(`${where}name two shot ids as "<from>-><to>"`); continue; }
      }
      const t = parseTransition(v, where, problem);
      if (t) transitions[key] = t;
    }
  }

  const audio = { voiceover: null as string | null };
  if (raw.audio !== undefined) {
    if (!isObj(raw.audio)) problem("audio must be an object");
    else {
      only(raw.audio, ["voiceover"], "audio: ");
      audio.voiceover = file(raw.audio, "voiceover", "audio: ", false);
    }
  }

  const sfx: SfxCue[] = [];
  if (raw.sfx !== undefined) {
    if (!Array.isArray(raw.sfx)) problem("sfx must be a list of cues");
    else raw.sfx.forEach((c: unknown, i: number) => {
      const where = `sfx ${i + 1}: `;
      if (!isObj(c)) { problem(`${where}must be an object`); return; }
      only(c, ["name", "at_sec", "gain_db"], where);
      const name = text(c, "name", where, true);
      if (name && !ctx.sfx.includes(name)) problem(`unknown sound effect "${name}"; describe_production_tools lists the library`);
      sfx.push({ name, at_sec: num(c, "at_sec", where, 0, 600), gain_db: num(c, "gain_db", where, -60, 12, 0) });
    });
  }

  const captions = { source: "none" as "voiceover" | "none" };
  if (raw.captions !== undefined) {
    if (!isObj(raw.captions) || (raw.captions.source !== "voiceover" && raw.captions.source !== "none")) problem('captions must be {"source": "voiceover"} or {"source": "none"}');
    else captions.source = raw.captions.source;
    if (captions.source === "voiceover" && !audio.voiceover) problem("captions from the voiceover need audio.voiceover");
  }

  let post: Obj | null = null;
  if (raw.post !== undefined && raw.post !== null) {
    if (!isObj(raw.post)) problem("post must be an object");
    else {
      only(raw.post, ["account_ids", "caption", "title", "schedule_at", "tiktok"], "post: ");
      post = raw.post;
    }
  }

  if (raw.title !== undefined && typeof raw.title !== "string") problem("title must be a string");
  if (problems.length) throw new SpecError(problems);
  return { version: 1, title: typeof raw.title === "string" ? raw.title : "", shots, transitions, audio, sfx, captions, post };
}

function parseTransition(v: unknown, where: string, problem: (m: string) => void): Transition | null {
  if (v === "cut" || (isObj(v) && v.type === "cut")) return { type: "cut", sec: 0 };
  if (isObj(v) && v.type === "crossfade") {
    const sec = v.sec;
    if (typeof sec === "number" && sec >= 0.1 && sec <= LIMITS.maxCrossfadeSec) return { type: "crossfade", sec };
    problem(`${where}a crossfade needs sec from 0.1 to ${LIMITS.maxCrossfadeSec}`);
    return null;
  }
  problem(`${where}must be "cut" or {"type": "crossfade", "sec": 0.3}`);
  return null;
}

/** The root element HyperFrames renders: its id, 1080x1920, and the shot's length. */
function checkComposition(html: string, sec: number, at: string, problem: (m: string) => void) {
  if (Buffer.byteLength(html) > LIMITS.maxHtmlBytes) { problem(`${at}html is larger than 256 KB`); return; }
  if (!/data-composition-id\s*=/.test(html)) { problem(`${at}html needs a root element with data-composition-id`); return; }
  for (const [attr, want] of [["data-width", "1080"], ["data-height", "1920"]]) {
    const m = new RegExp(`${attr}\\s*=\\s*["']?(\\d+)`).exec(html);
    if (!m || m[1] !== want) problem(`${at}the root element needs ${attr}="${want}"`);
  }
  const d = /data-duration\s*=\s*["']?([\d.]+)/.exec(html);
  if (!d || Math.abs(Number(d[1]) - sec) > 0.01) problem(`${at}the root element needs data-duration="${sec}" (the shot's duration_sec)`);
}

function templateParams(raw: unknown, schema: TemplateSchema, at: string, problem: (m: string) => void) {
  const out: Record<string, string | number | boolean> = {};
  const given = raw === undefined ? {} : raw;
  if (!isObj(given)) { problem(`${at}params must be an object`); return out; }
  for (const k of Object.keys(given)) if (!(k in schema.params)) problem(`${at}params: unknown field "${k}"`);
  for (const [k, p] of Object.entries(schema.params)) {
    const v = given[k];
    if (v === undefined) {
      if (p.default !== undefined) out[k] = p.default;
      else if (p.required) problem(`${at}params.${k} is required`);
      continue;
    }
    if (p.type === "number") {
      if (typeof v !== "number" || (p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) problem(`${at}params.${k} must be a number${p.min !== undefined ? ` from ${p.min} to ${p.max}` : ""}`);
      else out[k] = v;
    } else if (p.type === "boolean") {
      if (typeof v !== "boolean") problem(`${at}params.${k} must be true or false`);
      else out[k] = v;
    } else if (p.type === "color") {
      if (typeof v !== "string" || !COLOR.test(v)) problem(`${at}params.${k} must be a color like #ff5a36`);
      else out[k] = v;
    } else if (typeof v !== "string" || (p.maxLength !== undefined && v.length > p.maxLength)) {
      problem(`${at}params.${k} must be text${p.maxLength ? ` of at most ${p.maxLength} characters` : ""}`);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Ids of the shots in b that are new or differ from a: the ones a revise re-renders. */
export function shotsChanged(a: ProductionSpec, b: ProductionSpec): string[] {
  const before = new Map(a.shots.map((s) => [s.id, JSON.stringify(s)]));
  return b.shots.filter((s) => before.get(s.id) !== JSON.stringify(s)).map((s) => s.id);
}
