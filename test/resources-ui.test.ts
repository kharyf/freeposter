import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/index.html", "utf8");

test("the Resources tab is in the page", () => {
  assert.match(html, /data-tab="resources"/);
  assert.match(html, /\/api\/resources/);
  assert.ok(html.includes("No resources yet. Files here are only used by an edit when you tag them (@tag)."));
});
