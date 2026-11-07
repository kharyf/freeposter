// The sound-effects library: audio files in data/sfx (subfolders allowed), named by their path without the
// extension ("hits/boom"). Productions place them with sfx cues; the edit pipeline can use the same names later.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { dataDir } from "../config.ts";

const AUDIO = /\.(wav|mp3|ogg)$/i;

export const sfxDir = () => join(dataDir, "sfx");

export function sfxLibrary(dir = sfxDir()): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const walk = (d: string) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (AUDIO.test(e.name)) out.push({ name: relative(dir, p).replace(/\\/g, "/").replace(AUDIO, ""), path: p });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The file for a library name, or "" when there is none. */
export const sfxPath = (name: string, dir = sfxDir()) => sfxLibrary(dir).find((s) => s.name === name)?.path ?? "";
