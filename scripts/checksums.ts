// Writes dist/SHA256SUMS.txt for the installer(s) in dist/, in the `sha256sum` format ("<hash>  <file>"),
// so a download can be checked with Get-FileHash on Windows or `sha256sum -c SHA256SUMS.txt` elsewhere.
//   node scripts/checksums.ts   (npm run checksums), after npm run build:app
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const dist = resolve(import.meta.dirname, "..", "dist");
const files = readdirSync(dist).filter((name) => /^FreePoster-Setup-.+\.exe$/.test(name)).sort();
if (files.length === 0) throw new Error(`no FreePoster-Setup-*.exe in ${dist}; run npm run build:app first`);

const lines: string[] = [];
for (const name of files) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(join(dist, name)), hash);
  lines.push(`${hash.digest("hex")}  ${name}`);
}
writeFileSync(join(dist, "SHA256SUMS.txt"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
