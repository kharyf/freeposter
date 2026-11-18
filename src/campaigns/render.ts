// The reverse of the plain-code translator: a compiled schedule written back as campaign text, one sentence per
// instruction or rule, in exactly the grammar parseCampaignText reads. An Autorun schedule change rewrites the
// campaign's text this way, so the text always describes the schedule that runs. Not every schedule can be said in
// that grammar (a rule that keeps two labels, say); roundTrip refuses those instead of storing text that lies.
import { parseCampaignText } from "./parse.ts";
import { DAYS, type CompiledCampaign, type Day, type MakeInstruction, type Pick, type PostInstruction, type Rule, type Vocabulary } from "./spec.ts";

const DAY_NAMES: Record<Day, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const LABEL_WORD: Record<Rule["when"]["label"], string> = { hook: "a hook", angle: "an angle", cta: "a cta", style: "a style", type: "a type" };

/** A library or type name, quoted so a ". " or comma inside it stays part of it. */
const quoted = (name: string) => (name.includes('"') ? name : `"${name}"`);

function pickText(p: Pick, library: Vocabulary["hooks"]): string {
  if (p.pick === "named") return quoted(library.find((e) => e.id === p.id)?.name ?? `#${p.id}`);
  return p.pick === "best" ? "best" : "random";
}

const styleToken = (id: string | null, vocab: Vocabulary) => vocab.styles.find((s) => s.id === id)?.token ?? id ?? "";

function typesText(ids: number[], vocab: Vocabulary): string {
  if (!ids.length) return "";
  const names = ids.map((id) => vocab.types.find((t) => t.id === id)?.name ?? `#${id}`);
  return `${names.length === 1 ? "type" : "types"} ${names.join(", ")}`;
}

/** "17:30" as the 12-hour form Drive names use ("5.30.pm"), which a post line's name part reads. */
function twelveHour(at: string): string {
  const [h, m] = at.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}.${String(m).padStart(2, "0")}.${h < 12 ? "am" : "pm"}`;
}

function makeSentence(day: Day, ins: MakeInstruction, vocab: Vocabulary): string {
  const verb = ins.post?.at === "default" ? "make and post" : "make";
  const clauses = [
    `${pickText(ins.hook, vocab.hooks)} hook`, `${pickText(ins.angle, vocab.angles)} angle`, `${pickText(ins.cta, vocab.ctas)} cta`,
    typesText(ins.types, vocab), ins.post && ins.post.at !== "default" ? `at ${ins.post.at}` : "",
  ].filter(Boolean);
  return `On ${DAY_NAMES[day]} ${verb} ${ins.count} ${styleToken(ins.style, vocab)} ${ins.count === 1 ? "video" : "videos"} with ${clauses.join(", ")}`;
}

function postSentence(day: Day, ins: PostInstruction, vocab: Vocabulary): string {
  const parts = [ins.name, ins.at ? twelveHour(ins.at) : "", ins.style ? styleToken(ins.style, vocab) : ""].filter(Boolean).join("_");
  const q = parts.includes("'") ? '"' : "'";
  const types = typesText(ins.types, vocab);
  return `On ${DAY_NAMES[day]} post ${q}${parts}${q}${types ? ` ${types}` : ""}`;
}

function ruleSentence(r: Rule): string {
  const w = r.when;
  const terms = `(${w.is === "working" ? "top" : "bottom"} ${w.thresholdPct}%, at ${w.age === "7d" ? "7 days" : w.age === "24h" ? "24 hours" : "72 hours"}, across at least ${w.minVideos} videos)`;
  const head = `When ${LABEL_WORD[w.label]} on this ${w.scope} is ${w.is === "working" ? "working" : "not working"} ${terms},`;
  if (r.then.kind === "stop_using") return `${head} stop using it`;
  return `${head} make ${r.then.count} variant videos that all use that ${w.label}`;
}

/** The schedule as campaign text: the days in order, each day's lines in order, then the rules. */
export function renderCampaignText(compiled: CompiledCampaign, vocab: Vocabulary): string {
  const lines: string[] = [];
  for (const d of DAYS) {
    for (const ins of compiled.days[d] ?? []) lines.push(ins.kind === "make" ? makeSentence(d, ins, vocab) : postSentence(d, ins, vocab));
  }
  for (const r of compiled.rules) lines.push(ruleSentence(r));
  return lines.map((l) => `${l}.`).join("\n");
}

/**
 * A schedule without its `source` fields (what each line was written as), to compare two schedules' meaning; a
 * rule's keep and vary are sets, so their order doesn't count.
 */
const meaning = (c: CompiledCampaign) =>
  JSON.stringify(c, (k, v) => (k === "source" ? undefined : (k === "keep" || k === "vary") && Array.isArray(v) ? [...v].sort() : v));

/**
 * Renders the schedule and reads it back: the text and the schedule as read from it (its sources are the rendered
 * sentences) when the text says exactly that schedule, else why not.
 */
export function roundTrip(compiled: CompiledCampaign, vocab: Vocabulary): { ok: true; text: string; compiled: CompiledCampaign } | { ok: false; problem: string } {
  const text = renderCampaignText(compiled, vocab);
  const back = parseCampaignText(text, vocab);
  if (back.unread.length) return { ok: false, problem: `this schedule can't be written as campaign text (e.g. "${back.unread[0].line}"); change it so each line and rule is one the text can say` };
  if (meaning(back.compiled) !== meaning(compiled)) return { ok: false, problem: "this schedule can't be written as campaign text exactly (a rule's keep/vary/post, or names that clash); change it so the text can say it" };
  return { ok: true, text, compiled: back.compiled };
}
