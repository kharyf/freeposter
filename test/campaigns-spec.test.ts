import assert from "node:assert/strict";
import { test } from "node:test";
import { DAYS, parseCompiled, type Vocabulary } from "../src/campaigns/spec.ts";

const entry = (id: number, kind: "hook" | "angle" | "cta") => ({ id, kind, name: `${kind}${id}`, text: "t", keywords: [], url: null, createdAt: 0 });
const vocab: Vocabulary = {
  styles: [{ id: "Fancy", token: "fancy" }, { id: "Plain", token: "plain" }],
  types: [{ id: 1, name: "Clip" }],
  hooks: [entry(1, "hook")], angles: [entry(2, "angle")], ctas: [entry(3, "cta")],
} as Vocabulary;

const make = (over: Record<string, unknown> = {}) => ({
  kind: "make", count: 2, style: "Fancy", hook: { pick: "random" }, angle: { pick: "best" }, cta: { pick: "named", id: 3 },
  types: [1], post: { at: "default" }, source: "Tuesday make 2", ...over,
});
const doc = (over: Record<string, unknown> = {}, tue: unknown[] = [make()]): any => ({
  version: 1,
  days: Object.fromEntries(DAYS.map((d) => [d, d === "tue" ? tue : []])),
  rules: [],
  ...over,
});
const rule = (then: unknown = { kind: "stop_using" }) => ({
  when: { label: "hook", is: "working", thresholdPct: 20, minVideos: 5, age: "72h", scope: "campaign" }, then, source: "s",
});
const bad = (raw: unknown): string[] => {
  const r = parseCompiled(raw, vocab);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.problems;
};

test("a valid campaign round-trips as a deep copy, normalizing the style", () => {
  const raw = doc({ rules: [rule({ kind: "make", count: 2, keep: ["hook"], vary: ["angle"], post: true })] }, [make({ style: "fancy" }), { kind: "post", name: "Morning", at: "09:30", style: null, types: [1], source: "x" }]);
  const r = parseCompiled(raw, vocab);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal((r.value.days.tue[0] as any).style, "Fancy");
  assert.deepEqual({ ...r.value, days: { ...r.value.days, tue: [] } }, { ...raw, days: { ...raw.days, tue: [] } });
  assert.notEqual(r.value.days.tue, raw.days.tue);
});

test("unknown fields are refused", () => {
  assert.ok(bad(doc({ extra: 1 })).some((p) => p.includes('unknown field "extra"')));
  assert.ok(bad(doc({}, [make({ bogus: 1 })])).some((p) => p.includes('days.tue[0]') && p.includes('"bogus"')));
});

test("an unknown CTA id is refused, with its path", () => {
  assert.ok(bad(doc({}, [make({ cta: { pick: "named", id: 99 } })])).some((p) => p.includes("days.tue[0].cta") && p.includes("99")));
});

test("every problem is reported together", () => {
  const raw = doc({ version: 2 }, [make({ count: 0, style: "nope", types: [7], hook: { pick: "named", id: 3 }, post: { at: "25:00" } })]);
  delete raw.days.sun;
  raw.days.xyz = [];
  const p = bad(raw);
  for (const frag of ["version", "days.sun", "xyz", "count", "style", "types", "hook", "post.at"]) assert.ok(p.some((x) => x.includes(frag)), frag);
});

test("a make target length is checked", () => {
  assert.ok(parseCompiled(doc({}, [make({ sec: 30 })]), vocab).ok);
  assert.ok(parseCompiled(doc({}, [make({ sec: null })]), vocab).ok);
  assert.ok(parseCompiled(doc({}, [make({ sec: 5 })]), vocab).ok);
  assert.ok(parseCompiled(doc({}, [make({ sec: 300 })]), vocab).ok);
  for (const sec of [4, 301, 12.5, "30"]) {
    assert.ok(bad(doc({}, [make({ sec })])).some((p) => p.includes("days.tue[0].sec")), String(sec));
  }
});

test("same_as_rule is refused in day instructions", () => {
  assert.ok(bad(doc({}, [make({ hook: { pick: "same_as_rule" } })])).some((p) => p.includes("same_as_rule")));
});

test("post instructions are checked", () => {
  const p = bad(doc({}, [{ kind: "post", name: "a_b", at: "9:00", style: "zzz", types: [], source: 5 }]));
  for (const frag of ["name", ".at", "style", "source"]) assert.ok(p.some((x) => x.includes(frag)), frag);
});

test("rule values are checked", () => {
  const r = rule({ kind: "make", count: 30, keep: ["hook", "bad"], vary: ["hook"], post: true });
  r.when.thresholdPct = 100; r.when.minVideos = 0; (r.when as any).age = "1d";
  const p = bad(doc({ rules: [r] }));
  for (const frag of ["rules[0].when.thresholdPct", "minVideos", "age", "then.count", "keep", "both"]) assert.ok(p.some((x) => x.includes(frag)), frag);
});

test("a make rule needs a named CTA in the campaign", () => {
  const then = { kind: "make", count: 1, keep: [], vary: [], post: false };
  const p = bad(doc({ rules: [rule(then)] }, [make({ cta: { pick: "random" } })]));
  assert.ok(p.includes("a make rule needs a named CTA in the campaign"));
  assert.ok(parseCompiled(doc({ rules: [rule({ kind: "stop_using" })] }, [make({ cta: { pick: "random" } })]), vocab).ok);
});

test("stop_using only works for hooks, angles and CTAs", () => {
  for (const label of ["style", "type"]) {
    const r = { ...rule(), when: { ...rule().when, label } };
    const p = bad(doc({ rules: [r] }));
    assert.ok(p.some((x) => x.startsWith("rules[0]") && x.includes("stop using only works for hooks, angles and CTAs")), p.join("; "));
  }
  for (const label of ["hook", "angle", "cta"]) assert.ok(parseCompiled(doc({ rules: [{ ...rule(), when: { ...rule().when, label } }] }), vocab).ok, label);
});
