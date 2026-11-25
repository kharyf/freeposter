// Making an edit from a request: picks the resources it uses (only the ones it names) and, for a slideshow
// with no video, stands in a small manifest file as its source so every edit still has a source and a key.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import type { Edit } from "../types.ts";
import { resolveResources, type ResourceRef } from "../resources/use.ts";
import type { ResourceStore } from "../resources/store.ts";
import { isSlideshow, type EditSettings, type ResourceUse } from "./settings.ts";

/** A slideshow made without a video has this stand-in for one; it's never uploaded or probed. */
export const isManifestSource = (path: string): boolean => path.endsWith(".slideshow.json");

export interface EditRequest {
  /** null only for a slideshow */
  source: { path: string; sha256: string } | null;
  /** already parsed, without setId or resources */
  settings: EditSettings;
  setId: number;
  refs: ResourceRef[];
  /** revising: the old edit's resources, kept as they were */
  keep?: ResourceUse[];
  parentEditId?: number | null;
}

export function createEditFor(store: Store, rs: ResourceStore, req: EditRequest): Edit | string {
  const settings: EditSettings = { ...req.settings };
  if (!req.source && !isSlideshow(settings)) return "only a slideshow can be made without a video";
  const uses = resolveResources(rs, store, req.setId, req.refs, settings.instructions, settings.look, req.keep ?? []);
  if (typeof uses === "string") return uses;
  settings.setId = req.setId;
  if (uses.length) settings.resources = uses;
  else delete settings.resources;

  let source = req.source;
  if (!source) {
    if (!settings.instructions && !uses.length) return "a slideshow without a video needs instructions or tagged resources";
    const body = JSON.stringify({ instructions: settings.instructions ?? "", resources: uses.map((u) => ({ id: u.id, tag: u.tag, sha256: u.sha256, as: u.as })) });
    const sha256 = createHash("sha256").update(body).digest("hex");
    const dir = join(dataDir, "edits", "sources");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sha256.slice(0, 16)}.slideshow.json`);
    writeFileSync(path, body);
    source = { path, sha256 };
  }
  return store.createEdit(source.path, source.sha256, settings, req.parentEditId ?? null);
}
