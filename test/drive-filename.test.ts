import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDriveName } from "../src/drive/filename.ts";

const ok = (name: string) => {
  const r = parseDriveName(name);
  assert.ok(r.ok, `${name}: ${!r.ok && r.reason}`);
  return r;
};
const bad = (name: string, reason: RegExp) => {
  const r = parseDriveName(name);
  assert.equal(r.ok, false, name);
  if (!r.ok) assert.match(r.reason, reason);
};

test("the example from the brief", () => {
  const r = ok("Gatekeeping_11.1.26_5.30.pm.mp4");
  assert.equal(r.name, "Gatekeeping");
  assert.equal(r.at, new Date(2026, 10, 1, 17, 30).getTime());
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
  bad("Gatekeeping_11.1.26.mp4", /name_m\.d\.yy_h\.mm\.am/);
  bad("Gatekeeping.mp4", /name_m\.d\.yy_h\.mm\.am/);
  bad("_11.1.26_5.30.pm.mp4", /name/);
  bad("Gatekeeping_11.1.2026_5.30.pm.mp4", /date/);
});
