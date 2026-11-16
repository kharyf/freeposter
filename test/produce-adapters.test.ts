import "./isolated-home.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDir } from "../src/config.ts";
import { hyperframesCommand, remotionCommand } from "../src/produce/tools.ts";
import { before, test } from "node:test";
import { blenderAdapter, blenderTemplates } from "../src/produce/adapters/blender.ts";
import { fileAdapter } from "../src/produce/adapters/file.ts";
import { hyperframesAdapter, HYPERFRAMES_ARGS } from "../src/produce/adapters/hyperframes.ts";
import { REMOTION_ARGS, remotionAdapter, remotionEntry } from "../src/produce/adapters/remotion.ts";
import { Fatal, Retryable, type RenderContext } from "../src/produce/adapters/index.ts";
import { wanAdapter, wanFrames } from "../src/produce/adapters/wan.ts";
import { probe } from "../src/media.ts";
import type { BlenderShot, HyperframesShot, RemotionShot, WanShot } from "../src/produce/spec.ts";
import { makeVideo, tmp } from "./helpers.ts";

const FAKE = resolve(import.meta.dirname, "fixtures", "fake-tool.mjs");
const fake = (tool: string) => ({ bin: process.execPath, args: [FAKE, tool] });
const ctx = (dir = tmp(), signal = new AbortController().signal): RenderContext => ({ dir, signal, onProgress: () => {} });

function withEnv(vars: Record<string, string>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); };
}

const html = `<html><body><div data-composition-id="main" data-width="1080" data-height="1920" data-duration="2"></div></body></html>`;
const hfShot: HyperframesShot = { id: "intro", kind: "hyperframes", duration_sec: 2, html, assets: [] };
const wanShot: WanShot = { id: "hero", kind: "wan", duration_sec: 2.5, prompt: "a phone on a desk", negative_prompt: "text", image: null, seed: 42 };

let clip: string;
before(() => { clip = makeVideo(tmp(), "clip.mp4", ["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p"]); });

test("hyperframes writes the composition and renders it with the pinned arguments", async () => {
  const log = join(tmp(), "log.jsonl");
  const restore = withEnv({ FAKE_LOG: log });
  try {
    const c = ctx();
    const out = await hyperframesAdapter({ command: () => fake("hyperframes") }).render(hfShot, c);
    assert.ok(existsSync(out.path));
    assert.equal(readFileSync(join(c.dir, "index.html"), "utf8"), html);
    const { args } = JSON.parse(readFileSync(log, "utf8").trim());
    assert.deepEqual(args, ["render", c.dir, "--output", out.path, ...HYPERFRAMES_ARGS]);
    assert.deepEqual(HYPERFRAMES_ARGS, ["--fps", "30", "--resolution", "portrait", "--quality", "looks", "--strict", "--no-wait", "--json"]);
  } finally { restore(); }
});

test("hyperframes puts each asset beside the page under the name the HTML uses, not its stored hash name", async () => {
  const stored = join(tmp(), "3b9e0c.png");
  writeFileSync(stored, "png");
  const c = ctx();
  await hyperframesAdapter({ command: () => fake("hyperframes") }).render({ ...hfShot, assets: [{ name: "logo.png", path: stored }] }, c);
  assert.equal(readFileSync(join(c.dir, "logo.png"), "utf8"), "png");
  assert.equal(existsSync(join(c.dir, "3b9e0c.png")), false);
});

test("a failing tool is Fatal and carries the tail of its output", async () => {
  const restore = withEnv({ FAKE_MODE: "fail" });
  try {
    await assert.rejects(hyperframesAdapter({ command: () => fake("hyperframes") }).render(hfShot, ctx()), (err: Error) => err instanceof Fatal && /something went wrong/.test(err.message));
  } finally { restore(); }
});

test("hyperframes that exits 0 silently is neither healthy nor a successful render", async () => {
  const restore = withEnv({ FAKE_MODE: "silent" });
  try {
    const a = hyperframesAdapter({ command: () => fake("hyperframes") });
    assert.equal((await a.health()).ok, false);
    await assert.rejects(a.render(hfShot, ctx()), (err: Error) => err instanceof Fatal && /without writing shot\.mp4/.test(err.message));
  } finally { restore(); }
});

test("the pinned hyperframes runs our own executable in node mode (FreePoster.exe in the desktop app)", () => {
  const script = join(dataDir, "tools", "hyperframes", "node_modules", "hyperframes", "bin", "hyperframes.mjs");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "");
  try {
    const cmd = hyperframesCommand();
    assert.equal(cmd?.bin, process.execPath);
    assert.deepEqual(cmd?.args, [script]);
    assert.equal(cmd?.env?.ELECTRON_RUN_AS_NODE, "1");
  } finally { rmSync(join(dataDir, "tools", "hyperframes"), { recursive: true, force: true }); }
});

test("hyperframes is unavailable until installed", async () => {
  const h = await hyperframesAdapter({ command: () => null }).health();
  assert.equal(h.ok, false);
  await assert.rejects(hyperframesAdapter({ command: () => null }).render(hfShot, ctx()), Retryable);
});

const tsx = `import { AbsoluteFill } from "remotion";\nexport default function Shot({ title }: { title: string }) { return <AbsoluteFill>{title}</AbsoluteFill>; }\n`;
const remotionShot = (assets: RemotionShot["assets"] = []): RemotionShot => ({ id: "card", kind: "remotion", duration_sec: 2, tsx, props: { title: "Hi" }, assets });

test("remotion renders the component inside the install as a 1080x1920 30 fps composition, then cleans up", async () => {
  const root = tmp();
  const log = join(tmp(), "log.jsonl");
  const logo = join(tmp(), "logo.png");
  writeFileSync(logo, "png");
  const restore = withEnv({ FAKE_LOG: log });
  try {
    const c = ctx();
    const progress: number[] = [];
    const out = await remotionAdapter({ command: () => fake("remotion"), root: () => root }).render(remotionShot([{ name: "logo.png", path: logo }]), { ...c, onProgress: (f) => progress.push(f) });
    assert.ok(existsSync(out.path));
    assert.equal(out.durationSec, 2);
    const [call, seen] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const entry = call.args[1];
    assert.equal(call.args[0], "render");
    assert.ok(entry.startsWith(join(root, "work")), "the project sits inside the install, so its imports resolve there");
    assert.deepEqual(call.args.slice(2, 4), ["Shot", out.path]);
    assert.deepEqual(call.args.slice(-REMOTION_ARGS.length), REMOTION_ARGS);
    assert.deepEqual(seen.project, ["Shot.tsx", "index.tsx", "props.json", "public"]);
    assert.deepEqual(seen.public, ["logo.png"], "assets keep their names for staticFile()");
    assert.deepEqual(seen.props, { title: "Hi" });
    assert.match(seen.entry, /width=\{1080\} height=\{1920\} fps=\{30\} durationInFrames=\{60\}/);
    assert.deepEqual(progress, [0.45]);
    assert.equal(readFileSync(join(c.dir, "Shot.tsx"), "utf8"), tsx, "kept beside the clip");
    assert.deepEqual(readdirSync(join(root, "work")), [], "the project is removed afterwards");
  } finally { restore(); }
});

test("remotion frame counts follow the shot's length", () => {
  assert.match(remotionEntry(2.5), /durationInFrames=\{75\}/);
  assert.match(remotionEntry(0.5), /durationInFrames=\{15\}/);
});

test("remotion that fails or exits silently is Fatal, and is unavailable until installed", async () => {
  for (const [mode, pattern] of [["fail", /something went wrong/], ["silent", /without writing shot\.mp4/]] as const) {
    const restore = withEnv({ FAKE_MODE: mode });
    try {
      const a = remotionAdapter({ command: () => fake("remotion"), root: () => tmp() });
      await assert.rejects(a.render(remotionShot(), ctx()), (err: Error) => err instanceof Fatal && pattern.test(err.message));
      assert.equal((await a.health()).ok, false);
    } finally { restore(); }
  }
  const missing = remotionAdapter({ command: () => null });
  assert.match((await missing.health()).detail, /isn't installed yet/);
  await assert.rejects(missing.render(remotionShot(), ctx()), Retryable);
});

test("remotion is healthy when the pinned version answers", async () => {
  const h = await remotionAdapter({ command: () => fake("remotion"), root: () => tmp() }).health();
  assert.deepEqual(h, { ok: true, detail: "Remotion 4.0.538" });
});

test("the pinned remotion runs our own executable in node mode", () => {
  const script = join(dataDir, "tools", "remotion", "node_modules", "@remotion", "cli", "remotion-cli.js");
  assert.equal(remotionCommand(), null);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "");
  try {
    const cmd = remotionCommand();
    assert.equal(cmd?.bin, process.execPath);
    assert.deepEqual(cmd?.args, [script]);
    assert.equal(cmd?.env?.ELECTRON_RUN_AS_NODE, "1");
  } finally { rmSync(join(dataDir, "tools", "remotion"), { recursive: true, force: true }); }
});

test("wan builds its settings from the user's own file and renders headless", async () => {
  const wanDir = tmp();
  mkdirSync(join(wanDir, "settings"));
  writeFileSync(join(wanDir, "settings", "ltx2_test_settings.json"), JSON.stringify({ prompt: "old", num_inference_steps: 8, resolution: "1280x704", video_length: 241, seed: -1 }));
  const log = join(tmp(), "log.jsonl");
  const restore = withEnv({ FAKE_LOG: log });
  try {
    const c = ctx();
    const out = await wanAdapter({ dir: () => wanDir, model: () => "ltx2_test", command: (args) => ({ bin: process.execPath, args: [FAKE, "wan", ...args] }) }).render(wanShot, c);
    assert.ok(existsSync(out.path));
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).args);
    assert.ok(calls[0].includes("--dry-run"), "validated first");
    const settings = JSON.parse(readFileSync(calls[1][calls[1].indexOf("--process") + 1], "utf8"));
    assert.equal(settings.model_type, "ltx2_test");
    assert.equal(settings.prompt, "a phone on a desk");
    assert.equal(settings.negative_prompt, "text");
    assert.equal(settings.seed, 42);
    assert.equal(settings.resolution, "704x1280");
    assert.equal(settings.video_length, wanFrames(2.5));
    assert.equal(settings.num_inference_steps, 8, "the user's own tuning is kept");
    assert.equal(out.durationSec, 2.5, "trimmed to the shot's length");
  } finally { restore(); }
});

test("wan frame counts round up to the model's 8-frame step", () => {
  assert.equal(wanFrames(2.5), 65);
  assert.equal(wanFrames(5), 129);
  assert.equal((wanFrames(1) - 1) % 8, 0);
});

test("wan out of memory is Retryable", async () => {
  const wanDir = tmp();
  const restore = withEnv({ FAKE_MODE: "oom" });
  try {
    await assert.rejects(
      wanAdapter({ dir: () => wanDir, model: () => "m", command: (args) => ({ bin: process.execPath, args: [FAKE, "wan", ...args] }) }).render(wanShot, ctx()),
      (err: Error) => err instanceof Retryable && /out of memory/i.test(err.message),
    );
  } finally { restore(); }
});

test("cancelling kills the tool", async () => {
  const restore = withEnv({ FAKE_MODE: "hang" });
  try {
    const ac = new AbortController();
    const started = Date.now();
    const p = hyperframesAdapter({ command: () => fake("hyperframes") }).render(hfShot, ctx(tmp(), ac.signal));
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(p, /cancelled/);
    assert.ok(Date.now() - started < 10_000);
  } finally { restore(); }
});

test("blender renders a template's frames and encodes them at 30 fps", async () => {
  const templates = blenderTemplates();
  assert.ok(templates["title-card"], "starter templates ship with FreePoster");
  assert.ok(templates["logo-spin"]);
  const shot: BlenderShot = { id: "logo", kind: "blender", duration_sec: 1.5, template: "logo-spin", params: { text: "Hi", color: "#ff5a36" }, engine: "eevee" };
  const out = await blenderAdapter({ command: (args) => ({ bin: process.execPath, args: [FAKE, "blender", ...args] }) }).render(shot, ctx());
  const p = await probe(out.path);
  assert.equal(p.width, 1080);
  assert.equal(p.height, 1920);
  assert.ok(Math.abs(p.durationSec - 1.5) < 0.1, `got ${p.durationSec}`);
});

test("file shots are trimmed", async () => {
  const out = await fileAdapter().render({ id: "b", kind: "file", path: clip, trim: [1, 2.5] }, ctx());
  assert.ok(Math.abs((await probe(out.path)).durationSec - 1.5) < 0.1);
  const whole = await fileAdapter().render({ id: "b", kind: "file", path: clip, trim: null }, ctx());
  assert.equal(whole.path, clip);
});

const real = process.env.FREEPOSTER_REAL_TOOLS === "1";

test("real HyperFrames renders a 2 s portrait clip", { skip: !real }, async () => {
  const a = hyperframesAdapter();
  if (!(await a.health()).ok) await (await import("../src/produce/tools.ts")).installHyperframes();
  const full = `<!doctype html><html><head><meta charset="UTF-8"><script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
<style>html,body{margin:0;width:1080px;height:1920px;overflow:hidden;background:#000}#root{width:100%;height:100%;display:flex;align-items:center;justify-content:center}h1{color:#fff;font:600 72px sans-serif}</style></head>
<body><div id="root" data-composition-id="main" data-start="0" data-duration="2" data-width="1080" data-height="1920">
<h1 id="title" class="clip" data-start="0" data-duration="2" data-track-index="0">FreePoster</h1></div>
<script>const tl = gsap.timeline({ paused: true }); tl.fromTo("#title", { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0); window.__timelines["main"] = tl; tl.seek(0);</script></body></html>`;
  const out = await a.render({ ...hfShot, html: full }, ctx());
  const p = await probe(out.path);
  assert.equal(`${p.width}x${p.height}`, "1080x1920");
  assert.ok(Math.abs(p.durationSec - 2) < 0.1);
});

test("real Blender renders the logo-spin template", { skip: !real, timeout: 600_000 }, async () => {
  const shot: BlenderShot = { id: "logo", kind: "blender", duration_sec: 1, template: "logo-spin", params: { text: "FreePoster", color: "#ff5a36" }, engine: "eevee" };
  const out = await blenderAdapter().render(shot, ctx());
  const p = await probe(out.path);
  assert.equal(`${p.width}x${p.height}`, "1080x1920");
});

test("real Remotion installs and renders a 2 s portrait clip", { skip: !real, timeout: 20 * 60_000 }, async () => {
  const a = remotionAdapter();
  if (!(await a.health()).ok) await (await import("../src/produce/tools.ts")).installRemotion();
  assert.equal((await a.health()).ok, true);
  const animated = `import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
export default function Shot({ title }: { title: string }) {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: "#000", color: "#fff", fontSize: 96, justifyContent: "center", alignItems: "center", opacity: interpolate(f, [0, 15], [0, 1]) }}>{title}</AbsoluteFill>;
}
`;
  const out = await a.render({ ...remotionShot(), tsx: animated }, ctx());
  const p = await probe(out.path);
  assert.equal(`${p.width}x${p.height}`, "1080x1920");
  assert.ok(Math.abs(p.durationSec - 2) < 0.1);
});
