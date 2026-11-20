// The plain-code translator: reads the user's free-form week ("On Sunday make and post 3 Fancy videos with ...") into
// the compiled schedule with zero AI tokens. Each sentence becomes one instruction or rule, or, when it isn't one of
// the shapes below or names something that doesn't exist, comes back in `unread` (a later step asks the AI about
// those lines only). Names are matched exactly (ignoring case and spacing); nothing is ever guessed.
import { looksLikeDate, looksLikeTime, readTime } from "../drive/filename.ts";
import { DAYS, parseCompiled, type CompiledCampaign, type Day, type MakeInstruction, type Pick, type PostInstruction, type Rule, type Vocabulary } from "./spec.ts";

export interface ParsedCampaign {
  compiled: CompiledCampaign;
  unread: { line: string; day: Day | null }[];
}

const DAY_WORDS: Record<Day, string[]> = {
  sun: ["sunday", "sun"], mon: ["monday", "mon"], tue: ["tuesday", "tues", "tue"], wed: ["wednesday", "weds", "wed"],
  thu: ["thursday", "thurs", "thur", "thu"], fri: ["friday", "fri"], sat: ["saturday", "sat"],
};
const DAY_ALT = DAYS.flatMap((d) => DAY_WORDS[d]).sort((a, b) => b.length - a.length).join("|");
const dayOf = (word: string): Day => DAYS.find((d) => DAY_WORDS[d].includes(word.toLowerCase()))!;
// One day word, possibly plural and with a trailing dot; a day name at the very start of a line.
const DAY_ONE = new RegExp(`^(?:on\\s+|every\\s+)?(${DAY_ALT})s?\\.?(?=$|[\\s,:-])`, "i");
// The separator between days in a list: a comma, maybe followed by "and", or a bare "and", "&" or "+".
const DAY_SEP = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)/i;
// An unread line's day: one the line starts with, or one after "on"/"every" ("I sat down" names no day).
const DAY_NAMED = new RegExp(`(?:^|\\b(?:on|every)\\s+)(${DAY_ALT})s?(?![a-z0-9])`, "i");

/**
 * The days a line opens with, and how much of it they took: one day ("On Sunday …", "Sun. - make …") or a list
 * ("Sunday, Monday, … and Saturday make …"). Null when the line doesn't open with a day.
 */
function dayPrefix(line: string): { days: Day[]; len: number } | null {
  const first = DAY_ONE.exec(line);
  if (!first) return null;
  const days: Day[] = [dayOf(first[1])];
  let at = first[0].length;
  for (;;) {
    const sep = DAY_SEP.exec(line.slice(at));
    if (!sep) break;
    const next = DAY_ONE.exec(line.slice(at + sep[0].length));
    if (!next) break;
    at += sep[0].length + next[0].length;
    const d = dayOf(next[1]);
    if (!days.includes(d)) days.push(d);
  }
  const after = /^\s*[,:-]?\s+/.exec(line.slice(at));
  if (!after) return null;
  return { days, len: at + after[0].length };
}

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const NUM = `\\d+|an?|${NUMBER_WORDS.join("|")}`;
const readNumber = (s: string): number => {
  const w = s.toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  if (w === "a" || w === "an") return 1;
  return NUMBER_WORDS.indexOf(w) + 1;
};

const LABEL = "hook|angle|cta|call[\\s-]to[\\s-]action";
const RULE_LABEL = `${LABEL}|editing\\s+style|style|video\\s+type|type`;
const labelOf = (s: string): Rule["when"]["label"] => {
  const w = s.toLowerCase();
  if (w.startsWith("call") || w === "cta") return "cta";
  if (w.endsWith("style")) return "style";
  if (w.endsWith("type")) return "type";
  return w as "hook" | "angle";
};

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "6pm", "5.30.pm", "5:30 pm" (12-hour) or "18:00" / "05:30" (24-hour) as "HH:MM". A one-digit hour with no am/pm
 * ("5:30") could be morning or evening, so it isn't read: never guess.
 */
function clock(s: string): string | null {
  const t = s.trim();
  const h24 = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (h24) return `${pad(Number(h24[1]))}:${h24[2]}`;
  const r = readTime(t);
  return r ? `${pad(r.h)}:${pad(r.m)}` : null;
}

/** Curly quotes and dashes made plain, so the shapes below only need the plain forms. */
const plain = (text: string) => text.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"').replace(/[‐‑‒–—―−]/g, "-").replace(/ /g, " ");

/** Sentences: split on newlines and on ". " outside quotes, but not after an abbreviated day ("Sun. make ..."). */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of plain(text).split(/\r?\n/)) {
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], prev = line[i - 1] ?? " ", next = line[i + 1] ?? " ";
      if (quote === '"' && c === '"') quote = null;
      else if (quote === "'" && c === "'" && !/[a-z0-9]/i.test(next)) quote = null;
      else if (!quote && c === '"') quote = c;
      else if (!quote && c === "'" && /\s|[(]/.test(prev)) quote = c;
      else if (!quote && c === "." && /\s/.test(next)) {
        const word = /([a-z]+)$/i.exec(line.slice(start, i))?.[1] ?? "";
        if (new RegExp(`^(?:${DAY_ALT})$`, "i").test(word)) continue;
        out.push(line.slice(start, i));
        start = i + 1;
      }
    }
    out.push(line.slice(start));
  }
  return out.map((s) => s.replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim()).filter(Boolean);
}

type Clauses = { hook: Pick; angle: Pick; cta: Pick; types: number[]; at: string | null; post: boolean };

function libraryPick(name: string, library: Vocabulary["hooks"]): Pick | null {
  const n = key(name).replace(/^(["'])(.*)\1$/, "$2");
  if (/^(?:a\s+)?random$/.test(n)) return { pick: "random" };
  if (/^(?:the\s+)?best$/.test(n)) return { pick: "best" };
  const find = (s: string) => library.find((e) => key(e.name) === s);
  const hit = find(n) ?? find(n.replace(/^(?:a|an|the)\s+/, "").replace(/^(["'])(.*)\1$/, "$2"));
  return hit ? { pick: "named", id: hit.id } : null;
}

/** The longest type name at the start of `s`, ending at a word boundary. */
function typeAt(s: string, vocab: Vocabulary): { id: number; len: number } | null {
  const lower = s.toLowerCase();
  let best: { id: number; len: number } | null = null;
  for (const t of vocab.types) {
    const words = key(t.name).split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const m = new RegExp(`^${words.join("\\s+")}(?![a-z0-9])`).exec(lower);
    if (m && (!best || m[0].length > best.len)) best = { id: t.id, len: m[0].length };
  }
  return best;
}

/** "types A and B" / "type A" at the start of `s`: the ids and how much of `s` they took, or null. */
function typesClause(s: string, vocab: Vocabulary): { ids: number[]; len: number } | null {
  const lead = /^(?:as\s+)?(?:the\s+)?(?:video\s+)?types?\s+/i.exec(s);
  if (!lead) return null;
  const ids: number[] = [];
  let at = lead[0].length;
  for (;;) {
    const t = typeAt(s.slice(at), vocab);
    if (!t) return null;
    ids.push(t.id);
    at += t.len;
    const sep = /^\s*(?:,\s*)?(?:and\s+)?/i.exec(s.slice(at))![0];
    if (!sep || !typeAt(s.slice(at + sep.length), vocab)) break;
    at += sep.length;
  }
  return { ids, len: at };
}

/** The clauses after a make line's style: "with X hook, Y angle, and Z cta", "at 6pm", "types A and B", "post them". */
function makeClauses(text: string, vocab: Vocabulary): Clauses | null {
  const c: Clauses = { hook: { pick: "random" }, angle: { pick: "random" }, cta: { pick: "random" }, types: [], at: null, post: false };
  const seen = new Set<string>();
  let s = text;
  const SEP = /^(?:\s|,|\band\b|\bwith\b|\bplus\b)+/i;
  while ((s = s.replace(SEP, "")) !== "") {
    let m: RegExpExecArray | null;
    let types: { ids: number[]; len: number } | null;
    let len: number;
    if ((m = /^(?:(?:then\s+)?post(?:ed)?\s+(?:them\s+|it\s+)?)?at\s+(\d{1,2}(?:[.:]\d{2})?(?:\.?\s*[ap]m)?)(?=$|[\s,])/i.exec(s))) {
      if (seen.has("at")) return null;
      seen.add("at");
      c.at = clock(m[1]);
      if (!c.at) return null;
      len = m[0].length;
    } else if ((m = /^(?:then\s+)?post(?:ed)?(?:\s+them|\s+it)?(?=$|[\s,])/i.exec(s))) {
      c.post = true;
      len = m[0].length;
    } else if ((types = typesClause(s, vocab))) {
      if (seen.has("types")) return null;
      seen.add("types");
      c.types = types.ids;
      len = types.len;
    } else if ((m = new RegExp(`^(.+?)\\s+(${LABEL})(?![a-z0-9])`, "i").exec(s))) {
      const label = labelOf(m[2]) as "hook" | "angle" | "cta";
      if (seen.has(label)) return null;
      seen.add(label);
      const p = libraryPick(m[1], label === "hook" ? vocab.hooks : label === "angle" ? vocab.angles : vocab.ctas);
      if (!p) return null;
      c[label] = p;
      len = m[0].length;
    } else if (/^for\b/i.test(s)) break; // "for the Bumplz mobile game …": a description, not part of the schedule
    else return null;
    s = s.slice(len);
  }
  return c;
}

/** A style written by its token or id (ignoring case and spaces), as the style's id; make and post lines share it. */
function styleId(name: string, vocab: Vocabulary): string | null {
  const n = key(name).replace(/\s/g, "");
  return vocab.styles.find((st) => st.token.toLowerCase() === n || st.id.toLowerCase().replace(/\s/g, "") === n)?.id ?? null;
}

/** "30 second", "30-second" or "30s": a make line's target length, with how much of the text it took. */
const DURATION = /(\d{1,3})\s*(?:-|\s)?\s*(?:seconds?|secs?|s)\b/i;

function readMake(rest: string, source: string, vocab: Vocabulary): MakeInstruction | null {
  const m = new RegExp(`^make(\\s+and\\s+post)?\\s+(${NUM})\\s+(.+)$`, "i").exec(rest);
  if (!m) return null;
  const count = readNumber(m[2]);
  let body = m[3];
  let sec: number | null = null;
  let style: string | null;
  let tail: string;
  const noun = /^(.+?)\s+(videos?|ads?)(?![a-z0-9])(.*)$/i.exec(body);
  if (noun) {
    // A target length before "videos"/"ads" ("three 30 second ads") is the length, not the style.
    let pre = noun[1];
    const dur = DURATION.exec(pre);
    if (dur) { sec = Number(dur[1]); pre = `${pre.slice(0, dur.index)} ${pre.slice(dur.index + dur[0].length)}`.trim(); }
    // No style word at all ("three 30 second ads") takes the campaign's default style; a wrong name stays unread.
    style = pre ? styleId(pre, vocab) : vocab.defaultStyle ?? null;
    tail = noun[3];
  } else {
    const dur = DURATION.exec(body);
    if (dur) { sec = Number(dur[1]); body = `${body.slice(0, dur.index)} ${body.slice(dur.index + dur[0].length)}`.trim(); }
    const parts = /^(.+?)((?:\s+with\s+|,).*)?$/i.exec(body)!.slice(1) as [string, string?];
    style = parts[0].trim() ? styleId(parts[0], vocab) : vocab.defaultStyle ?? null;
    tail = parts[1] ?? "";
  }
  if (!style) return null;
  const c = makeClauses(tail, vocab);
  if (!c) return null;
  const post = c.at ? { at: c.at } : m[1] || c.post ? { at: "default" } : null;
  const out: MakeInstruction = { kind: "make", count, style, hook: c.hook, angle: c.angle, cta: c.cta, types: c.types, post, source };
  if (sec !== null) out.sec = sec;
  return out;
}

/** "The call to action for every video should be X": the named CTA every make takes unless it names one. */
function readDefaultCta(line: string, vocab: Vocabulary): Pick | null {
  const m = new RegExp(`^(?:the\\s+)?(?:call[\\s-]to[\\s-]action|cta)\\s+for\\s+(?:every|each|all)\\s+videos?\\s+(?:should\\s+be|is|must\\s+be)\\s+(.+)$`, "i").exec(line);
  if (!m) return null;
  const p = libraryPick(m[1], vocab.ctas);
  return p?.pick === "named" ? p : null;
}

function readPost(rest: string, source: string, vocab: Vocabulary): PostInstruction | null {
  const m = /^post\s+(?:'([^']+)'|"([^"]+)"|(\S+))(.*)$/i.exec(rest);
  if (!m) return null;
  const [first, ...parts] = (m[1] ?? m[2] ?? m[3]).split("_");
  const name = first.trim();
  if (!name || looksLikeTime(name) || looksLikeDate(name)) return null;
  let at: string | null = null, style: string | null = null, slot = 0;
  for (const raw of parts) {
    const part = raw.trim();
    if (slot < 1 && looksLikeTime(part)) {
      at = clock(part);
      if (!at) return null;
      slot = 1;
    } else if (slot < 2 && styleId(part, vocab)) {
      style = styleId(part, vocab);
      slot = 2;
    } else return null;
  }
  let types: number[] = [];
  if (m[4].trim()) {
    const c = makeClauses(m[4], vocab);
    if (!c || !c.types.length || c.at || c.post || [c.hook, c.angle, c.cta].some((p) => p.pick !== "random")) return null;
    types = c.types;
  }
  return { kind: "post", name, at, style, types, source };
}

function readRule(sentence: string): Rule | null {
  let s = sentence;
  const when: Rule["when"] = { label: "hook", is: "working", thresholdPct: 25, minVideos: 3, age: "72h", scope: "campaign" };
  const take = (re: RegExp, use: (m: RegExpExecArray) => void) => {
    const m = re.exec(s);
    if (m) { use(m); s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); }
  };
  let side: string | null = null;
  take(/\b(top|bottom)\s+(\d{1,2})\s*(?:%|percent\b)/i, (m) => { side = m[1].toLowerCase(); when.thresholdPct = Number(m[2]); });
  take(/\b(?:at|after)\s+(?:(24|72)\s*(?:hours?|h)|(7)\s*(?:days?|d))\b/i, (m) => { when.age = m[2] ? "7d" : m[1] === "24" ? "24h" : "72h"; });
  take(new RegExp(`\\b(?:after|across(?:\\s+at\\s+least)?|at\\s+least)\\s+(${NUM})\\s+videos?\\b`, "i"), (m) => { when.minVideos = readNumber(m[1]); });
  s = s.replace(/\(\s*[,\s]*\)/g, " ").replace(/\s+,/g, ",").replace(/,(\s*,)+/g, ",").replace(/\s+/g, " ").trim();

  const m = new RegExp(`^(?:when|whenever|if)\\s+(?:analytics\\s+shows?\\s+(?:that\\s+)?)?(?:a|an|the|any)\\s+(${RULE_LABEL})` +
    `(?:\\s+(?:on|in|for|from)\\s+this\\s+(campaign|account))?\\s+is\\s+(not\\s+working|working),?\\s+(?:then\\s+)?(.+)$`, "i").exec(s);
  if (!m) return null;
  when.label = labelOf(m[1]);
  when.scope = m[2]?.toLowerCase() === "account" ? "account" : "campaign";
  when.is = /^not/i.test(m[3]) ? "not_working" : "working";
  // "working" is the top of the scores and "not working" the bottom: "not working (top 10%)" contradicts itself.
  if (side !== null && side !== (when.is === "working" ? "top" : "bottom")) return null;
  const action = m[4];
  const stop = new RegExp(`^stop\\s+using\\s+(?:it|them|that\\s+(${RULE_LABEL}))$`, "i").exec(action);
  if (stop) {
    // Only a value that isn't working is dropped from the pools.
    if (when.is !== "not_working" || (stop[1] && labelOf(stop[1]) !== when.label)) return null;
    return { when, then: { kind: "stop_using" }, source: sentence };
  }
  const make = new RegExp(`^(?:create|make)\\s+(${NUM})\\s+(?:more\\s+)?variants?(?:\\s+videos?)?\\s+that\\s+(?:all\\s+)?use\\s+(?:that|the\\s+same)\\s+(${RULE_LABEL})$`, "i").exec(action);
  if (!make || labelOf(make[2]) !== when.label) return null;
  // Keep the matched label and vary the other spoken parts. A style or type rule keeps that label and varies all
  // three of hook/angle/cta.
  const vary = ["hook", "angle", "cta"].filter((l) => l !== when.label);
  return { when, then: { kind: "make", count: readNumber(make[1]), keep: [when.label], vary, post: true }, source: sentence };
}

type Item = { sentence: number; day: Day | null; value: MakeInstruction | PostInstruction | Rule };

export function parseCampaignText(text: string, vocab: Vocabulary): ParsedCampaign {
  const lines = sentences(text);
  const items: Item[] = [];
  const unreadAt = new Set<number>();
  let defaultCta: Pick | null = null;
  lines.forEach((line, i) => {
    const d = dayPrefix(line);
    let value: MakeInstruction | PostInstruction | Rule | null;
    if (d) {
      const rest = line.slice(d.len);
      value = readMake(rest, line, vocab) ?? readPost(rest, line, vocab);
    } else {
      const cta = readDefaultCta(line, vocab);
      if (cta) { defaultCta = cta; return; } // a campaign-wide default, not one day's work
      value = readRule(line);
    }
    if (value) for (const day of d ? d.days : [null]) items.push({ sentence: i, day, value });
    else unreadAt.add(i);
  });
  // "The call to action for every video should be X" names the CTA for every make that doesn't name one.
  if (defaultCta) for (const it of items) if ("kind" in it.value && it.value.kind === "make" && it.value.cta.pick === "random") it.value.cta = defaultCta;

  // Self-check: whatever the strict parser refuses goes back to unread, so the output always validates.
  for (;;) {
    const kept = items.filter((it) => !unreadAt.has(it.sentence));
    const compiled = build(kept);
    const checked = parseCompiled(compiled, vocab);
    if (checked.ok || !kept.length) {
      const unread = lines.flatMap((line, i) => (unreadAt.has(i) ? [{ line, day: dayNamed(line) }] : []));
      return { compiled: checked.ok ? checked.value : build([]), unread };
    }
    const before = unreadAt.size;
    for (const p of checked.problems) {
      const day = /^days\.(\w+)\[(\d+)\]/.exec(p);
      const rule = /^rules\[(\d+)\]/.exec(p);
      if (day) unreadAt.add(kept.filter((it) => it.day === day[1])[Number(day[2])].sentence);
      else if (rule) unreadAt.add(kept.filter((it) => !it.day)[Number(rule[1])].sentence);
      else if (p.startsWith("a make rule")) for (const it of kept) if (!it.day && (it.value as Rule).then.kind === "make") unreadAt.add(it.sentence);
    }
    if (unreadAt.size === before) for (const it of kept) unreadAt.add(it.sentence);
  }
}

function build(items: Item[]): CompiledCampaign {
  const days = Object.fromEntries(DAYS.map((d) => [d, [] as (MakeInstruction | PostInstruction)[]])) as CompiledCampaign["days"];
  const rules: Rule[] = [];
  for (const it of items) {
    if (it.day) days[it.day].push(it.value as MakeInstruction | PostInstruction);
    else rules.push(it.value as Rule);
  }
  return { version: 1, days, rules };
}

function dayNamed(line: string): Day | null {
  const m = DAY_NAMED.exec(line);
  return m ? dayOf(m[1]) : null;
}
