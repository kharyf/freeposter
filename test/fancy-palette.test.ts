import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assHex, fancyFontDir, fancyFontFile, PALETTE } from "../src/edit/fancy/palette.ts";

test("ASS colours are BGR with alpha", () => {
  assert.equal(assHex(PALETTE.yellow), "&H003FD2FF");
  assert.equal(assHex("#000000", 0.6), "&H66000000");
});
test("the Fancy fonts ship", () => {
  for (const w of ["italic", "boldItalic"] as const) assert.ok(statSync(fancyFontFile(w)).size > 50_000);
  assert.ok(existsSync(join(fancyFontDir(), "OFL.txt")));
});
