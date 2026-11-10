// Editing styles: named, ready-made edits a Drive filename can ask for (its {editing-style} part). They're defined
// here, not by the user: the Editing Styles tab shows them and lets the user pick the default, nothing more.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { DEFAULT_EDIT, type EditSettings } from "./settings.ts";

export interface EditingStyle {
  id: string;
  /** shown on the tab, and (as is: no spaces) written in a filename */
  name: string;
  description: string;
  settings: EditSettings;
}

export const STYLES: readonly EditingStyle[] = [
  {
    id: "basic",
    name: "Basic",
    description:
      "Tightens the pauses and stumbles, adds word-by-word captions, reframes to vertical around the speaker, cleans up the sound, and adds gentle punch-in zooms.",
    settings: DEFAULT_EDIT,
  },
];

const DEFAULT_STYLE_PREF = "edit.defaultStyle";

export const styleById = (id: string | null | undefined) => STYLES.find((s) => s.id === id);

/** The default style: the one chosen, or the first when none is (or the chosen one no longer exists). */
export function defaultStyleId(store: Store): string {
  const saved = store.pref<string>(DEFAULT_STYLE_PREF);
  return styleById(saved)?.id ?? STYLES[0].id;
}

/** False when there's no such style. */
export function setDefaultStyle(store: Store, id: string): boolean {
  if (!styleById(id)) return false;
  store.setPref(DEFAULT_STYLE_PREF, id);
  return true;
}

/** The word a filename uses for a style. */
export const styleToken = (s: EditingStyle) => s.name.replace(/\s+/g, "");

/** Where a style's sample video is kept, when it has one. */
export const sampleVideoPath = (id: string) => join(dataDir, "styles", `${id}.mp4`);
export const hasSample = (id: string) => existsSync(sampleVideoPath(id));
