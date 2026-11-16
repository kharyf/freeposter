import "./isolated-home.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAccountSet, setNameProblem } from "../src/accounts.ts";
import { config } from "../src/config.ts";
import { allStyles, createStyle, defaultStyleId, deleteStyle, setDefaultStyle, styleById, styleNameProblem, thumbnailSvg, type EditingStyle } from "../src/edit/styles.ts";
import { publishers } from "../src/platforms/index.ts";
import { ReviewService } from "../src/review/service.ts";
import { Runner } from "../src/runner.ts";
import { buildServer } from "../src/server.ts";
import { multipart, newStore, tmp } from "./helpers.ts";

/** A real 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function made(r: EditingStyle | string): EditingStyle {
  assert.equal(typeof r, "object", String(r));
  return r as EditingStyle;
}

test("a new style is listed after the built-in ones, with its steps, and can be the default", () => {
  const store = newStore();
  const style = made(createStyle(store, { name: "  Fast   Cuts ", description: "Quick and loud.", steps: { captions: false } }));
  assert.equal(style.id, "fast-cuts");
  assert.equal(style.name, "Fast Cuts");
  assert.deepEqual(style.settings, { tighten: true, captions: false, reframe: true, audio: true, punchIn: true });
  assert.deepEqual(allStyles(store).map((s) => [s.id, s.builtIn]), [["basic", true], ["fast-cuts", false]]);
  assert.equal(defaultStyleId(store), "basic");
  assert.equal(setDefaultStyle(store, "fast-cuts"), true);
  assert.equal(defaultStyleId(store), "fast-cuts");
});

test("a style's name must work as a filename part", () => {
  const store = newStore();
  createAccountSet(store, "Client A");
  made(createStyle(store, { name: "Moody" }));
  for (const [name, why] of [
    ["", /name/],
    ["Has_Underscore", /underscore/],
    ["raw", /RAW/],
    ["11.1.26", /date or time/],
    ["5.30pm", /date or time/],
    ["basic", /already the editing style Basic/],
    ["MOODY", /already the editing style Moody/],
    ["Client A", /account set Client A/],
    ["a/b", /filenames/],
    ["x".repeat(41), /40/],
  ] as const) {
    assert.match(String(styleNameProblem(store, name)), why, name);
    assert.equal(typeof createStyle(store, { name }), "string", name);
  }
  assert.match(String(createStyle(store, { name: "Off", steps: { tighten: false, captions: false, reframe: false, audio: false, punchIn: false } })), /at least one step/);
  assert.match(String(createStyle(store, { name: "Odd", steps: { keep: true } as never })), /not a step/);
  assert.match(String(createStyle(store, { name: "Long", description: "x".repeat(501) })), /500/);
  // and a set can't take a user's style name either
  assert.match(String(setNameProblem(store, "Moody")), /editing style Moody/);
});

test("deleting hides a style but videos already given it keep its edit; built-in ones stay", () => {
  const store = newStore();
  const style = made(createStyle(store, { name: "Quiet", steps: { audio: false } }));
  setDefaultStyle(store, style.id);
  assert.equal(deleteStyle(store, "basic"), "built-in styles can't be deleted");
  assert.equal(deleteStyle(store, style.id), null);
  assert.equal(deleteStyle(store, style.id), "no such editing style");
  assert.deepEqual(allStyles(store).map((s) => s.id), ["basic"]);
  assert.equal(styleById(store, style.id)?.settings.audio, false, "still found for a video on its way");
  assert.equal(defaultStyleId(store), "basic", "the default goes back to the first");
  assert.equal(setDefaultStyle(store, style.id), false);
  // the name is free again, under a new id
  assert.equal(made(createStyle(store, { name: "Quiet" })).id, "quiet-2");
});

test("the drawn thumbnail shows each step", () => {
  const all = thumbnailSvg({ tighten: true, captions: true, reframe: true, audio: true, punchIn: true });
  const none = thumbnailSvg({ tighten: false, captions: false, reframe: false, audio: false, punchIn: false });
  assert.match(all, /^<svg xmlns/);
  assert.match(all, /ONE/, "a caption");
  assert.doesNotMatch(none, /ONE/);
  assert.match(all, /stroke-dasharray/, "cut marks on the timeline");
  assert.doesNotMatch(none, /stroke-dasharray/);
  assert.match(none, /<svg x="0" y=/, "a letterboxed wide frame without reframe");
});

function server() {
  const store = newStore();
  const runner = new Runner(store, publishers, tmp());
  const reviews = new ReviewService(store, { publishers, runner, dir: tmp() });
  const app = buildServer(store, runner, publishers, {}, undefined, undefined, undefined, { service: reviews });
  return { store, app };
}

test("the window adds a style with a thumbnail, shows it, and deletes it", async () => {
  const { store, app } = server();
  const status = async () => (await app.inject("/api/status")).json();
  const basic = (await status()).editingStyles[0];
  assert.equal(basic.builtIn, true);
  assert.deepEqual(basic.steps, { tighten: true, captions: true, reframe: true, audio: true, punchIn: true });
  let thumb = await app.inject(basic.thumbnailUrl);
  assert.equal(thumb.statusCode, 200);
  assert.match(thumb.headers["content-type"] as string, /image\/svg\+xml/, "built-in styles get a drawn thumbnail");
  assert.match((await app.inject("/api/styles/thumbnail-preview?captions=0")).body, /<svg/);

  const post = (fields: Record<string, string>, file?: Buffer) =>
    app.inject({ method: "POST", url: "/api/styles", ...multipart(fields, file && { name: "t.png", data: file }) });
  let res = await post({ name: "Bad_Name" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /underscore/);
  res = await post({ name: "Clean", steps: "{}" }, Buffer.from("not an image"));
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /PNG, JPEG or WebP/);
  assert.equal(allStyles(store).length, 1, "nothing made when the image is refused");

  res = await post({ name: "Clean Look", description: "No captions.", steps: JSON.stringify({ captions: false }), makeDefault: "true" }, PNG);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { id: "clean-look", name: "Clean Look", token: "CleanLook" });
  const s = (await status()).editingStyles.find((x: any) => x.id === "clean-look");
  assert.equal(s.isDefault, true);
  assert.equal(s.builtIn, false);
  assert.equal(s.steps.captions, false);
  assert.match(s.thumbnailUrl, /\?v=/);
  thumb = await app.inject(s.thumbnailUrl);
  assert.equal(thumb.headers["content-type"], "image/png");
  assert.deepEqual(thumb.rawPayload, PNG);

  assert.equal((await app.inject({ method: "DELETE", url: "/api/styles/basic" })).statusCode, 400);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/styles/clean-look" })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/styles/clean-look" })).statusCode, 404);
  assert.deepEqual((await status()).editingStyles.map((x: any) => x.id), ["basic"]);
});

test("an agent lists the styles and adds one over MCP", async () => {
  const { store, app } = server();
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await app.inject({ method: "POST", url: "/mcp", headers: { host: `localhost:${config.port}` }, payload: { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } } })).json().result;

  let r = await call("list_editing_styles");
  assert.deepEqual(r.structuredContent.styles.map((s: any) => [s.id, s.filename_token, s.default, s.built_in]), [["basic", "Basic", true, true]]);
  assert.deepEqual(r.structuredContent.steps.map((s: any) => s.key), ["tighten", "captions", "reframe", "audio", "punchIn"]);

  r = await call("add_editing_style", { name: "Basic" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /already the editing style Basic/);
  r = await call("add_editing_style", { name: "Thumb", thumbnail_path: "relative.png" });
  assert.equal(r.isError, true);
  const dir = tmp();
  const png = join(dir, "thumb.png");
  writeFileSync(png, PNG);

  r = await call("add_editing_style", { name: "Talking Head", description: "Captions and sound only.", steps: { reframe: false, punchIn: false }, thumbnail_path: png });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const style = r.structuredContent.style;
  assert.equal(style.filename_token, "TalkingHead");
  assert.equal(style.custom_thumbnail, true);
  assert.equal(style.default, false);
  assert.deepEqual(style.steps, { tighten: true, captions: true, reframe: false, audio: true, punchIn: false });
  assert.match(r.structuredContent.next, /_TalkingHead\.mp4/);
  assert.equal(styleById(store, "talking-head")?.description, "Captions and sound only.");

  r = await call("add_editing_style", { name: "Loud", make_default: true });
  assert.equal(r.structuredContent.style.default, true);
  assert.equal(defaultStyleId(store), "loud");
});

test("a Drive filename can name a style the user added", async () => {
  const { Intake } = await import("../src/drive/intake.ts");
  const { parseDriveName } = await import("../src/drive/filename.ts");
  const store = newStore();
  const runner = new Runner(store, publishers, tmp());
  const intake = new Intake(store, publishers, {
    download: async () => { throw new Error("offline"); },
    transcribe: async () => ({ words: [], language: null }),
    writeCaption: async () => ({ title: "t", caption: "c" }),
    reviews: new ReviewService(store, { publishers, runner, dir: tmp() }),
  });
  made(createStyle(store, { name: "Fast Cuts" }));
  const parsed = parseDriveName("Tip_11.1.26_5.30.pm_FastCuts.mp4", Date.now(), intake.vocabulary());
  assert.equal(parsed.ok && parsed.styleId, "fast-cuts");
});
