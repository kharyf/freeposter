// The Lemo-Opuscar film styles, read straight from the library installed on this computer (no agent needed).
// Each style is a folder under styles/ with a style.json; they become the "lemo:<slug>" looks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "../db.ts";
import { syncLooks } from "./looks.ts";

export interface LemoStyle { key: string; name: string; description: string; category: string | null; needsImageGen: boolean }

const DESCRIPTION_MAX = 500, NAME_MAX = 80;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** $LEMO_OPUSCAR_HOME, else ~/lemo-opuscar. */
export function lemoLibraryDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.LEMO_OPUSCAR_HOME?.trim() || join(home, "lemo-opuscar");
}

const readText = (path: string): string | null => {
  try { return readFileSync(path, "utf8").trim(); } catch { return null; }
};

/** The checked-out commit, read from .git without running git: HEAD, then its ref file or packed-refs. */
function gitCommit(dir: string): string | null {
  const head = readText(join(dir, ".git", "HEAD"));
  if (!head) return null;
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1].trim();
  let sha: string | null = head;
  if (ref) {
    sha = readText(join(dir, ".git", ref));
    if (!sha) {
      const packed = readText(join(dir, ".git", "packed-refs"));
      sha = packed?.split(/\r?\n/).map((l) => l.trim().split(" ")).find((p) => p[1] === ref)?.[0] ?? null;
    }
  }
  return sha && /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : null;
}

function libraryVersion(dir: string): string {
  const raw = readText(join(dir, "package.json"));
  let version: unknown;
  try { version = raw ? JSON.parse(raw).version : undefined; } catch { /* an unreadable package.json counts as none */ }
  if (typeof version !== "string" || !version) return "unknown";
  const commit = gitCommit(dir);
  return commit ? `${version}+${commit}` : version;
}

/** Every readable style in the library, or null when there is no styles/ folder. */
export function readLemoLibrary(dir: string): { version: string; styles: LemoStyle[] } | null {
  const stylesDir = join(dir, "styles");
  if (!existsSync(stylesDir)) return null;
  let names: string[];
  try { names = readdirSync(stylesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return null; }
  const styles: LemoStyle[] = [];
  for (const name of names) {
    if (name === "_template") continue;
    const raw = readText(join(stylesDir, name, "style.json"));
    if (!raw) continue;
    let j: Record<string, unknown>;
    try { j = JSON.parse(raw); } catch { continue; }
    if (!j || typeof j !== "object" || typeof j.slug !== "string" || !SLUG.test(j.slug)) continue;
    const title = typeof j.en === "string" && j.en.trim() ? j.en.trim() : j.slug;
    styles.push({
      key: `lemo:${j.slug}`,
      name: title.slice(0, NAME_MAX),
      description: typeof j.line === "string" ? j.line.slice(0, DESCRIPTION_MAX) : "",
      category: typeof j.category_en === "string" && j.category_en.trim() ? j.category_en.trim() : null,
      needsImageGen: Array.isArray(j.needs) && j.needs.includes("image-generation"),
    });
  }
  return { version: libraryVersion(dir), styles };
}

let installed = false;
let syncedAt = 0;
/** Whether the library was found at the last sync. */
export const lemoIsInstalled = (): boolean => installed;
/** When the last sync ran (0 = never), so callers can sync again only when it is stale. */
export const lemoSyncedAt = (): number => syncedAt;

/** Brings the looks catalogue in line with the library. With no library found nothing changes (the catalogue is kept). */
export function syncLemoLibrary(store: Store, dir: string = lemoLibraryDir()): { installed: boolean; added: number; updated: number; hidden: number } {
  const lib = readLemoLibrary(dir);
  syncedAt = Date.now();
  installed = lib !== null;
  if (!lib) return { installed: false, added: 0, updated: 0, hidden: 0 };
  const r = syncLooks(store, "lemo-opuscar", lib.styles.map((s) => ({ ...s, libraryVersion: lib.version })));
  return { installed: true, ...r };
}
