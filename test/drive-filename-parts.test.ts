// The filename pattern with an editing style and an account set: {name}_{date}_{time}_{style}_{set}_[RAW].
// (drive-filename.test.ts covers the older rules, still used for files that arrived before.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDriveName, type NameVocabulary } from "../src/drive/filename.ts";

const UPLOADED = new Date(2026, 10, 1, 10, 0).getTime();
const VOCAB: NameVocabulary = {
  styles: [{ id: "basic", token: "Basic" }],
  sets: [{ id: 1, token: "PersonalBrand" }, { id: 2, token: "Bumplz" }],
};
const ok = (name: string) => {
  const r = parseDriveName(name, UPLOADED, VOCAB);
  assert.ok(r.ok, `${name}: ${!r.ok && r.reason}`);
  return r;
};
const bad = (name: string, reason: RegExp) => {
  const r = parseDriveName(name, UPLOADED, VOCAB);
  assert.equal(r.ok, false, name);
  if (!r.ok) assert.match(r.reason, reason, name);
};

test("every part, in order", () => {
  const r = ok("Gatekeeping_11.1.26_5.30.pm_Basic_PersonalBrand.mp4");
  assert.equal(r.name, "Gatekeeping");
  assert.equal(r.at, new Date(2026, 10, 1, 17, 30).getTime());
  assert.equal(r.styleId, "basic");
  assert.equal(r.setId, 1);
  assert.equal(r.raw, false);
});

test("any part after the name may be left off; what's left off is null (the defaults)", () => {
  const plain = ok("Gatekeeping.mp4");
  assert.deepEqual([plain.styleId, plain.setId, plain.raw], [null, null, false]);
  assert.equal(plain.at, new Date(2026, 10, 1).getTime());
  assert.equal(ok("Gatekeeping_Bumplz.mp4").setId, 2);
  assert.equal(ok("Gatekeeping_Basic").styleId, "basic");
  assert.equal(ok("Gatekeeping_5pm_Bumplz").setId, 2);
  assert.equal(ok("Gatekeeping_11.3.26_Basic").at, new Date(2026, 10, 3).getTime());
  const raw = ok("Gatekeeping_11.1.26_5.30.pm_PersonalBrand_RAW.mp4");
  assert.deepEqual([raw.styleId, raw.setId, raw.raw], [null, 1, true]);
  assert.equal(ok("Gatekeeping_raw").raw, true);
});

test("styles and sets match ignoring case", () => {
  const r = ok("Gatekeeping_basic_personalbrand.mp4");
  assert.deepEqual([r.styleId, r.setId], ["basic", 1]);
  assert.equal(ok("Gatekeeping_BUMPLZ").setId, 2);
});

test("underscores only separate parts: an unknown part refuses the file, naming the choices", () => {
  bad("My_Big_Idea.mov", /"Big" isn't a date, a time, an editing style \(Basic\), an account set \(PersonalBrand, Bumplz\) or RAW/);
  bad("Gatekeeping_11.1.26_Basci.mp4", /"Basci" isn't/);
  bad("Gatekeeping_11.1.26_v2.mp4", /"v2" isn't/);
  bad("Gatekeeping_Personal Brand.mp4", /"Personal Brand" isn't/);
  bad("Gatekeeping__Basic.mp4", /empty part/);
  bad("Gatekeeping_Basic_.mp4", /empty part/);
});

test("parts out of order, or twice, are refused", () => {
  bad("Gatekeeping_PersonalBrand_Basic.mp4", /editing style "Basic" is out of place/);
  bad("Gatekeeping_5.30.pm_11.1.26.mp4", /date "11.1.26" is out of place/);
  bad("Gatekeeping_Basic_11.1.26.mp4", /out of place/);
  bad("Gatekeeping_Bumplz_PersonalBrand.mp4", /account set "PersonalBrand" is out of place/);
  bad("Gatekeeping_RAW_11.1.26.mp4", /_RAW goes at the end/);
  bad("Gatekeeping_RAW_Bumplz.mp4", /_RAW goes at the end/);
});

test("a RAW video isn't edited, so it can't take a style", () => {
  bad("Gatekeeping_Basic_RAW.mp4", /RAW video isn't edited/);
});

test("the name is required, and dates and times are still checked", () => {
  bad("_Basic.mp4", /name part is missing/);
  bad("11.1.26_Basic.mp4", /name part is missing/);
  bad("Gatekeeping_2.30.26_Basic.mp4", /not a real date/);
  bad("Gatekeeping_13:00pm_Basic", /not a valid time/);
  assert.equal(ok("RAW.mp4").name, "RAW", "a name of just RAW is a name");
  assert.equal(ok("Basic.mp4").name, "Basic", "so is a style's word");
});
