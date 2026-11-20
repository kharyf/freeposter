// Regenerates src/campaigns/tlds.ts from IANA's root-zone list. Run: node scripts/update-tlds.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "https://data.iana.org/TLD/tlds-alpha-by-domain.txt";
const out = join(import.meta.dirname, "..", "src", "campaigns", "tlds.ts");

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE} answered ${res.status}`);
const tlds = (await res.text()).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => line.toLowerCase());

const header = `// The IANA root-zone TLDs (${SOURCE}, snapshot ${new Date().toISOString().slice(0, 10)}),
// lowercased. A spelled-out " dot " is read as a dot only before one of these, so ordinary speech
// ("a polka dot dress") is not mistaken for a link. Regenerate with scripts/update-tlds.ts.
`;
writeFileSync(out, `${header}export const TLDS: ReadonlySet<string> = new Set(\`\n${tlds.join("\n")}\n\`.trim().split(/\\s+/));\n`);
console.log(`wrote ${tlds.length} TLDs to ${out}`);
