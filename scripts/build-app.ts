// Builds the desktop app.
//   node scripts/build-app.ts            → build/app, run with `electron build/app` (npm run desktop)
//   node scripts/build-app.ts --package  → dist/FreePoster-win32-x64/FreePoster.exe (npm run build:app)
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { iconIco, iconPng } from "./icon.ts";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "build", "app");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "public"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "desktop.ts")],
  outfile: join(out, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // onnxruntime-node (face detection for reframing) loads a native binding, so it ships beside the bundle.
  external: ["electron", "onnxruntime-node"],
  // config.ts falls back to __dirname when import.meta is empty, as it is in this bundle.
  logOverride: { "empty-import-meta": "silent" },
});
copyFileSync(join(root, "public", "index.html"), join(out, "public", "index.html"));
// The templates each user's redirect page is made from (setup's first step); not the maintainer's TikTok files.
mkdirSync(join(out, "redirect-page"));
for (const name of ["index.html", "forward.js", "terms.html", "privacy.html", "_headers"]) {
  copyFileSync(join(root, "redirect-page", name), join(out, "redirect-page", name));
}
// Only the Windows x64 binaries: the package carries every platform's (~300 MB).
const ort = join(root, "node_modules", "onnxruntime-node");
const ortOut = join(out, "node_modules", "onnxruntime-node");
for (const part of ["package.json", "dist", join("bin", "napi-v6", "win32", "x64")]) cpSync(join(ort, part), join(ortOut, part), { recursive: true });
cpSync(join(root, "node_modules", "onnxruntime-common"), join(out, "node_modules", "onnxruntime-common"), { recursive: true });
writeFileSync(join(out, "icon.png"), iconPng());
writeFileSync(join(root, "build", "icon.ico"), iconIco());
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "freeposter",
  productName: "FreePoster",
  version: pkg.version,
  description: pkg.description,
  main: "main.cjs",
}, null, 2));
console.log(`built ${out}`);

if (process.argv.includes("--package")) {
  const { packager } = await import("@electron/packager");
  const [dir] = await packager({
    dir: out,
    out: join(root, "dist"),
    name: "FreePoster",
    executableName: "FreePoster",
    platform: "win32",
    arch: "x64",
    electronVersion: JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8")).version,
    icon: join(root, "build", "icon.ico"),
    asar: { unpack: "**/node_modules/onnxruntime-node/**" }, // native DLLs can't load from inside an asar
    overwrite: true,
    win32metadata: { ProductName: "FreePoster", FileDescription: "FreePoster", CompanyName: "FreePoster" },
  });
  console.log(`packaged ${join(dir, "FreePoster.exe")}`);
}
