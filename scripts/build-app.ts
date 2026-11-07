// Builds the desktop app.
//   node scripts/build-app.ts            → build/app, run with `electron build/app` (npm run desktop)
//   node scripts/build-app.ts --package  → dist/FreePoster-Setup-<version>.exe, the Windows installer (npm run build:app)
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { iconIco, iconPng } from "./icon.ts";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "build", "app");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Windows' Application User Model ID for the installed shortcuts; src/desktop.ts sets the same one at runtime.
const APP_ID = "com.freeposter.app";

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
// Blender templates productions render from (src/produce/adapters/blender.ts reads them beside the bundle).
cpSync(join(root, "templates"), join(out, "templates"), { recursive: true, filter: (src) => !src.includes("__pycache__") });
// The freeposter CLI: one dependency-free file that runs on Node 24+, plus a Windows wrapper to put on PATH.
await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile: join(out, "cli", "freeposter-cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});
writeFileSync(join(out, "cli", "freeposter.cmd"), '@node "%~dp0freeposter-cli.mjs" %*\r\n');
// The templates each user's redirect page is made from (setup's first step); not the maintainer's TikTok files.
mkdirSync(join(out, "redirect-page"));
for (const name of ["index.html", "forward.js", "terms.html", "privacy.html", "_headers"]) {
  copyFileSync(join(root, "redirect-page", name), join(out, "redirect-page", name));
}
// Only the Windows x64 binaries: the package carries every platform's (~300 MB).
const ort = join(root, "node_modules", "onnxruntime-node");
const ortOut = join(out, "node_modules", "onnxruntime-node");
for (const part of ["dist", join("bin", "napi-v6", "win32", "x64")]) cpSync(join(ort, part), join(ortOut, part), { recursive: true });
// Its other dependencies (adm-zip, global-agent) only serve its install script, which the app never runs:
// list just onnxruntime-common, so the installer's dependency scan doesn't look for them.
const ortPkg = JSON.parse(readFileSync(join(ort, "package.json"), "utf8"));
writeFileSync(join(ortOut, "package.json"), JSON.stringify({ ...ortPkg, scripts: {}, dependencies: { "onnxruntime-common": ortPkg.dependencies["onnxruntime-common"] } }, null, 2));
cpSync(join(root, "node_modules", "onnxruntime-common"), join(out, "node_modules", "onnxruntime-common"), { recursive: true });
writeFileSync(join(out, "icon.png"), iconPng());
writeFileSync(join(root, "build", "icon.ico"), iconIco());
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "freeposter",
  productName: "FreePoster",
  version: pkg.version,
  description: pkg.description,
  author: "FreePoster contributors",
  main: "main.cjs",
  // The installer ships only declared dependencies; everything else is bundled into main.cjs.
  dependencies: { "onnxruntime-node": ortPkg.version, "onnxruntime-common": ortPkg.dependencies["onnxruntime-common"] },
}, null, 2));
console.log(`built ${out}`);

if (process.argv.includes("--package")) {
  const { build: builder, Platform, Arch } = await import("electron-builder");
  const files = await builder({
    projectDir: out,
    targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
    // electron-builder would publish by itself on a CI tag build; .github/workflows/release.yml does that instead.
    publish: "never",
    config: {
      appId: APP_ID,
      productName: "FreePoster",
      copyright: `Copyright © ${new Date().getFullYear()} FreePoster contributors`,
      electronVersion: JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8")).version,
      directories: { output: join(root, "dist") },
      // build/app is already complete (bundle, public/, the onnxruntime files): ship it as is.
      files: ["**/*"],
      npmRebuild: false,
      // native DLLs can't load from inside an asar, and Blender and the CLI's users read templates/ and cli/ as plain files
      asarUnpack: ["node_modules/onnxruntime-node/**", "templates/**", "cli/**"],
      win: { icon: join(root, "build", "icon.ico"), executableName: "FreePoster" },
      nsis: {
        artifactName: "FreePoster-Setup-${version}.${ext}",
        // A per-user install: no admin prompt. Settings in %APPDATA%\FreePoster survive uninstalling.
        oneClick: true,
        perMachine: false,
        deleteAppDataOnUninstall: false,
        installerIcon: join(root, "build", "icon.ico"),
        uninstallerIcon: join(root, "build", "icon.ico"),
      },
    },
  });
  console.log(`packaged\n  ${files.join("\n  ")}`);
}
