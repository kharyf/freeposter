import "./isolated-home.ts"; // first: keeps uploads out of the real data/ folder
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDoc, signature, summary, validate } from "../src/api/schema.ts";
import { compact, parseFields, pick } from "../src/api/compact.ts";
import { mcpFixture } from "./helpers.ts";

test("validate enforces the subset FreePoster's schemas use", () => {
  const s = { type: "object", properties: { ids: { type: "array", items: { type: "integer" }, minItems: 1 }, mode: { type: "string", enum: ["a", "b"] }, t: { type: "object", properties: { p: { type: "string" } }, required: ["p"], additionalProperties: false } }, required: ["ids"], additionalProperties: false };
  validate(s, { ids: [1] });
  assert.throws(() => validate(s, {}), /ids is required/);
  assert.throws(() => validate(s, { ids: [] }), /ids needs at least 1/);
  assert.throws(() => validate(s, { ids: [1, "2"] }), /ids\[1\] must be a whole number/);
  assert.throws(() => validate(s, { ids: [1], mode: "c" }), /mode must be one of a, b/);
  assert.throws(() => validate(s, { ids: [1], t: {} }), /t\.p is required/);
  assert.throws(() => validate(s, { ids: [1], extra: 1 }), /unknown argument extra/);
});

test("unknown key suggests the nearest", () => {
  const s = { type: "object", properties: { account_ids: { type: "array" } }, additionalProperties: false };
  assert.throws(() => validate(s, { acount_ids: [1] }), /unknown argument acount_ids; did you mean account_ids\?/);
});

test("signature is compact", () => {
  assert.equal(signature("x", { type: "object", properties: { b: { type: "boolean" }, a: { type: "integer" }, e: { type: "string", enum: ["p", "q"] }, l: { type: "array", items: { type: "integer" } } }, required: ["a"] }), "x a:int b?:bool e?:p|q l?:[int]");
});

test("summary is the first sentence, cut at 100", () => {
  assert.equal(summary("Does a thing. Then more."), "Does a thing.");
  assert.equal(summary("x".repeat(150)).length, 100);
  assert.ok(summary("x".repeat(150)).endsWith("…"));
});

test("renderDoc lists properties, nesting objects", () => {
  const doc = renderDoc({ name: "x", description: "Does x.", inputSchema: { type: "object", properties: { a: { type: "integer", description: "the a", default: 3 }, o: { type: "object", properties: { p: { type: "string" } }, required: ["p"] } }, required: ["o"] } });
  assert.equal(doc, 'x o:obj a?:int\nDoes x.\n  a?: int — the a (default 3)\n  o: obj\n    p: str');
});

test("every real tool has a signature and a doc under 4,000 chars", () => {
  const { toolsForTest } = mcpFixture({ campaigns: true });
  for (const t of toolsForTest()) {
    assert.ok(signature(t.name, t.inputSchema).startsWith(t.name));
    assert.ok(renderDoc(t).length < 4000, `${t.name} doc is ${renderDoc(t).length} chars`);
  }
});

test("compact drops empties but keeps meaning", () => {
  assert.deepEqual(compact({ a: null, b: "", c: 0, d: false, e: [], f: [{ g: null, h: 1 }] }), { c: 0, d: false, e: [], f: [{ h: 1 }] });
});
test("pick projects through arrays", () => {
  const v = { accounts: [{ id: 1, name: "n", platform: "x" }], pendingJobs: 2 };
  assert.deepEqual(pick(v, ["accounts.id", "accounts.platform"]), { accounts: [{ id: 1, platform: "x" }] });
  assert.deepEqual(pick([{ a: 1, b: 2 }], ["a"]), [{ a: 1 }]);
  assert.deepEqual(pick(v, ["nope"]), {});
});
test("pick with no fields returns the value unchanged", () => {
  const v = { a: 1, b: [2] };
  assert.equal(pick(v, []), v);
});
test("parseFields accepts a comma string or an array", () => {
  assert.deepEqual(parseFields("a,b.c"), ["a", "b.c"]);
  assert.deepEqual(parseFields(["a", "b.c"]), ["a", "b.c"]);
  assert.equal(parseFields(undefined), undefined);
});
