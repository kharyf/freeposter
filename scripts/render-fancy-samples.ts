// Dev only: renders every Fancy graphic template once with its example params through the real tools, into
// data/fancy-samples/<id>.mp4, then a contact sheet of a late frame from each (sheet.jpg) and of an early one
// (sheet-in.jpg), to look at the family side by side. --long renders the longest params each template takes instead
// (<id>-long.mp4, sheet-long.jpg), to check nothing is clipped.
//   node scripts/render-fancy-samples.ts [--long] [template id ...]
// The tools come from FreePoster's settings and data folder, as in the app (FREEPOSTER_HOME picks another one).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { blenderAdapter } from "../src/produce/adapters/blender.ts";
import { hyperframesAdapter } from "../src/produce/adapters/hyperframes.ts";
import { remotionAdapter } from "../src/produce/adapters/remotion.ts";
import type { ShotAdapter } from "../src/produce/adapters/index.ts";
import { renderKeywordCard } from "../src/edit/fancy/keyword-card.ts";
import { fancyFontFile } from "../src/edit/fancy/palette.ts";
import { checkParams, fancyTemplates, toShot } from "../src/edit/fancy/templates.ts";
import { filterPath } from "../src/edit/transcribe.ts";
import { probe } from "../src/media.ts";

const out = resolve(import.meta.dirname, "..", "data", "fancy-samples");
mkdirSync(out, { recursive: true });
const templates = fancyTemplates();
const long = process.argv.includes("--long");
const wanted = process.argv.slice(2).filter((a) => a !== "--long");
/** The most each template's checks allow, roughly: what must still fit inside the frame. */
const LONGEST: Record<string, Record<string, string | number | boolean>> = {
  "stat-counter": { value: 999999999, prefix: "$", suffix: "k", label: "a month, every month, for the next year!" },
  "build-list": { items: "Write it|Film it once|Cut it|Post it now" },
  compare: { left_title: "What the agency quoted for the full job", left: "Four weeks of edits and revision rounds", right_title: "What it took with a phone and FreePoster", right: "One afternoon" },
  "pull-quote": { quote: "Nobody remembers the first draft of anything. They remember the one you shipped" },
  steps: { steps: "Plan the hook|Film one take|Cut it|Post" },
  "kinetic-words": { words: "Extraordinary results compound daily" },
  "icon-callout": { icon: "👩🏽‍💻", label: "Working from anywhere with a laptop now" },
  "gold-3d-word": { word: "Unforgettable!" },
  "gold-3d-object": { object: "bars", label: "Revenue up every single month this year" },
  "keyword-card": { phrase: "The one thing nobody tells you about it" },
};
const ids = Object.keys(templates).filter((id) => !wanted.length || wanted.includes(id));
const adapters: Record<string, ShotAdapter<any>> = { remotion: remotionAdapter(), hyperframes: hyperframesAdapter(), blender: blenderAdapter() };

for (const id of ids) {
  const t = templates[id];
  const sec = Math.min(t.maxSec, Math.max(t.minSec, 3));
  const params = long ? LONGEST[id] : t.example;
  const clip = join(out, `${id}${long ? "-long" : ""}.mp4`);
  const started = Date.now();
  const { problems } = checkParams(t, params);
  if (problems.length) console.warn(`${id}: the sample params don't pass the checks: ${problems.join("; ")}`);
  try {
    if (t.tool === "builtin") {
      await renderKeywordCard(String(params.phrase), sec, clip);
    } else {
      const dir = join(out, "work", id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const r = await adapters[t.tool].render(toShot(t, params, sec, id), { dir, signal: new AbortController().signal, onProgress: () => {} });
      copyFileSync(r.path, clip);
    }
    const p = await probe(clip);
    console.log(`${id}: ${p.width}x${p.height}, ${p.durationSec.toFixed(2)} s, ${p.fps} fps (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  } catch (err) {
    console.error(`${id}: FAILED: ${(err as Error).message}`);
  }
}

/** One tile per sample at `at` (a fraction of its length), labelled with its id underneath, four across. */
function sheet(name: string, at: number) {
  const frames = join(out, "frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);
  let n = 0;
  for (const id of Object.keys(templates)) {
    const clip = join(out, `${id}${long ? "-long" : ""}.mp4`);
    if (!existsSync(clip)) continue;
    try {
      const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip]).toString());
      const label = `drawtext=fontfile=${filterPath(fancyFontFile("italic"))}:text='${id}':x=12:y=h-36:fontsize=26:fontcolor=white`;
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(dur * at), "-i", clip, "-frames:v", "1", "-vf", `scale=540:480,pad=540:524:0:0:0x404040,${label}`, join(frames, `${String(++n).padStart(2, "0")}.png`)]);
    } catch {}
  }
  if (!n) return;
  const rows = Math.ceil(n / 4);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", join(frames, "%02d.png"), "-vf", `tile=4x${rows}:padding=8:margin=8:color=0x404040`, "-frames:v", "1", "-q:v", "3", join(out, name)]);
  rmSync(frames, { recursive: true, force: true });
  console.log(`contact sheet: ${join(out, name)}`);
}
if (long) sheet("sheet-long.jpg", 0.75);
else {
  sheet("sheet.jpg", 0.75);
  sheet("sheet-in.jpg", 0.1);
}
