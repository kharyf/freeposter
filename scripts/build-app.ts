// Builds the desktop app.
//   node scripts/build-app.ts            → build/app, run with `electron build/app` (npm run desktop)
//   node scripts/build-app.ts --package  → dist/FreePoster-win32-x64/FreePoster.exe (npm run build:app)
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  external: ["electron"],
  // config.ts falls back to __dirname when import.meta is empty, as it is in this bundle.
  logOverride: { "empty-import-meta": "silent" },
});
copyFileSync(join(root, "public", "index.html"), join(out, "public", "index.html"));
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
    asar: true,
    overwrite: true,
    win32metadata: { ProductName: "FreePoster", FileDescription: "FreePoster", CompanyName: "FreePoster" },
  });
  console.log(`packaged ${join(dir, "FreePoster.exe")}`);
}
