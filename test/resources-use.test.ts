import "./isolated-home.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createAccountSet } from "../src/accounts.ts";
import { defaultRole, mentionedTags, parseRefs, resolveResources } from "../src/resources/use.ts";
import { ResourceStore } from "../src/resources/store.ts";
import { makeVideo, newStore, tmp } from "./helpers.ts";

const png = () => makeVideo(tmp(), "a.png", ["-f", "lavfi", "-i", "color=red:s=64x64", "-frames:v", "1"]);
const mp3 = () => makeVideo(tmp(), "a.mp3", ["-f", "lavfi", "-i", "sine=frequency=440", "-t", "2"]);

async function setup() {
  const store = newStore();
  const rs = new ResourceStore(store);
  const logo = (await rs.addFile(1, png(), "logo.png", { tag: "logo" })) as any;
  const song = (await rs.addFile(1, mp3(), "song.mp3", { tag: "song" })) as any;
  const note = rs.addText(1, "Notes", "hello", "notes") as any;
  return { store, rs, logo, song, note };
}

test("mentionedTags finds @tags in order, lowercase, once", () => {
  assert.deepEqual(mentionedTags("use @logo and @Song, @logo"), ["logo", "song"]);
  assert.deepEqual(mentionedTags(undefined), []);
});

test("mentionedTags ignores @ inside words", () => {
  assert.deepEqual(mentionedTags("mail a@b.com or see https://x.com/@me"), []);
  assert.deepEqual(mentionedTags("(@logo)"), ["logo"]);
});

test("parseRefs checks the shape", () => {
  assert.deepEqual(parseRefs(undefined), []);
  assert.deepEqual(parseRefs([{ tag: "@Logo", as: "slide" }, { tag: "song" }]), [{ tag: "logo", as: "slide" }, { tag: "song" }]);
  assert.throws(() => parseRefs("x"), /list/);
  assert.throws(() => parseRefs([{}]), /tag/);
  assert.throws(() => parseRefs([{ tag: "a", as: "bogus" }]), /as/);
});

test("default roles by kind and look", () => {
  assert.equal(defaultRole("image", "slideshow"), "slide");
  assert.equal(defaultRole("image", undefined), "overlay");
  assert.equal(defaultRole("audio", undefined), "music");
  assert.equal(defaultRole("video", "fancy"), "clip");
  assert.equal(defaultRole("text", undefined), "context");
});

test("resolveResources uses refs and mentions, nothing else", async () => {
  const { store, rs } = await setup();
  assert.deepEqual(resolveResources(rs, store, 1, [], "no tags here", undefined), []);
  const slide = resolveResources(rs, store, 1, [], "show @logo", "slideshow") as any[];
  assert.equal(slide[0].as, "slide");
  assert.equal(slide[0].tag, "logo");
  assert.ok(slide[0].path && slide[0].sha256);
  const overlay = resolveResources(rs, store, 1, [{ tag: "logo" }], undefined, undefined) as any[];
  assert.equal(overlay[0].as, "overlay");
  const both = resolveResources(rs, store, 1, [{ tag: "logo", as: "slide" }], "@logo @song", "slideshow") as any[];
  assert.deepEqual(both.map((u) => [u.tag, u.as]), [["logo", "slide"], ["song", "music"]]);
});

test("resolveResources errors", async () => {
  const { store, rs } = await setup();
  assert.equal(resolveResources(rs, store, 1, [{ tag: "nope" }], undefined, undefined), "no resource tagged @nope in the account set Personal Brand");
  assert.match(resolveResources(rs, store, 1, [{ tag: "logo", as: "music" }], undefined, undefined) as string, /@logo is image: it can be used as slide or overlay/);
  assert.equal(resolveResources(rs, store, 1, [{ tag: "logo", as: "slide" }], undefined, "fancy"), "slide is only for the Slideshow style");
  const second = (await rs.addFile(1, mp3(), "b.mp3", { tag: "song2" })) as any;
  assert.equal(second.tag, "song2");
  assert.equal(resolveResources(rs, store, 1, [{ tag: "song" }, { tag: "song2" }], undefined, undefined), "only one music resource per edit");
  const other = createAccountSet(store, "Other") as any;
  assert.match(resolveResources(rs, store, other.id, [{ tag: "logo" }], undefined, undefined) as string, /no resource tagged @logo in the account set Other/);
});

test("resolveResources limits", async () => {
  const { store, rs } = await setup();
  for (let i = 0; i < 41; i++) rs.addText(1, `t${i}`, "x", `t${i}`);
  const texts = Array.from({ length: 41 }, (_, i) => ({ tag: `t${i}` }));
  assert.equal(resolveResources(rs, store, 1, texts.slice(0, 5), undefined, undefined).length, 5);
  assert.equal(resolveResources(rs, store, 1, texts, undefined, undefined), "an edit takes at most 40 resources");
  for (let i = 0; i < 31; i++) await rs.addFile(1, png(), `p${i}.png`, { tag: `p${i}` });
  const imgs = Array.from({ length: 31 }, (_, i) => ({ tag: `p${i}` }));
  assert.equal(resolveResources(rs, store, 1, imgs, undefined, "slideshow"), "a slideshow takes at most 30 slides and clips");
});

test("keep entries survive even if the resource was since deleted", async () => {
  const { store, rs, logo } = await setup();
  const first = resolveResources(rs, store, 1, [{ tag: "logo" }], undefined, undefined) as any[];
  rs.remove(logo.id);
  const again = resolveResources(rs, store, 1, [], undefined, undefined, first) as any[];
  assert.deepEqual(again.map((u) => u.tag), ["logo"]);
  assert.match(resolveResources(rs, store, 1, [{ tag: "logo" }], undefined, undefined) as string, /no resource tagged/);
});
