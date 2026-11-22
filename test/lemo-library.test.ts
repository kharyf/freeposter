import "./isolated-home.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lemoLibraryDir, readLemoLibrary, syncLemoLibrary } from "../src/campaigns/lemo-library.ts";
import { allLooks } from "../src/campaigns/looks.ts";
import { newStore, tmp } from "./helpers.ts";

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
