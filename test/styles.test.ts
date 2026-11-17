import "./isolated-home.ts";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createAccountSet, setNameProblem } from "../src/accounts.ts";
import { config, dataDir } from "../src/config.ts";
import { DEFAULT_EDIT } from "../src/edit/settings.ts";
import { allStyles, createStyle, defaultStyleId, deleteStyle, fancyToolNote, migrateFancyName, saveThumbnail, setDefaultStyle, styleById, styleNameProblem, thumbnail, thumbnailSvg, type EditingStyle } from "../src/edit/styles.ts";
import { publishers } from "../src/platforms/index.ts";
import { ReviewService } from "../src/review/service.ts";
import { Runner } from "../src/runner.ts";
import { buildServer, fancyHealthCheck } from "../src/server.ts";
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
  assert.deepEqual(allStyles(store).map((s) => [s.id, s.builtIn]), [["basic", true], ["fancy", true], ["fast-cuts", false]]);
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
  assert.deepEqual(allStyles(store).map((s) => s.id), ["basic", "fancy"]);
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

function server(producer?: unknown) {
  const store = newStore();
  const runner = new Runner(store, publishers, tmp());
  const reviews = new ReviewService(store, { publishers, runner, dir: tmp() });
  const app = buildServer(store, runner, publishers, {}, undefined, undefined, producer as never, { service: reviews });
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
  assert.equal(allStyles(store).length, 2, "nothing made when the image is refused");

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
  assert.deepEqual((await status()).editingStyles.map((x: any) => x.id), ["basic", "fancy"]);
});

test("an agent lists the styles and adds one over MCP", async () => {
  const { store, app } = server();
  let id = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await app.inject({ method: "POST", url: "/mcp", headers: { host: `localhost:${config.port}` }, payload: { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } } })).json().result;

  let r = await call("list_editing_styles");
  assert.deepEqual(r.structuredContent.styles.map((s: any) => [s.id, s.filename_token, s.default, s.built_in]), [["basic", "Basic", true, true], ["fancy", "Fancy", false, true]]);
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

test("Fancy is a built-in style after Basic", () => {
  const store = newStore();
  assert.deepEqual(allStyles(store).map((s) => [s.id, s.builtIn]), [["basic", true], ["fancy", true]]);
  assert.equal(styleById(store, "fancy")!.settings.look, "fancy");
  assert.equal(deleteStyle(store, "fancy"), "built-in styles can't be deleted");
  assert.match(styleNameProblem(store, "fancy")!, /already the editing style Fancy/);
});

test("user styles can't set look", () => {
  assert.equal(createStyle(newStore(), { name: "X", steps: { look: true } as any }), "look is not a step a style can set; the steps are tighten, captions, reframe, audio, punchIn");
});

test("a user's own Fancy style is renamed My Fancy once", () => {
  const store = newStore();
  store.setPref("edit.customStyles", [{ id: "fancy-2", name: "Fancy", description: "", settings: DEFAULT_EDIT, createdAt: 1 }]);
  assert.equal(migrateFancyName(store), "My Fancy");
  assert.equal(styleById(store, "fancy-2")!.name, "My Fancy");
  assert.equal(migrateFancyName(store), null);
});

test("the renamed Fancy style avoids a taken My Fancy and skips deleted styles", () => {
  const store = newStore();
  store.setPref("edit.customStyles", [
    { id: "my-fancy", name: "My Fancy", description: "", settings: DEFAULT_EDIT, createdAt: 1 },
    { id: "fancy-2", name: "fancy", description: "", settings: DEFAULT_EDIT, createdAt: 2 },
    { id: "fancy-3", name: "Fancy", description: "", settings: DEFAULT_EDIT, createdAt: 3, deleted: true },
  ]);
  assert.equal(migrateFancyName(store), "My Fancy 2");
  assert.equal(styleById(store, "fancy-3")!.name, "Fancy");
});

test("Fancy's card is its own drawing with an embedded serif font", () => {
  const t = thumbnail(styleById(newStore(), "fancy")!);
  assert.equal(t.type, "image/svg+xml");
  const svg = String(t.body);
  assert.match(svg, /^<svg xmlns/);
  assert.match(svg, /@font-face\{font-family:'Fancy';src:url\(data:font\/ttf;base64,/);
  assert.match(svg, /font-family="Fancy, Georgia, serif"/, "falls back to Georgia italic");
  assert.match(svg, /font-style="italic"/);
  assert.match(svg, /#FFD23F/, "SECRET in yellow");
  assert.match(svg, /#E8B923/, "the gold seam and coin");
  assert.match(svg, /#14110F/, "ink behind the graphic");
  assert.match(svg, />the one </);
  assert.match(svg, />SECRET</);
  assert.match(svg, /3×/);
  assert.match(svg, /url\(#shirt\)/, "the speaker, drawn like Basic's");
  assert.match(svg, /stroke-linecap="round" fill="none"/, "zoom corner marks");
  assert.notEqual(svg, thumbnailSvg(styleById(newStore(), "basic")!.settings), "not Basic's card");
  // the base64 is a real TrueType font
  const font = Buffer.from(/base64,([A-Za-z0-9+/=]+)\)/.exec(svg)![1], "base64");
  assert.deepEqual([...font.subarray(0, 4)], [0, 1, 0, 0]);
});

test("Basic's drawn card is unchanged by the Fancy card", () => {
  const t = thumbnail(styleById(newStore(), "basic")!);
  assert.equal(t.body, thumbnailSvg(styleById(newStore(), "basic")!.settings));
});

test("an uploaded image still wins over Fancy's card", () => {
  saveThumbnail("fancy", PNG);
  try {
    const t = thumbnail(styleById(newStore(), "fancy")!);
    assert.equal(t.type, "image/png");
    assert.deepEqual(t.body, PNG);
  } finally {
    rmSync(join(dataDir, "styles", "fancy.thumbnail.png"), { force: true });
  }
});

test("the Fancy tool note names each missing or broken tool and where its graphics go", () => {
  const good = { ok: true, detail: "" };
  const missing = { ok: false, detail: "not there", missing: true };
  const all = { remotion: good, hyperframes: good, blender: good };
  assert.equal(fancyToolNote(all), null);
  assert.equal(fancyToolNote({ ...all, blender: missing }), "Blender isn't installed: 3D graphics will be made with HyperFrames or as keyword cards");
  assert.equal(fancyToolNote({ ...all, remotion: missing }), "Remotion isn't installed: counter, list, comparison, quote and step graphics will be made with HyperFrames or as keyword cards");
  assert.equal(fancyToolNote({ ...all, hyperframes: missing }), "HyperFrames isn't installed: moving-word and icon graphics will be made as keyword cards");
  assert.equal(fancyToolNote({ remotion: good, hyperframes: missing, blender: missing }),
    "HyperFrames isn't installed: moving-word and icon graphics will be made as keyword cards; Blender isn't installed: 3D graphics will be made as keyword cards");
  // installed but failing its check: says why, on one line
  assert.equal(fancyToolNote({ ...all, blender: { ok: false, detail: "Error: EPERM\n  spawning blender.exe " } }),
    "Blender isn't working (Error: EPERM spawning blender.exe): 3D graphics will be made with HyperFrames or as keyword cards");
  assert.equal(fancyToolNote({ ...all, remotion: { ok: false, detail: "" } }),
    "Remotion isn't working (its check failed): counter, list, comparison, quote and step graphics will be made with HyperFrames or as keyword cards");
  const long = fancyToolNote({ ...all, hyperframes: { ok: false, detail: "x".repeat(300) } })!;
  assert.match(long, /^HyperFrames isn't working \(x{119}…\): moving-word/);
});

type Answer = { ok: boolean; detail: string; missing?: boolean } | "hang";
/** A production worker whose tools answer health() as given, counting the checks. */
function toolsProducer(answers: { remotion: Answer; hyperframes: Answer; blender: Answer }) {
  const checks = { n: 0 };
  const tool = (key: keyof typeof answers) => ({
    health: () => { checks.n++; const a = answers[key]; return a === "hang" ? new Promise(() => {}) : Promise.resolve(a); },
  });
  return { checks, answers, producer: { adapters: { remotion: tool("remotion"), hyperframes: tool("hyperframes"), blender: tool("blender") } } };
}
const OK = { ok: true, detail: "" };

test("a tool that's there but fails its check isn't working, with why", async () => {
  const { producer } = toolsProducer({ remotion: { ok: false, detail: "exited 1: Cannot find module 'react'" }, hyperframes: OK, blender: OK });
  const { app } = server(producer);
  const fancy = (await app.inject("/api/styles")).json().styles.find((s: any) => s.id === "fancy");
  assert.equal(fancy.toolNote, "Remotion isn't working (exited 1: Cannot find module 'react'): counter, list, comparison, quote and step graphics will be made with HyperFrames or as keyword cards");
});

test("a hung health check counts as not working after the timeout", async () => {
  const saved = fancyHealthCheck.timeoutMs;
  fancyHealthCheck.timeoutMs = 50;
  try {
    const { producer } = toolsProducer({ remotion: OK, hyperframes: OK, blender: "hang" });
    const { app } = server(producer);
    const fancy = (await app.inject("/api/styles")).json().styles.find((s: any) => s.id === "fancy");
    assert.equal(fancy.toolNote, "Blender isn't working (its check took longer than 0.05 s): 3D graphics will be made with HyperFrames or as keyword cards");
  } finally {
    fancyHealthCheck.timeoutMs = saved;
  }
});

test("setting Blender's path checks the tools again", async () => {
  const { checks, answers, producer } = toolsProducer({ remotion: OK, hyperframes: OK, blender: { ok: false, detail: "Blender wasn't found", missing: true } });
  const { app } = server(producer);
  const note = async () => (await app.inject("/api/styles")).json().styles.find((s: any) => s.id === "fancy").toolNote;
  assert.match(await note(), /Blender isn't installed/);
  answers.blender = OK;
  const put = (values: Record<string, string>) => app.inject({ method: "PUT", url: "/api/settings", headers: { host: `localhost:${config.port}` }, payload: { values } });
  try {
    assert.equal((await put({ BLENDER_PATH: "C:\\Blender\\blender.exe" })).statusCode, 200);
    assert.equal(await note(), null);
    assert.equal(checks.n, 6);
  } finally {
    await put({ BLENDER_PATH: "" });
  }
});

test("the Editing Styles list says which Fancy graphics will fall back", async () => {
  const { checks, producer } = toolsProducer({ remotion: OK, hyperframes: OK, blender: { ok: false, detail: "Blender wasn't found", missing: true } });
  const { app } = server(producer);
  const res = await app.inject("/api/styles");
  assert.equal(res.statusCode, 200);
  const { styles } = res.json();
  assert.deepEqual(styles.map((s: any) => s.id), ["basic", "fancy"]);
  const fancy = styles.find((s: any) => s.id === "fancy");
  assert.equal(fancy.toolNote, "Blender isn't installed: 3D graphics will be made with HyperFrames or as keyword cards");
  assert.equal(fancy.name, "Fancy");
  assert.match(fancy.thumbnailUrl, /\/api\/styles\/fancy\/thumbnail/);
  assert.equal("toolNote" in styles.find((s: any) => s.id === "basic"), false, "only Fancy gets a note");
  // checked once, then answered from the cache
  const first = checks.n;
  assert.equal(first, 3);
  await app.inject("/api/styles");
  assert.equal(checks.n, first);
  // /api/status doesn't wait on the tools
  await app.inject("/api/status");
  assert.equal(checks.n, first);
});

test("when every graphics tool is healthy, Fancy has no tool note", async () => {
  const { producer } = toolsProducer({ remotion: OK, hyperframes: OK, blender: OK });
  const { app } = server(producer);
  const fancy = (await app.inject("/api/styles")).json().styles.find((s: any) => s.id === "fancy");
  assert.equal(fancy.toolNote, null);
});
