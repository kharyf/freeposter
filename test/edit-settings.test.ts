import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_EDIT, editKey, isFancy, isSlideshow, MAX_INSTRUCTIONS, parseEditSettings, publicSettings, type ResourceUse } from "../src/edit/settings.ts";

test("Basic edit keys are unchanged by the look field", () => {
  assert.equal(editKey("abc", DEFAULT_EDIT), editKey("abc", { ...DEFAULT_EDIT, look: undefined }));
  assert.equal(editKey("abc", DEFAULT_EDIT), "abc-f9bba6b9f9ebd006");
  assert.notEqual(editKey("abc", { ...DEFAULT_EDIT, look: "fancy" }), editKey("abc", DEFAULT_EDIT));
});

test("parseEditSettings accepts look fancy only", () => {
  assert.equal(parseEditSettings({ look: "fancy" }).look, "fancy");
  assert.throws(() => parseEditSettings({ look: "moody" }), /look/);
});

test("isFancy is true only for the fancy look", () => {
  assert.equal(isFancy(DEFAULT_EDIT), false);
  assert.equal(isFancy({ ...DEFAULT_EDIT, look: "fancy" }), true);
});

test("parseEditSettings accepts look slideshow and instructions", () => {
  assert.equal(parseEditSettings({ look: "slideshow" }).look, "slideshow");
  assert.equal(isSlideshow(parseEditSettings({ look: "slideshow" })), true);
  assert.equal(isSlideshow({ ...DEFAULT_EDIT, look: "fancy" }), false);
  assert.throws(() => parseEditSettings({ look: "x" }), /fancy" or "slideshow/);
  assert.throws(() => parseEditSettings({ instructions: "a".repeat(MAX_INSTRUCTIONS + 1) }), /instructions/);
  assert.equal(parseEditSettings({ instructions: "  hi  " }).instructions, "hi");
  assert.equal(parseEditSettings({ instructions: "   " }).instructions, undefined);
});

test("resources and setId are chosen beside the settings, not inside them", () => {
  assert.throws(() => parseEditSettings({ resources: [] }), /chosen by tag/);
  assert.throws(() => parseEditSettings({ setId: 1 }), /chosen by tag/);
  const use: ResourceUse = { id: 1, tag: "a", kind: "image", path: "/p/a.png", sha256: "s1", as: "overlay" };
  const out = parseEditSettings({ captions: false }, { ...DEFAULT_EDIT, setId: 2, resources: [use] });
  assert.deepEqual(out.resources, [use]);
  assert.equal(out.setId, 2);
});

test("editKey: instructions and resources change it, setId does not", () => {
  const use: ResourceUse = { id: 1, tag: "a", kind: "image", path: "/p/a.png", sha256: "s1", as: "overlay" };
  const k = editKey("abc", DEFAULT_EDIT);
  assert.equal(editKey("abc", { ...DEFAULT_EDIT, setId: 3 }), k);
  assert.equal(editKey("abc", { ...DEFAULT_EDIT, resources: [] }), k);
  assert.notEqual(editKey("abc", { ...DEFAULT_EDIT, instructions: "x" }), k);
  const withUse = editKey("abc", { ...DEFAULT_EDIT, resources: [use] });
  assert.notEqual(withUse, k);
  assert.notEqual(editKey("abc", { ...DEFAULT_EDIT, resources: [{ ...use, sha256: "s2" }] }), withUse);
  assert.equal(editKey("abc", { ...DEFAULT_EDIT, resources: [{ ...use, path: "/elsewhere.png" }] }), withUse);
});

test("publicSettings hides paths and hashes", () => {
  const use: ResourceUse = { id: 1, tag: "a", kind: "image", path: "/p/a.png", sha256: "s1", as: "overlay" };
  const pub = publicSettings({ ...DEFAULT_EDIT, resources: [use] });
  assert.deepEqual(pub.resources, [{ id: 1, tag: "a", kind: "image", as: "overlay" }]);
  assert.ok(!JSON.stringify(pub).includes("/p/a.png"));
});
