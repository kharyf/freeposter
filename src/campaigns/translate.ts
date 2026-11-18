// The AI fallback for campaign lines the plain-code translator couldn't read: one call for all of them. The AI only
// ever proposes instructions and rules; each is merged into the plain-parsed campaign and the result is checked by the
// strict parser, so an answer naming an id, URL or style that doesn't exist is dropped, never trusted.
import type { AiService } from "../ai/router.ts";
import { parseCampaignText } from "./parse.ts";
import { DAYS, parseCompiled, type CompiledCampaign, type Day, type MakeInstruction, type PostInstruction, type Rule, type Vocabulary } from "./spec.ts";

type Instruction = MakeInstruction | PostInstruction;
interface Part { at: number; day?: Day; instruction?: Instruction; rule?: Rule }

const PICK = {
  oneOf: [
    { type: "object", properties: { pick: { enum: ["random", "best"] } }, required: ["pick"], additionalProperties: false },
    { type: "object", properties: { pick: { enum: ["named"] }, id: { type: "number" } }, required: ["pick", "id"], additionalProperties: false },
  ],
};
const LABEL_LIST = { type: "array", items: { enum: ["hook", "angle", "cta", "style", "type"] } };
const MAKE = {
  type: "object",
  properties: {
    kind: { enum: ["make"] }, count: { type: "number" }, style: { type: "string" }, hook: PICK, angle: PICK, cta: PICK,
    types: { type: "array", items: { type: "number" } },
    post: { oneOf: [{ type: "null" }, { type: "object", properties: { at: { type: "string", description: '"HH:MM" or "default"' } }, required: ["at"], additionalProperties: false }] },
  },
  required: ["kind", "count", "style", "hook", "angle", "cta", "types", "post"],
  additionalProperties: false,
};
const POST = {
  type: "object",
  properties: {
    kind: { enum: ["post"] }, name: { type: "string" }, at: { type: ["string", "null"], description: '24-hour "HH:MM" or null' },
    style: { type: ["string", "null"] }, types: { type: "array", items: { type: "number" } },
  },
  required: ["kind", "name", "at", "style", "types"],
  additionalProperties: false,
};
const RULE = {
  type: "object",
  properties: {
    when: {
      type: "object",
      properties: {
        label: { enum: ["hook", "angle", "cta", "style", "type"] }, is: { enum: ["working", "not_working"] }, thresholdPct: { type: "number" },
        minVideos: { type: "number" }, age: { enum: ["24h", "72h", "7d"] }, scope: { enum: ["campaign", "account"] },
      },
      required: ["label", "is", "thresholdPct", "minVideos", "age", "scope"],
      additionalProperties: false,
    },
    then: {
      oneOf: [
        { type: "object", properties: { kind: { enum: ["stop_using"] } }, required: ["kind"], additionalProperties: false },
        {
          type: "object",
          properties: { kind: { enum: ["make"] }, count: { type: "number" }, keep: LABEL_LIST, vary: LABEL_LIST, post: { type: "boolean" } },
          required: ["kind", "count", "keep", "vary", "post"], additionalProperties: false,
        },
      ],
    },
  },
  required: ["when", "then"],
  additionalProperties: false,
};
const SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "number" }, day: { enum: [...DAYS, null] },
          instruction: { oneOf: [{ type: "null" }, MAKE, POST] }, rule: { oneOf: [{ type: "null" }, RULE] },
        },
        required: ["index", "day", "instruction", "rule"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
};

const SYSTEM = `You turn lines of a social-media posting plan into structured instructions. Each numbered line is one the program could not read. For each line return one entry with its index, the day it applies to (sun, mon, tue, wed, thu, fri, sat, or null if it names none), and either an instruction (a day's work), a rule (a reaction to analytics), or both null when it cannot be mapped to the shapes allowed. Never invent ids, URLs or styles: use only the ids listed in the vocabulary, and when unsure return null for both. Times are 24-hour "HH:MM". A "make" instruction needs count (1-20), style (a style id), hook/angle/cta each {"pick":"random"|"best"} or {"pick":"named","id":<id>}, types (video type ids, may be empty) and post (null, or {"at":"HH:MM"} or {"at":"default"}). A "post" instruction posts an existing video by name: name (no underscore), at ("HH:MM" or null), style (style id or null), types. A rule has when {label, is, thresholdPct 1-99, minVideos, age 24h|72h|7d, scope campaign|account} and then {kind:"stop_using"} or {kind:"make", count, keep, vary, post} where keep and vary are disjoint lists of labels (hook, angle, cta, style, type). A make rule needs a named CTA elsewhere in the campaign. Answer with JSON only.`;

const vocabText = (v: Vocabulary) => JSON.stringify({
  styles: v.styles.map((s) => ({ id: s.id, token: s.token })),
  types: v.types.map((t) => ({ id: t.id, name: t.name })),
  hooks: v.hooks.map((e) => ({ id: e.id, name: e.name })),
  angles: v.angles.map((e) => ({ id: e.id, name: e.name })),
  ctas: v.ctas.map((e) => ({ id: e.id, name: e.name })),
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function translateCampaign(
  deps: { ai: Pick<AiService, "ask"> | null },
  text: string,
  vocab: Vocabulary,
): Promise<{ compiled: CompiledCampaign; couldNotUnderstand: string[] }> {
  const { compiled, unread } = parseCampaignText(text, vocab);
  const allLost = () => ({ compiled, couldNotUnderstand: unread.map((u) => u.line) });
  if (!unread.length || !deps.ai) return allLost();

  let answer: { lines?: unknown };
  try {
    answer = await deps.ai.ask<{ lines?: unknown }>("campaign", {
      system: SYSTEM,
      prompt: `Vocabulary (names and ids only):\n${vocabText(vocab)}\n\nLines:\n${unread.map((u, i) => `${i}: ${u.line}`).join("\n")}`,
      schema: SCHEMA,
      effort: "low",
    });
  } catch {
    return allLost();
  }

  // One part per proposed instruction or rule, built in unread order. An instruction needs a day the user's own line
  // named (a day from the AI would be a guess); a rule needs none. Malformed entries simply don't become parts.
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const e of Array.isArray(answer?.lines) ? answer.lines : []) {
    if (isObj(e) && typeof e.index === "number" && !byIndex.has(e.index)) byIndex.set(e.index, e);
  }
  const parts: Part[] = [];
  // A line is understood only when every part the AI proposed for it survives; one partly dropped (by the strict
  // check, or an instruction for a line that names no day) is unread as a whole, and none of it is kept, so the
  // confirm table never shows half of a line beside the whole sentence as if it were handled.
  const partial = new Set<number>();
  unread.forEach((u, i) => {
    const e = byIndex.get(i);
    if (!e) return;
    if (isObj(e.instruction)) {
      if (u.day) parts.push({ at: i, day: u.day, instruction: { ...e.instruction, source: u.line } as unknown as Instruction });
      else partial.add(i);
    }
    if (isObj(e.rule)) parts.push({ at: i, rule: { ...e.rule, source: u.line } as unknown as Rule });
  });
  const dropLine = (at: number) => {
    partial.add(at);
    for (let k = parts.length - 1; k >= 0; k--) if (parts[k].at === at) parts.splice(k, 1);
  };
  for (const at of [...partial]) dropLine(at);

  // Merge, validate, and drop exactly the AI parts the strict parser points at until the whole thing checks.
  const build = () => {
    const days = Object.fromEntries(DAYS.map((d) => [d, [...compiled.days[d]] as unknown[]])) as Record<Day, unknown[]>;
    const rules: unknown[] = [...compiled.rules];
    const instrAt = new Map<string, Part>(), ruleAt = new Map<number, Part>();
    for (const p of parts) {
      if (p.instruction && p.day) { instrAt.set(`${p.day}[${days[p.day].length}]`, p); days[p.day].push(p.instruction); }
      if (p.rule) { ruleAt.set(rules.length, p); rules.push(p.rule); }
    }
    return { raw: { version: 1, days, rules }, instrAt, ruleAt };
  };
  let final: CompiledCampaign = compiled;
  while (parts.length) {
    const { raw, instrAt, ruleAt } = build();
    const r = parseCompiled(raw, vocab);
    if (r.ok) { final = r.value; break; }
    const bad = new Set<Part>();
    for (const p of r.problems) {
      const d = /^days\.(\w+)(\[\d+\])/.exec(p), q = /^rules\[(\d+)\]/.exec(p);
      const part = d ? instrAt.get(d[1] + d[2]) : q ? ruleAt.get(Number(q[1])) : undefined;
      if (part) bad.add(part);
    }
    if (!bad.size) {
      // a problem about the whole campaign (a make rule with no named CTA): drop the AI make rules, else the AI
      // instructions that named a CTA, and only then everything the AI added
      for (const p of parts) if (p.rule?.then.kind === "make") bad.add(p);
      if (!bad.size) for (const p of parts) if (p.instruction?.kind === "make" && p.instruction.cta?.pick === "named") bad.add(p);
      if (!bad.size) for (const p of parts) bad.add(p);
    }
    for (const at of new Set([...bad].map((p) => p.at))) dropLine(at);
  }

  const kept = new Set(parts.map((p) => p.at).filter((at) => !partial.has(at)));
  return { compiled: final, couldNotUnderstand: unread.filter((_, i) => !kept.has(i)).map((u) => u.line) };
}
