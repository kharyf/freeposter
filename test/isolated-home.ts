import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imported before anything that loads config.ts, so tests never read or write the real .env and data/.
process.env.FREEPOSTER_HOME = mkdtempSync(join(tmpdir(), "freeposter-home-"));
