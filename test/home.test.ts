import "./isolated-home.ts"; // first: config.ts reads FREEPOSTER_HOME when it loads
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_PORT, homeFor } from "../src/config.ts";

const APPDATA = join("C:", "Users", "me", "AppData", "Roaming");

test("the installed app and a source checkout keep separate settings and data", () => {
  assert.equal(homeFor(true, { APPDATA }), join(APPDATA, "FreePoster"));
  assert.equal(homeFor(false, { APPDATA }), join(APPDATA, "FreePoster-dev"));
});

test("FREEPOSTER_HOME picks the folder for either edition", () => {
  assert.equal(homeFor(true, { APPDATA, FREEPOSTER_HOME: "D:\\fp" }), "D:\\fp");
  assert.equal(homeFor(false, { APPDATA, FREEPOSTER_HOME: " D:\\fp " }), "D:\\fp");
  assert.equal(homeFor(false, { APPDATA, FREEPOSTER_HOME: "  " }), join(APPDATA, "FreePoster-dev"), "blank means unset");
});

test("a source checkout listens on its own port, so it runs beside the installed app", () => {
  assert.equal(DEFAULT_PORT, 4401, "tests run from source");
});
