import "./isolated-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_EDIT, editKey, isFancy, parseEditSettings } from "../src/edit/settings.ts";

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
