import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imported before anything that loads config.ts, so tests never read or write the real .env and data/.
process.env.FREEPOSTER_HOME = mkdtempSync(join(tmpdir(), "freeposter-home-"));
// The app looks for the Lemo-Opuscar library here, never in the real home folder, so a library installed on this
// machine cannot change what a test sees. Tests that want one point this at a fixture.
process.env.LEMO_OPUSCAR_HOME = join(process.env.FREEPOSTER_HOME, "no-lemo-opuscar");
