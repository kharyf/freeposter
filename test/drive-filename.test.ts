import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDriveName } from "../src/drive/filename.ts";

/** uploaded 1 November 2026, 10:00 local */
const UPLOADED = new Date(2026, 10, 1, 10, 0).getTime();
const ok = (name: string, uploadedAt = UPLOADED) => {
  const r = parseDriveName(name, uploadedAt);
  assert.ok(r.ok, `${name}: ${!r.ok && r.reason}`);
  return r;
};
const bad = (name: string, reason: RegExp) => {
  const r = parseDriveName(name, UPLOADED);
  assert.equal(r.ok, false, name);
  if (!r.ok) assert.match(r.reason, reason);
};

test("the example from the brief", () => {
  const r = ok("Gatekeeping_11.1.26_5.30.pm.mp4");
  assert.equal(r.name, "Gatekeeping");
  assert.equal(r.at, new Date(2026, 10, 1, 17, 30).getTime());
  assert.equal(r.latest, r.at, "a set time is late once it passes");
});

test("names may contain underscores, am/pm any case, no extension needed", () => {
  const r = ok("My_Big_Idea_1.15.27_12.05.AM.mov");
  assert.equal(r.name, "My_Big_Idea");
  assert.equal(r.at, new Date(2027, 0, 15, 0, 5).getTime());
  assert.equal(ok("Talk_01.05.27_9.00.am").at, new Date(2027, 0, 5, 9, 0).getTime());
});

test("noon and midnight", () => {
  assert.equal(ok("A_3.4.27_12.00.pm.mp4").at, new Date(2027, 2, 4, 12, 0).getTime());
  assert.equal(ok("A_3.4.27_12.00.am.mp4").at, new Date(2027, 2, 4, 0, 0).getTime());
});

test("invalid names say why", () => {
  bad("Gatekeeping_2.30.26_5.30.pm.mp4", /not a real date/);
  bad("Gatekeeping_11.1.26_13.00.pm.mp4", /time/);
  bad("Gatekeeping_11.1.26_5.7.pm.mp4", /time/);
  bad("_11.1.26_5.30.pm.mp4", /name/);
  bad("Gatekeeping_11.1.2026_5.30.pm.mp4", /date/);
});

test("no time: as soon as possible on the date", () => {
  const r = ok("Gatekeeping_11.3.26.mp4");
  assert.equal(r.name, "Gatekeeping");
  assert.equal(r.at, new Date(2026, 10, 3).getTime());
  assert.equal(r.latest, new Date(2026, 10, 4).getTime() - 1, "on time until the day ends");
  assert.equal(ok("Gatekeeping_11.3.26").at, new Date(2026, 10, 3).getTime(), "no extension");
});

test("no date: the upload date", () => {
  const r = ok("Gatekeeping_5.30.pm.mp4");
  assert.equal(r.name, "Gatekeeping");
  assert.equal(r.at, new Date(2026, 10, 1, 17, 30).getTime());
  assert.equal(r.latest, r.at);
  assert.equal(ok("A_9.00.am.mov", new Date(2027, 0, 15, 23, 0).getTime()).at, new Date(2027, 0, 15, 9, 0).getTime());
});

test("no date or time: as soon as possible on the upload date", () => {
  const r = ok("My_Big_Idea.mov");
  assert.equal(r.name, "My_Big_Idea");
  assert.equal(r.at, new Date(2026, 10, 1).getTime());
  assert.equal(r.latest, new Date(2026, 10, 2).getTime() - 1);
  assert.equal(ok("Top_10.mp4").name, "Top_10", "a plain number is part of the name");
});

test("a mistyped date or time is never mistaken for part of the name", () => {
  bad("Gatekeeping_11.1.26_5.30pm.mp4", /time/);
  bad("Gatekeeping_5.30pm.mp4", /time/);
  bad("Gatekeeping_5.30.mp4", /date/);
  bad("Gatekeeping_11.1.2026.mp4", /date/);
  bad("Gatekeeping_5.30.pm_11.1.26.mp4", /name_m\.d\.yy_h\.mm\.am/);
  bad("Gatekeeping_11.1.26_v2.mp4", /name_m\.d\.yy_h\.mm\.am/);
  bad("_5.30.pm.mp4", /name/);
  bad("11.1.26.mp4", /name/);
});
