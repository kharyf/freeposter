// The script for a fully generated campaign video, and the production spec built from it. The AI writes the words
// and the shot ideas; plain code checks the hook, the call to action and the link, and may ask once more.
import type { AiService } from "../ai/router.ts";
import { config } from "../config.ts";
import type { ProductionSpec, WanShot } from "../produce/spec.ts";
import type { LibraryEntry } from "./store.ts";
import { TLDS } from "./tlds.ts";

export interface Script { lines: string[]; shots: { prompt: string; sec: number }[]; caption: string; title: string; musicPrompt: string }
export interface ScriptChoice { hook: LibraryEntry; angle: LibraryEntry; cta: LibraryEntry }

const MIN_SHOT_SEC = 2;
const MAX_SHOT_SEC = 10;

/**
 * How long and how many: 8-60 seconds, 12 lines and 8 shots for an ordinary video, stretched for a longer target (up
 * to 300 seconds, about a line per 5 seconds) or lowered for a shorter one (down to 5 seconds).
 */
export function scriptLimits(targetSec?: number) {
  const t = targetSec ?? 0;
  return {
    maxLines: Math.max(12, Math.ceil(t / 5)),
    maxShots: Math.max(8, Math.ceil(t / MAX_SHOT_SEC) + 2),
    minTotal: t ? Math.min(8, Math.max(MIN_SHOT_SEC, t - Math.max(4, Math.round(t * 0.2)))) : 8,
    maxTotal: Math.max(60, t ? t + Math.max(4, Math.round(t * 0.2)) : 60),
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "string" }, description: "the spoken script, one short line per item" },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: { prompt: { type: "string" }, sec: { type: "number" } },
        required: ["prompt", "sec"], additionalProperties: false,
      },
    },
    caption: { type: "string" }, title: { type: "string" }, musicPrompt: { type: "string" },
  },
  required: ["lines", "shots", "caption", "title", "musicPrompt"],
  additionalProperties: false,
};

const system = (l: ReturnType<typeof scriptLimits>) => `You write the script for a short vertical social video that is generated end to end: a voiceover, a few AI-generated video shots and a soundtrack.
Definitions (the owner's own words):
- hook: a phrase that the video opens with in the first 2-3 seconds
- angle: the description of the problem the video is claiming to solve
- CTA: an explicit, direct call to click a link or go to a web page that comes at the very end of the video
Rules:
- The first spoken line starts with the hook, word for word.
- The video is built around the angle.
- The last spoken line contains the CTA's spoken call, word for word.
- The only link anywhere (script lines and caption) is the CTA's link, and the caption contains it.
- At most ${l.maxLines} lines; no line starts with "#"; no line is empty.
- 1 to ${l.maxShots} shots, each ${MIN_SHOT_SEC} to ${MAX_SHOT_SEC} seconds, ${l.minTotal} to ${l.maxTotal} seconds in all.
- When the brief gives the owner's instructions, follow them, unless they break one of these rules.
- When the brief gives a target length, the shots' total should be close to it. Each shot prompt describes one moving scene to generate, in plain visual terms, with no text on screen.
- musicPrompt describes an instrumental soundtrack. title is a short name for the video.`;

const normalize = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}]/gu, "").replace(/\s+/g, " ").trim();
// Anything that could send a viewer somewhere: any http(s) URL, an email address, an IPv4 address, localhost, or a
// (unicode) domain.
const URL_PATTERNS = [
  /https?:\/\/[^\s]+/giu,
  /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}/gu,
  /(?<![\p{L}\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/[^\s]*)?/gu,
  /(?<![\p{L}\p{N}.-])localhost(?::\d+)?(?:\/[^\s]*)?/giu,
  /(?<![\p{L}\p{N}@.-])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?::\d+)?(?:\/[^\s]*)?/gu,
];
/**
 * The text as a viewer reads it: compatibility forms folded (NFKC: a full-width "．" is "."), invisible format
 * characters (zero-width spaces and joiners) removed, other dots that read as one ("。", "｡") made ".", and a spelled
 * dot ("example dot com", "example[.]com", "example(dot)com") read as the domain it spells — but only before a real
 * TLD, so ordinary speech ("a polka dot dress") isn't mistaken for one.
 */
const deobfuscate = (t: string) => t
  .normalize("NFKC")
  .replace(/\p{Cf}/gu, "")
  .replace(/[。｡․﹒]/gu, ".")
  .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".")
  .replace(/\[\.\]|\(\.\)/g, ".")
  .replace(/(?<=[\p{L}\p{N}])\s+dot\s+(\p{L}{2,})(?![\p{L}\p{N}-])/giu, (m, tld: string) => (TLDS.has(tld.toLowerCase()) ? `.${tld}` : m));
const normUrl = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[.,;:!?)"'\]]+$/, "").replace(/\/+$/, "");
/** Every link in a text, read the way a viewer reads it (see deobfuscate). */
export const linksIn = (text: string): string[] => {
  const t = deobfuscate(text);
  return URL_PATTERNS.flatMap((re) => t.match(re) ?? []);
};

/**
 * The link check every campaign text goes through: a link a viewer would read in the texts is refused unless it is
 * in the user's own words (the chosen hook, angle and CTA, and the CTA's link), each named once.
 */
export function foreignLinks(texts: unknown[], own: { hook: string; angle: string; cta: string; url: string | null }): string[] {
  // The chosen hook, angle and CTA are the user's own words (an agent can't add one that carries a link), so a link
  // a viewer would read in them is allowed too: a hook the user wrote is never refused for reading as one.
  const allowed = new Set<string>([own.hook, own.angle, own.cta, own.url ?? ""].flatMap((t) => linksIn(String(t))).map(normUrl));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const text of texts) {
    for (const m of linksIn(String(text ?? ""))) {
      const n = normUrl(m);
      if (!allowed.has(n) && !seen.has(n)) { seen.add(n); problems.push(`the link ${m} isn't allowed; the only link is ${own.url ?? "none"}`); }
    }
  }
  return problems;
}

/** Whether a caption carries the CTA's link, read as a viewer reads it. */
export const hasLink = (caption: string, url: string) => linksIn(caption).some((m) => normUrl(m) === normUrl(url));

export function checkScript(s: Script, choice: ScriptChoice, targetSec?: number): string[] {
  const { maxLines: MAX_LINES, maxShots: MAX_SHOTS, minTotal: MIN_TOTAL_SEC, maxTotal: MAX_TOTAL_SEC } = scriptLimits(targetSec);
  const problems: string[] = [];
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const shots = Array.isArray(s.shots) ? s.shots : [];
  if (!lines.length) problems.push("the script has no lines");
  if (lines.length > MAX_LINES) problems.push(`the script has ${lines.length} lines; at most ${MAX_LINES}`);
  lines.forEach((l, i) => {
    if (typeof l !== "string" || !l.trim()) problems.push(`line ${i + 1} is empty`);
    else if (l.trimStart().startsWith("#")) problems.push(`line ${i + 1} starts with "#"; no line may`);
  });
  if (lines.length) {
    const hook = normalize(choice.hook.text), first = normalize(String(lines[0]));
    if (!hook) problems.push("the hook has no words, so the first line can't start with it");
    else if (first !== hook && !first.startsWith(`${hook} `)) problems.push(`the first line must start with the hook: "${choice.hook.text}"`);
    const cta = normalize(choice.cta.text), last = normalize(String(lines[lines.length - 1]));
    if (!cta) problems.push("the call to action has no words, so the last line can't contain it");
    else if (!` ${last} `.includes(` ${cta} `)) problems.push(`the last line must contain the call to action: "${choice.cta.text}"`);
  }
  problems.push(...foreignLinks([...lines, s.caption ?? "", s.title ?? "", s.musicPrompt ?? "", ...shots.map((sh) => sh?.prompt ?? "")],
    { hook: choice.hook.text, angle: choice.angle.text, cta: choice.cta.text, url: choice.cta.url ?? null }));
  if (choice.cta.url && !hasLink(String(s.caption ?? ""), choice.cta.url)) problems.push(`the caption must contain the link ${choice.cta.url}`);
  if (shots.length < 1 || shots.length > MAX_SHOTS) problems.push(`there must be 1 to ${MAX_SHOTS} shots (got ${shots.length})`);
  let total = 0;
  shots.forEach((sh, i) => {
    if (!sh || typeof sh.prompt !== "string" || !sh.prompt.trim()) problems.push(`shot ${i + 1} has no prompt`);
    if (!sh || typeof sh.sec !== "number" || !(sh.sec >= MIN_SHOT_SEC && sh.sec <= MAX_SHOT_SEC)) problems.push(`shot ${i + 1} must be ${MIN_SHOT_SEC} to ${MAX_SHOT_SEC} seconds`);
    else total += sh.sec;
  });
  if (total < MIN_TOTAL_SEC || total > MAX_TOTAL_SEC) problems.push(`the shots add up to ${total} seconds; they must be ${MIN_TOTAL_SEC} to ${MAX_TOTAL_SEC} seconds in all`);
  if (targetSec) {
    const tol = Math.max(4, Math.round(targetSec * 0.2));
    if (total < targetSec - tol || total > targetSec + tol) problems.push(`the shots add up to ${total} seconds; aim for about ${targetSec} (within ${tol})`);
  }
  if (typeof s.title !== "string" || !s.title.trim()) problems.push("the title is empty");
  if (typeof s.musicPrompt !== "string" || !s.musicPrompt.trim()) problems.push("the music prompt is empty");
  return problems;
}

export async function writeScript(deps: { ai: AiService }, choice: ScriptChoice, targetSec?: number, instructions?: string): Promise<Script> {
  const { hook, angle, cta } = choice;
  const SYSTEM = system(scriptLimits(targetSec));
  const brief = [
    `Hook: ${hook.text}`,
    `Angle: ${angle.text}`,
    `CTA (spoken call): ${cta.text}`,
    cta.url ? `CTA link: ${cta.url}` : "The CTA has no link; the script and caption contain no link.",
    targetSec ? `Target length: about ${targetSec} seconds (make the shots add up close to that).` : "",
    instructions?.trim() ? `The owner's instructions for this video:\n${instructions.trim()}` : "",
  ].filter(Boolean).join("\n");
  let prompt = `${brief}\n\nWrite the script.`;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await deps.ai.ask<Script>("script", { system: SYSTEM, prompt, schema: SCHEMA, effort: "medium" });
    problems = checkScript(s, choice, targetSec);
    if (!problems.length) return s;
    prompt = `${brief}\n\nYour last script had these problems:\n- ${problems.join("\n- ")}\n\nWrite the whole script again and fix every one.`;
  }
  throw new Error(`the script writer failed twice; problems:\n- ${problems.join("\n- ")}`);
}

/** The production spec for a script: one WanGP shot per script shot, the voiceover and music as files. Built by FreePoster, so it goes to `stage`, never parseSpec. */
export function buildGeneratedProduction(s: Script, audio: { voiceover: string; music: string }, presenter: boolean): ProductionSpec {
  const model = config.produce.wangpPresenterModel;
  const shots: WanShot[] = s.shots.map((sh, i) => {
    const shot: WanShot = { id: `shot-${i + 1}`, kind: "wan", duration_sec: sh.sec, prompt: sh.prompt, negative_prompt: "", image: null, seed: 1000 + i };
    if (presenter && model && i === 0) { shot.model = model; shot.audio_guide = audio.voiceover; }
    return shot;
  });
  return {
    version: 1, title: s.title, shots,
    transitions: { default: { type: "cut", sec: 0 } },
    audio: { voiceover: audio.voiceover, music: audio.music },
    sfx: [], captions: { source: "voiceover" }, post: null,
  };
}
