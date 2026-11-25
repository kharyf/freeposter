import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { landscape60, makeVideo, newStore, tmp } from "./helpers.ts";
import { ResourceStore, resourcesDir, sniffKind, tagFrom, tagProblem } from "../src/resources/store.ts";

const png = (dir: string, name = "logo.png") => makeVideo(dir, name, ["-f", "lavfi", "-i", "color=red:s=640x480", "-frames:v", "1"]);
const mp3 = (dir: string, name = "song.mp3") => makeVideo(dir, name, ["-f", "lavfi", "-i", "sine=frequency=440", "-t", "3"]);
const fresh = () => new ResourceStore(newStore());

test("tagProblem accepts and refuses", () => {
  assert.equal(tagProblem("logo-2"), null);
  for (const bad of ["Logo", "-x", "", "a".repeat(33)]) assert.equal(typeof tagProblem(bad), "string", bad);
});

test("tagFrom slugs names", () => {
  assert.equal(tagFrom("My Logo (final).PNG"), "my-logo-final-png");
  assert.equal(tagFrom("!!!"), "resource");
});

test("sniffKind tells the four kinds apart", async () => {
  const dir = tmp();
  const img = (await sniffKind(png(dir), "logo.png")) as any;
  assert.equal(img.kind, "image");
  assert.equal(img.width, 640);
  assert.equal(img.height, 480);
  const aud = (await sniffKind(mp3(dir), "song.mp3")) as any;
  assert.equal(aud.kind, "audio");
  assert.ok(Math.abs(aud.durationSec - 3) < 0.3);
  assert.equal(((await sniffKind(landscape60(dir), "a.mp4")) as any).kind, "video");
  const txt = join(dir, "n.txt");
  writeFileSync(txt, "hello");
  assert.equal(((await sniffKind(txt, "n.txt")) as any).kind, "text");
  const bin = join(dir, "x.bin");
  writeFileSync(bin, Buffer.from([0, 255, 3, 4, 200, 1, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0]));
  const bad = await sniffKind(bin, "x.bin");
  assert.equal(typeof bad, "string");
  assert.match(bad as string, /text, audio, image or video/);
});

test("addFile stores under the set and makes a unique tag", async () => {
  const rs = fresh();
  const dir = tmp();
  const a = (await rs.addFile(1, png(dir, "a.png"), "logo.png")) as any;
  const b = (await rs.addFile(1, png(dir, "b.png"), "logo.png")) as any;
  assert.equal(a.tag, "logo-png");
  assert.equal(b.tag, "logo-png-2");
  assert.ok(existsSync(a.path) && a.path.startsWith(join(resourcesDir(), "1")));
  assert.ok(!existsSync(join(dir, "a.png")));
});

test("tags are unique per set, not globally", async () => {
  const rs = fresh();
  const dir = tmp();
  const a = (await rs.addFile(1, png(dir, "a.png"), "x.png", { tag: "brand" })) as any;
  const b = (await rs.addFile(2, png(dir, "b.png"), "x.png", { tag: "brand" })) as any;
  assert.equal(a.tag, "brand");
  assert.equal(b.tag, "brand");
  const c = (await rs.addFile(1, png(dir, "c.png"), "y.png", { tag: "other" })) as any;
  const r = rs.update(c.id, { tag: "brand" });
  assert.match(r as string, /already/);
});

test("oversized files are refused", () => {
  const rs = fresh();
  assert.match(rs.addText(1, "n", "x".repeat(1024 * 1024 + 1)) as string, /1 MB/);
});

test("remove is a soft delete", async () => {
  const rs = fresh();
  const a = (await rs.addFile(1, png(tmp()), "logo.png", { tag: "logo" })) as any;
  assert.equal(rs.remove(a.id), null);
  assert.equal(rs.list(1).length, 0);
  assert.equal(typeof rs.get(a.id)!.deletedAt, "number");
  assert.ok(existsSync(a.path));
  const again = (await rs.addFile(1, png(tmp()), "logo.png", { tag: "logo" })) as any;
  assert.equal(again.tag, "logo");
});

test("editing text writes a new file", () => {
  const rs = fresh();
  const a = rs.addText(1, "note", "old") as any;
  const b = rs.update(a.id, { text: "new" }) as any;
  assert.notEqual(b.path, a.path);
  assert.notEqual(b.sha256, a.sha256);
  assert.ok(existsSync(a.path));
  assert.equal(readFileSync(a.path, "utf8"), "old");
  assert.equal(rs.readText(b), "new");
});
