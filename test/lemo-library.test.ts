import "./isolated-home.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { lemoLibraryDir, readLemoLibrary, syncLemoLibrary } from "../src/campaigns/lemo-library.ts";
import { allLooks } from "../src/campaigns/looks.ts";
import { newStore, tmp } from "./helpers.ts";

// The fixture has broken styles, which are logged: the log is caught here so the test output stays clean.
let logged: string[] = [];
const realError = console.error;
beforeEach(() => { logged = []; console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); }; });
afterEach(() => { console.error = realError; });

function fixture(opts: { git?: boolean; pkg?: boolean } = {}): string {
  const dir = tmp();
  const style = (slug: string, body: string) => {
    mkdirSync(join(dir, "styles", slug), { recursive: true });
    writeFileSync(join(dir, "styles", slug, "style.json"), body);
  };
  style("impasto", JSON.stringify({ slug: "impasto", en: "Impasto Oil Painting", category_en: "Painting & Illustration", line: "Thick oil paint..." }));
  style("manga-panels", JSON.stringify({ slug: "manga-panels", en: "Manga Panels", line: "Inked panels", needs: ["image-generation"] }));
  style("_template", JSON.stringify({ slug: "template", en: "Template" }));
  style("broken", "{not json");
  style("no-slug", JSON.stringify({ en: "No Slug" }));
  if (opts.pkg !== false) writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));
  if (opts.git !== false) {
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, ".git", "refs", "heads", "main"), "00a7f9ec99c8d1e2f3a4b5c6d7e8f9a0b1c2d3e4\n");
  }
  return dir;
}

test("reads every style but the template and broken ones", () => {
  const lib = readLemoLibrary(fixture());
  assert.ok(lib);
  assert.deepEqual(lib.styles.map((s) => s.key), ["lemo:impasto", "lemo:manga-panels"]);
  assert.equal(lib.styles[0].category, "Painting & Illustration");
  assert.equal(lib.styles[0].needsImageGen, false);
  assert.equal(lib.styles[1].needsImageGen, true);
  assert.equal(lib.version, "2.0.0+00a7f9e");
});

test("version without git is just the package version, and unknown without package.json", () => {
  assert.equal(readLemoLibrary(fixture({ git: false }))?.version, "2.0.0");
  assert.equal(readLemoLibrary(fixture({ git: false, pkg: false }))?.version, "unknown");
});

test("the commit is found in packed-refs too", () => {
  const dir = fixture();
  rmSync(join(dir, ".git", "refs"), { recursive: true });
  writeFileSync(join(dir, ".git", "packed-refs"), "# pack-refs\nabcdef1234567890abcdef1234567890abcdef12 refs/heads/main\n");
  assert.equal(readLemoLibrary(dir)?.version, "2.0.0+abcdef1");
});

test("a missing library reads as null, and syncing it keeps the catalogue", () => {
  const store = newStore();
  const dir = fixture();
  assert.deepEqual(syncLemoLibrary(store, dir), { installed: true, added: 2, updated: 0, hidden: 0 });
  assert.equal(allLooks(store).find((l) => l.key === "lemo:impasto")?.category, "Painting & Illustration");
  assert.equal(readLemoLibrary(join(dir, "nope")), null);
  assert.deepEqual(syncLemoLibrary(store, join(dir, "nope")), { installed: false, added: 0, updated: 0, hidden: 0 });
  assert.equal(allLooks(store).length, 2);
});

test("a style removed from the library is hidden", () => {
  const store = newStore();
  const dir = fixture();
  syncLemoLibrary(store, dir);
  rmSync(join(dir, "styles", "impasto"), { recursive: true });
  assert.deepEqual(syncLemoLibrary(store, dir), { installed: true, added: 0, updated: 1, hidden: 1 });
  assert.deepEqual(allLooks(store).map((l) => l.key), ["lemo:manga-panels"]);
});

test("lemoLibraryDir prefers LEMO_OPUSCAR_HOME", () => {
  assert.equal(lemoLibraryDir({ LEMO_OPUSCAR_HOME: "/x/lemo" }, "/home/u"), "/x/lemo");
  assert.equal(lemoLibraryDir({}, join("/home", "u")), join("/home", "u", "lemo-opuscar"));
});

test("each style.json that can't be read is skipped and logged with its folder", () => {
  const dir = fixture();
  mkdirSync(join(dir, "styles", "empty"), { recursive: true }); // no style.json at all
  const lib = readLemoLibrary(dir);
  assert.deepEqual(lib?.styles.map((s) => s.key), ["lemo:impasto", "lemo:manga-panels"]);
  assert.equal(logged.length, 3);
  assert.ok(logged.some((l) => l.includes("broken") && l.includes("style.json")), logged.join(" | "));
  assert.ok(logged.some((l) => l.includes("no-slug")), logged.join(" | "));
  assert.ok(logged.some((l) => l.includes("empty")), logged.join(" | "));
  assert.ok(!logged.some((l) => l.includes("_template")), "the template isn't a style, so it isn't logged");
});

test("two folders with the same slug keep the first, log the other, and the sync still runs", () => {
  const dir = fixture();
  mkdirSync(join(dir, "styles", "zz-impasto-copy"), { recursive: true });
  writeFileSync(join(dir, "styles", "zz-impasto-copy", "style.json"), JSON.stringify({ slug: "impasto", en: "Impasto Copy" }));
  const lib = readLemoLibrary(dir);
  assert.deepEqual(lib?.styles.map((s) => s.key), ["lemo:impasto", "lemo:manga-panels"]);
  assert.equal(lib?.styles[0].name, "Impasto Oil Painting");
  assert.ok(logged.some((l) => l.includes("zz-impasto-copy") && l.includes("lemo:impasto")), logged.join(" | "));
  const store = newStore();
  assert.deepEqual(syncLemoLibrary(store, dir), { installed: true, added: 2, updated: 0, hidden: 0 });
});
